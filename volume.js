// Volume-mode sniper: repeated buy-then-sell-back rounds against deco's own
// SimpleAMM pools on Arc / Robinhood / LitVM / Velana testnets. Testnet ONLY,
// burner wallet only, from the VM.
//
// One round = buy a fixed base amount of DECO, then sell back exactly the
// DECO received. Round sizes mirror 0xzunid's: Arc 0.1 USDC (ERC-20 view,
// 6 decimals), Robinhood 0.0001 ETH, LitVM 0.0001 zkLTC, Velana 0.0001 VELA.
//
// SAFETY / DESIGN DECISIONS:
// - DRY-RUN IS THE DEFAULT. Without --live the script prints the plan,
//   performs read-only checks where possible, sends NOTHING, and never
//   touches the keystore. --live alone enables live mode (this script does
//   NOT use the config.js LIVE.enabled gate that sniper.js has — per spec).
// - Hard testnet-only guard: chainIds {5042002, 46630, 4441, 484148} only;
//   the RPC's live chainId is verified before any signing or state-changing
//   work.
// - SEQUENTIAL ONLY. --inflight > 1 is REFUSED: pipelining was judged too
//   risky for a first version (nonce + balance-delta accounting across
//   overlapping rounds). Speed is secondary to correctness.
// - Approvals are MaxUint256, once per token per AMM (DECO for sells; the
//   Arc USDC view for buys). The AMM is deco's own deployed contract and
//   this is testnet-only, so one approval per token avoids a stream of
//   approval txs (gas is precious on Robinhood). Allowance is checked at
//   startup; approval only happens if it is short of the run's need.
// - Slippage 5% (500 bps) on both legs, under the on-chain getAmountOut
//   quote re-read fresh before each leg.
// - DECO received is measured by token balance delta (robust against any
//   pool-side rounding); base received on a sell is measured the same way
//   (native chains: delta + the sell tx's own gas cost, since gas is paid
//   in the same token).
// - Gas budget: --max-gas caps total native gas spend (defaults: Arc 10
//   USDC, Robinhood 0.005 ETH, LitVM 0.02 zkLTC). The run stops gracefully
//   before the next round if the projected cost would breach it.
// - Retries: a failed send/read is retried up to 3 times (1s/2s/4s
//   backoff). A round that still fails is logged and the run CONTINUES;
//   only guard/budget failures stop the whole run. A reverted tx (status 0)
//   is NOT retried — it is a failed round, logged as such.
// - Nonces are assigned explicitly in live mode (starting nonce fetched
//   once), so a retried send reuses the same nonce and can never
//   double-send.
// - A best-effort cleanup sell runs at the end: it sells ONLY the DECO this
//   run left behind (current balance minus the baseline captured at init),
//   capped at (failed rounds + 1) x buy size. The burner's 990,000 DECO
//   supply must NEVER be sold — the pre-fix code sold the whole balance
//   (2026-11-16 Arc incident, pool restored by buy-back).
// - Logs: one JSON line per tx in <log-dir>/<YYYY-MM-DD>-<chain>.jsonl
//   (date in Asia/Jakarta, deco's timezone), plus a summary JSON next to
//   it. NEVER any keys. No USD anywhere — native units only.
//
// Usage: node volume.js --help
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const { CHAINS, DECO, BURNER } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');

// Velana is NOT in config.js CHAINS (sniper.js/dryrun.js assume every CHAINS
// entry has a v2/v4 dex config), so volume.js carries its own Velana chain
// entry here and merges it for its own use. VOLUME_CHAINS is the chain table
// this script validates and runs against; the 3 original chains are
// untouched (same objects from config.js).
const VELANA_CHAIN = {
  name: 'Velana Testnet',
  chainId: 484148,
  rpc: 'https://velanachain.com/rpc',
  explorer: 'https://velanachain.com/explorer',
  gasToken: { symbol: 'VELA', decimals: 18, note: 'test VELA' },
};
const VOLUME_CHAINS = { ...CHAINS, velana: VELANA_CHAIN };

const AMM_ADDRESSES_PATH = path.join(__dirname, 'amm-addresses.json');
const DEFAULT_LOG_DIR = path.join(process.env.HOME, 'workspace', 'sniper', 'volume-logs');
const SLIPPAGE_BPS = 500; // 5% max slippage, both legs
const FEE_BPS = 30; // SimpleAMM fee: 0.3% (constant-product, Uniswap-V2 style)
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries, exponential backoff
const MAX_ROUNDS = 10000;

// Minimal inline ABI for the SimpleAMM contract — do NOT depend on a build
// artifact existing. Signatures are exactly the interface the deploy step
// implements.
const AMM_ABI = [
  'function buy(uint256 baseAmountIn, uint256 minDecoOut) payable',
  'function sell(uint256 decoAmountIn, uint256 minBaseOut)',
  'function getReserves() view returns (uint256 decoReserve, uint256 baseReserve)',
  'function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// Per-chain volume parameters. Base = the asset spent to buy DECO.
// Arc: base is the USDC ERC-20 view (6 dec); gas is native USDC (18 dec).
// The USDC view mirrors the native balance, so a tx's gas ALSO reduces the
// measured view balance — gasPollutesBase flags that for sell accounting.
// Robinhood/LitVM/Velana: base IS the native gas token.
// `deco` is per-chain because Velana's DECO lives at a different address
// (burner nonce was already 1 there from the land claim); the 3 original
// chains share the config.js DECO address.
// `legacyTx`: Velana (Besu) sends use legacy type-0 txs with an explicit
// gas price, the pattern proven by the land-claim script.
// `paceMs`: extra sleep after each round; Velana's RPC is rate-limited to
// 240 req/min per IP, so rounds are paced to stay well under it.
const VOLUME = {
  arc: {
    deco: DECO,
    baseIsNative: false,
    gasPollutesBase: true, // native-USDC gas moves the USDC-view balance
    baseToken: '0x3600000000000000000000000000000000000000', // USDC ERC-20 view
    baseDecimals: 6,
    baseSymbol: 'USDC',
    roundSize: 100000n, // 0.1 USDC
    defaultMaxGas: ethers.parseUnits('10', 18), // 10 native USDC
    paceMs: 0,
  },
  robinhood: {
    deco: DECO,
    baseIsNative: true,
    baseToken: null,
    baseDecimals: 18,
    baseSymbol: 'ETH',
    roundSize: ethers.parseUnits('0.0001', 18), // 0.0001 test ETH
    defaultMaxGas: ethers.parseUnits('0.005', 18), // 0.005 test ETH
    paceMs: 0,
  },
  litvm: {
    deco: DECO,
    baseIsNative: true,
    baseToken: null,
    baseDecimals: 18,
    baseSymbol: 'zkLTC',
    roundSize: ethers.parseUnits('0.0001', 18), // 0.0001 zkLTC
    defaultMaxGas: ethers.parseUnits('0.02', 18), // 0.02 zkLTC
    paceMs: 0,
  },
  velana: {
    deco: '0xDf8A3BaAFffc5de3938bff1158584E841531BcbF', // Velana DECO (deployed 2026-11-16; nonce 1)
    baseIsNative: true,
    baseToken: null,
    baseDecimals: 18,
    baseSymbol: 'VELA',
    roundSize: ethers.parseUnits('0.0001', 18), // 0.0001 test VELA
    defaultMaxGas: ethers.parseUnits('0.02', 18), // 0.02 test VELA (gas is ~7 wei; 2,000 txs cost ~1e-9 VELA)
    legacyTx: true,
    legacyGasPriceFallback: 7n, // wei — Velana's gas price if feeData has none
    paceMs: 2000, // Velana RPC: 240 req/min per IP; ~16 req/round + 2s pace keeps the run well under it
  },
};

const USAGE = `
Usage: node volume.js --chain <arc|robinhood|litvm|velana> --rounds <N> [options]

Volume-mode sniper: repeated buy-then-sell-back rounds against deco's own
SimpleAMM pool. Testnet ONLY (chainIds 5042002, 46630, 4441, 484148), burner
wallet only. One round = buy a fixed base amount, sell back exactly the DECO
received.

  --chain <name>        arc | robinhood | litvm | velana (required)
  --rounds <N>          Number of rounds, 1-${MAX_ROUNDS} (required)
  --live                Execute for real (default is dry-run: plan + read-only
                        checks only, nothing sent, keystore untouched)
  --dry-run             Explicit dry-run (default; conflicts with --live)
  --inflight <N>        Rounds in flight (default 1 = sequential; >1 NOT
                        implemented — the script refuses rather than guessing)
  --max-gas <x>         Max total native gas spend for the run, in native
                        units (default: Arc 10 USDC, Robinhood 0.005 ETH,
                        LitVM 0.02 zkLTC, Velana 0.02 VELA)
  --log-dir <dir>       Log directory (default ~/workspace/sniper/volume-logs/)
  --amm-file <path>     AMM addresses JSON (default sniper/amm-addresses.json;
                        Velana uses sniper/amm-addresses-velana.json)
  --self-test           No RPC, no keystore: exercises round math, JSONL
                        logging and summary generation in a temp dir
  --help                Show this message

Round sizes: Arc 0.1 USDC (ERC-20 view) | Robinhood 0.0001 ETH | LitVM 0.0001 zkLTC | Velana 0.0001 VELA.
Slippage 5% both legs. Approvals: MaxUint256 (once per token per AMM).
Logs: <log-dir>/<YYYY-MM-DD>-<chain>.jsonl + summary JSON next to it.
`;

// ---------------------------------------------------------------- helpers

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shortErr(e) {
  return String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 200);
}

function fmt(bi, decimals = 18) {
  return ethers.formatUnits(bi, decimals);
}

// Date/time parts in Asia/Jakarta (deco's timezone) — used for log filenames.
function jakartaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}${get('minute')}${get('second')}` };
}

// Pure JS mirror of the AMM's constant-product quote with a 0.3% fee
// (Uniswap-V2 formula). Used by --self-test and cross-checked against the
// on-chain getAmountOut in dry-run. Live quotes always come from the chain.
function amountOutMirror(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(10000 - FEE_BPS);
  return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
}

// Minimum acceptable output at `slippageBps` below the quote (floor).
function minOutFor(quote, slippageBps = SLIPPAGE_BPS) {
  return (quote * BigInt(10000 - slippageBps)) / 10000n;
}

// True when spending `projected` more would breach the gas budget.
function wouldBreachBudget(spent, projected, budget) {
  return spent + projected > budget;
}

// Gas cost of a mined tx: gasUsed x effective gas price.
function txCost(receipt, sent) {
  const price = receipt.gasPrice ?? sent?.gasPrice ?? sent?.maxFeePerGas ?? 0n;
  return receipt.gasUsed * price;
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const args = {
    chain: null, rounds: null, live: false, dryRun: false, inflight: 1,
    maxGas: null, logDir: DEFAULT_LOG_DIR, ammFile: AMM_ADDRESSES_PATH,
    selfTest: false, help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    let a = rest[i];
    let value = null;
    const eq = a.indexOf('=');
    if (eq !== -1) { value = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => {
      if (value !== null) return value;
      if (i + 1 >= rest.length) throw new Error(`${a} needs a value (see --help)`);
      return rest[++i];
    };
    if (a === '--chain') args.chain = next();
    else if (a === '--rounds') args.rounds = next();
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--inflight') args.inflight = Number(next());
    else if (a === '--max-gas') args.maxGas = next();
    else if (a === '--log-dir') args.logDir = next();
    else if (a === '--amm-file') args.ammFile = next();
    else if (a === '--self-test') args.selfTest = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a} (see --help)`);
  }
  if (args.help || args.selfTest) return args;
  if (args.live && args.dryRun) {
    throw new Error('--live and --dry-run are mutually exclusive.');
  }
  if (!args.chain || !VOLUME_CHAINS[args.chain]) {
    throw new Error(`--chain must be one of ${Object.keys(VOLUME_CHAINS).join(', ')} — got ${args.chain ?? '(missing)'}`);
  }
  if (!VOLUME[args.chain]) {
    throw new Error(`No volume parameters configured for chain "${args.chain}" — refusing to run.`);
  }
  const rounds = Number(args.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new Error(`--rounds must be an integer between 1 and ${MAX_ROUNDS} — got ${args.rounds ?? '(missing)'}`);
  }
  args.rounds = rounds;
  if (!Number.isInteger(args.inflight) || args.inflight < 1) {
    throw new Error(`--inflight must be a positive integer — got ${args.inflight}`);
  }
  if (args.inflight > 1) {
    throw new Error(
      `Pipelining (--inflight=${args.inflight}) is NOT implemented: this script runs ` +
      'sequentially only (--inflight=1). Overlapping rounds would break the ' +
      'nonce and balance-delta accounting; speed is secondary to correctness.',
    );
  }
  if (args.maxGas !== null) {
    try {
      args.maxGasParsed = ethers.parseUnits(args.maxGas, 18);
    } catch {
      throw new Error(`--max-gas must be a decimal number in native units — got ${args.maxGas}`);
    }
    if (args.maxGasParsed <= 0n) throw new Error('--max-gas must be greater than 0.');
  }
  return args;
}

// ------------------------------------------------------- AMM addresses

function loadAmmAddress(chainKey, filePath = AMM_ADDRESSES_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(
      `AMM addresses file not found: ${filePath}\n` +
      'The SimpleAMM deploy step has not run yet (or wrote to a different path). ' +
      'Expected JSON: {"arc": "0x...", "robinhood": "0x...", "litvm": "0x..."}.',
    );
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    throw new Error(`AMM addresses file is not valid JSON: ${filePath}: ${shortErr(e)}`);
  }
  const addr = map[chainKey];
  if (!addr || !ethers.isAddress(addr)) {
    throw new Error(
      `No valid SimpleAMM address for chain "${chainKey}" in ${filePath}. ` +
      `Deploy the AMM for ${chainKey} first, or fix the entry (expected a 0x address).`,
    );
  }
  return addr;
}

// ---------------------------------------------------------------- logging

class JsonlLogger {
  constructor(logDir, chainKey) {
    fs.mkdirSync(logDir, { recursive: true });
    const { date } = jakartaParts();
    this.logFile = path.join(logDir, `${date}-${chainKey}.jsonl`);
    this.chainKey = chainKey;
  }

  // One JSON object per line. Synchronous append: low volume, and a crash
  // can never lose a buffered tx record.
  log(entry) {
    fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
  }
}

function txEntry({ chainKey, round, side, receipt, sent, amountIn, amountOut, inAsset, outAsset, error, note }) {
  return {
    ts: new Date().toISOString(),
    chain: chainKey,
    round,
    side,
    txHash: receipt ? receipt.hash : (sent ? sent.hash : null),
    status: receipt ? (receipt.status === 1 ? 'confirmed' : 'reverted') : 'failed',
    gasUsed: receipt ? receipt.gasUsed.toString() : null,
    gasPrice: receipt ? (receipt.gasPrice ?? 0n).toString() : null,
    amountIn: amountIn === null || amountIn === undefined ? null : amountIn.toString(),
    amountOut: amountOut === null || amountOut === undefined ? null : amountOut.toString(),
    inAsset: inAsset ?? null,
    outAsset: outAsset ?? null,
    ...(error ? { error } : {}),
    ...(note ? { note } : {}),
  };
}

function buildSummary({ chainKey, chain, vol, roundsRequested, stats, logFile, startedAt, finishedAt, stoppedReason }) {
  const feesPaid = stats.boughtTotal - stats.soldTotal;
  return {
    chain: chainKey,
    chainId: chain.chainId,
    roundsRequested,
    roundsCompleted: stats.roundsCompleted,
    roundsFailed: stats.roundsFailed,
    txsSent: stats.txsSent,
    boughtTotal: stats.boughtTotal.toString(),
    soldTotal: stats.soldTotal.toString(),
    feesPaid: feesPaid.toString(),
    decoBoughtTotal: stats.decoBoughtTotal.toString(),
    decoSoldTotal: stats.decoSoldTotal.toString(),
    gasTotalNative: stats.gasTotalNative.toString(),
    baseSymbol: vol.baseSymbol,
    baseDecimals: vol.baseDecimals,
    gasSymbol: chain.gasToken.symbol,
    stoppedReason,
    logFile,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    formatted: {
      boughtTotal: `${fmt(stats.boughtTotal, vol.baseDecimals)} ${vol.baseSymbol}`,
      soldTotal: `${fmt(stats.soldTotal, vol.baseDecimals)} ${vol.baseSymbol}`,
      feesPaid: `${fmt(feesPaid, vol.baseDecimals)} ${vol.baseSymbol}`,
      decoBoughtTotal: `${fmt(stats.decoBoughtTotal)} DECO`,
      decoSoldTotal: `${fmt(stats.decoSoldTotal)} DECO`,
      gasTotalNative: `${fmt(stats.gasTotalNative)} ${chain.gasToken.symbol}`,
    },
  };
}

// Retry a fallible async fn up to 3 times (1s/2s/4s backoff). Used for both
// RPC reads and tx sends.
async function retryAsync(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_DELAYS_MS.length) {
        log(`  ${label}: attempt ${attempt + 1} failed (${shortErr(e)}) — retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- dry-run

async function runDry(chainKey, rounds, opts) {
  const chain = VOLUME_CHAINS[chainKey];
  const vol = VOLUME[chainKey];
  const ammAddress = loadAmmAddress(chainKey, opts.ammFile); // throws a clear error if missing
  const budget = opts.maxGasParsed ?? vol.defaultMaxGas;

  console.log('\n=== VOLUME SNIPER — DRY-RUN ===');
  console.log(`Chain: ${chain.name} (${chainKey}, chainId ${chain.chainId})`);
  console.log(`AMM: ${ammAddress}`);
  console.log(`Rounds: ${rounds} x ${fmt(vol.roundSize, vol.baseDecimals)} ${vol.baseSymbol} buy + sell-back`);
  console.log(`Slippage: ${SLIPPAGE_BPS / 100}% both legs | Gas budget: ${fmt(budget)} ${chain.gasToken.symbol} (native)`);
  console.log('Mode: DRY-RUN — nothing will be sent, keystore untouched.\n');

  const provider = providerFor(chain);
  try {
    await assertTestnetChain(provider, chain);
    console.log(`[check] RPC chainId ${chain.chainId} OK`);
  } catch (e) {
    if (/REFUSED/.test(e.message)) throw e; // guard failure is fatal, even dry
    console.log(`[check] RPC unreachable (${shortErr(e)}) — read-only checks skipped; plan above still stands.`);
    return;
  }

  const amm = new ethers.Contract(ammAddress, AMM_ABI, provider);
  const deco = new ethers.Contract(vol.deco, ERC20_ABI, provider);
  try {
    const [decoReserve, baseReserve] = await amm.getReserves();
    console.log(`[check] Reserves: ${fmt(decoReserve)} DECO / ${fmt(baseReserve, vol.baseDecimals)} ${vol.baseSymbol}`);
    if (decoReserve === 0n || baseReserve === 0n) {
      console.log('[check] Pool has empty reserves — a live run would abort until the pool is seeded.');
    } else {
      const quote = await amm.getAmountOut(vol.roundSize, baseReserve, decoReserve);
      const minOut = minOutFor(quote);
      console.log(`[check] Buy quote for one round: ${fmt(quote)} DECO (min out @5% slippage: ${fmt(minOut)} DECO)`);
      const mirror = amountOutMirror(vol.roundSize, baseReserve, decoReserve);
      console.log(`[check] JS quote mirror: ${fmt(mirror)} DECO ${mirror === quote ? '(matches on-chain)' : '(DIFFERS from on-chain — investigate before going live!)'}`);
      // Best-effort gas estimate (fails in simulation if allowance is not
      // set yet — the live run approves first, so that is not fatal here).
      try {
        const tx = await amm.buy.populateTransaction(
          vol.roundSize, minOut, vol.baseIsNative ? { value: vol.roundSize } : {},
        );
        tx.from = BURNER;
        const gas = await provider.estimateGas(tx);
        const feeData = await provider.getFeeData();
        const gp = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
        console.log(`[check] Buy gas estimate: ~${gas} gas (~${fmt(gas * gp)} ${chain.gasToken.symbol} at ${fmt(gp, 9)} gwei; sell assumed similar)`);
      } catch (e) {
        console.log(`[check] Buy gas estimate unavailable (${shortErr(e)}) — live run approves first, then estimates.`);
      }
    }
    const nativeBal = await provider.getBalance(BURNER);
    console.log(`[check] Burner native balance: ${fmt(nativeBal)} ${chain.gasToken.symbol}`);
    if (!vol.baseIsNative) {
      const base = new ethers.Contract(vol.baseToken, ERC20_ABI, provider);
      const baseBal = await base.balanceOf(BURNER);
      const baseAllow = await base.allowance(BURNER, ammAddress);
      console.log(`[check] Burner ${vol.baseSymbol} (view) balance: ${fmt(baseBal, vol.baseDecimals)} | allowance to AMM: ${fmt(baseAllow, vol.baseDecimals)}`);
    }
    const decoBal = await deco.balanceOf(BURNER);
    const decoAllow = await deco.allowance(BURNER, ammAddress);
    console.log(`[check] Burner DECO balance: ${fmt(decoBal)} | allowance to AMM: ${fmt(decoAllow)}`);
  } catch (e) {
    console.log(`[check] Read-only checks failed (${shortErr(e)}) — the AMM may not be deployed at ${ammAddress} yet.`);
  }
  console.log('\nDry-run complete. Re-run with --live to execute (testnet only).');
}

// ---------------------------------------------------------------- live run

class VolumeRunner {
  constructor(chainKey, rounds, opts) {
    this.chainKey = chainKey;
    this.chain = VOLUME_CHAINS[chainKey];
    this.vol = VOLUME[chainKey];
    this.decoAddress = this.vol.deco; // per-chain DECO (Velana differs)
    this.roundsRequested = rounds;
    this.opts = opts;
    this.provider = providerFor(this.chain);
    this.signer = null;
    this.amm = null; // signer-connected (writes)
    this.ammRead = null; // provider-connected (reads)
    this.deco = null;
    this.baseToken = null;
    this.ammAddress = null;
    this.nonce = null;
    this.logger = null;
    this.legacyGasPrice = null; // legacy-tx chains only (Velana)
    this.budget = opts.maxGasParsed ?? this.vol.defaultMaxGas;
    this.estRoundCost = null;
    this.quotePerBuy = null;
    this.decoBaseline = null; // DECO balance at init; cleanup sells only above this
    this.startedAt = new Date();
    this.stopRequested = false;
    this.stoppedReason = 'completed';
    this.stats = {
      roundsCompleted: 0,
      roundsFailed: 0,
      txsSent: 0, // every broadcast tx: approvals + buys + sells + cleanup
      boughtTotal: 0n, // base spent on buys (raw base units)
      soldTotal: 0n, // base received from sells (raw base units)
      decoBoughtTotal: 0n,
      decoSoldTotal: 0n,
      gasTotalNative: 0n, // native gas cost, raw units (incl. approvals)
    };
  }

  async baseBalance() {
    if (this.vol.baseIsNative) return this.provider.getBalance(BURNER);
    return this.baseToken.balanceOf(BURNER);
  }

  // True when a tx's gas payment moves the measured base balance: native-base
  // chains (gas IS the base asset) and Arc (native-USDC gas moves the
  // USDC-view balance, which mirrors native). Sell accounting must add the
  // tx's gas cost back to the balance delta on those chains.
  gasAffectsBaseDelta() {
    return this.vol.baseIsNative || this.vol.gasPollutesBase === true;
  }

  // Convert a native gas cost (always 18 decimals) into base-asset units.
  // On native-base chains this is the identity; on Arc the base is the
  // 6-decimal USDC view, so divide by 10^12 — adding raw 18-decimal wei to
  // a 6-decimal balance (the first attempt at this fix) inflates the sold
  // total by ~1e12x. Never add unconverted gas costs to base amounts.
  gasCostInBaseUnits(nativeCost) {
    if (this.vol.baseIsNative) return nativeCost;
    return nativeCost / (10n ** BigInt(18 - this.vol.baseDecimals));
  }

  // Projected gas cost of the next round: actual average so far (x1.2
  // safety) once any round has run, else the startup estimate.
  projectedRoundCost() {
    const attempted = this.stats.roundsCompleted + this.stats.roundsFailed;
    if (attempted > 0 && this.stats.gasTotalNative > 0n) {
      return (this.stats.gasTotalNative * 120n) / BigInt(attempted) / 100n;
    }
    return this.estRoundCost;
  }

  // Send with retries. The nonce is fixed for the whole send (including
  // retries), so a retried send can never double-send: at worst it replays
  // the identical tx. Nonce advances only after a successful broadcast.
  async sendTx(label, sendFn) {
    const nonce = this.nonce;
    let sent;
    try {
      sent = await retryAsync(() => sendFn(nonce), label);
    } catch (e) {
      // The send failed after retries — but the tx may still have landed
      // (lost response). Re-sync the local nonce from chain so the next
      // send doesn't wedge on "nonce has already been used" (Robinhood
      // top-up part 2, 2026-11-16: round 42's buy landed but its response
      // was lost; the stale local nonce then failed 73 rounds identically
      // with zero txs sent). 'pending' counts in-flight txs, so a tx that
      // landed or is still in the mempool is accounted for.
      try {
        const chainNonce = await this.provider.getTransactionCount(BURNER, 'pending');
        if (chainNonce !== this.nonce) {
          log(`  sendTx ${label} failed; nonce re-synced ${this.nonce} -> ${chainNonce} (tx may have landed)`);
          this.nonce = chainNonce;
        }
      } catch (e2) {
        log(`  sendTx ${label} failed; nonce re-sync also failed: ${shortErr(e2)} — continuing with local nonce ${this.nonce}`);
      }
      throw e;
    }
    this.nonce++;
    this.stats.txsSent++;
    return sent;
  }

  // Per-chain tx overrides: plain { nonce } (+ value) on the 3 original
  // chains; legacy type-0 + the run's explicit gas price on Velana (Besu).
  // The gas price is read once at init (see init()).
  txOverrides(nonce, extra = {}) {
    if (this.vol.legacyTx) {
      return { type: 0, gasPrice: this.legacyGasPrice, nonce, ...extra };
    }
    return { nonce, ...extra };
  }

  async approve(tokenAddress, symbol) {
    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
    const sent = await this.sendTx(`approve ${symbol}`, (nonce) =>
      erc20.approve(this.ammAddress, ethers.MaxUint256, this.txOverrides(nonce)));
    const receipt = await sent.wait();
    const cost = txCost(receipt, sent);
    this.stats.gasTotalNative += cost;
    this.logger.log(txEntry({
      chainKey: this.chainKey, round: 0, side: 'approve', receipt, sent,
      amountIn: null, amountOut: null, inAsset: symbol, outAsset: null,
      note: `approve ${symbol} MaxUint256 to AMM ${this.ammAddress}`,
    }));
    if (receipt.status !== 1) {
      throw new Error(`Approval tx for ${symbol} reverted (${receipt.hash}) — aborting.`);
    }
    log(`  approve ${symbol}: ${receipt.hash} (gas ${receipt.gasUsed})`);
  }

  async ensureApprovals() {
    // DECO -> AMM (for sells): need roughly rounds x quote per buy.
    const decoNeeded = this.quotePerBuy * BigInt(this.roundsRequested);
    const decoAllow = await retryAsync(
      () => this.deco.allowance(BURNER, this.ammAddress), 'DECO allowance read');
    if (decoAllow < decoNeeded) {
      log(`DECO allowance ${fmt(decoAllow)} < needed ${fmt(decoNeeded)} — approving MaxUint256…`);
      await this.approve(this.decoAddress, 'DECO');
    } else {
      log(`DECO allowance OK: ${fmt(decoAllow)}`);
    }
    // USDC view -> AMM on Arc (for buys): need rounds x round size.
    if (!this.vol.baseIsNative) {
      const baseNeeded = this.vol.roundSize * BigInt(this.roundsRequested);
      const baseAllow = await retryAsync(
        () => this.baseToken.allowance(BURNER, this.ammAddress), 'USDC allowance read');
      if (baseAllow < baseNeeded) {
        log(`USDC allowance ${fmt(baseAllow, 6)} < needed ${fmt(baseNeeded, 6)} — approving MaxUint256…`);
        await this.approve(this.vol.baseToken, this.vol.baseSymbol);
      } else {
        log(`USDC allowance OK: ${fmt(baseAllow, 6)}`);
      }
    }
  }

  async init() {
    const { chain, vol } = this;
    this.ammAddress = loadAmmAddress(this.chainKey, this.opts.ammFile);
    await assertTestnetChain(this.provider, chain);
    // Keystore is loaded ONLY in live mode, and only after the chain guard.
    const { loadBurnerWallet } = require('./keystore');
    this.signer = loadBurnerWallet(this.provider);
    log(`*** LIVE MODE *** ${chain.name}: signer loaded (burner ${BURNER}, key never logged)`);
    this.nonce = await this.provider.getTransactionCount(BURNER, 'pending');
    log(`AMM: ${this.ammAddress} | starting nonce: ${this.nonce}`);
    // Legacy-tx chains (Velana): read the gas price once for the whole run.
    if (vol.legacyTx) {
      const feeData = await this.provider.getFeeData();
      this.legacyGasPrice = feeData.gasPrice ?? vol.legacyGasPriceFallback;
      log(`Legacy tx mode: gas price ${this.legacyGasPrice} wei (${fmt(this.legacyGasPrice, 9)} gwei)`);
    }
    this.amm = new ethers.Contract(this.ammAddress, AMM_ABI, this.signer);
    this.ammRead = new ethers.Contract(this.ammAddress, AMM_ABI, this.provider);
    this.deco = new ethers.Contract(this.decoAddress, ERC20_ABI, this.provider);
    if (!vol.baseIsNative) {
      this.baseToken = new ethers.Contract(vol.baseToken, ERC20_ABI, this.provider);
    }
    this.logger = new JsonlLogger(this.opts.logDir, this.chainKey);
    log(`Logging to ${this.logger.logFile}`);

    // Reserves + quote.
    const [decoReserve, baseReserve] = await retryAsync(
      () => this.ammRead.getReserves(), 'getReserves');
    if (decoReserve === 0n || baseReserve === 0n) {
      throw new Error(`AMM pool has empty reserves (deco=${decoReserve} base=${baseReserve}) — pool not seeded; aborting.`);
    }
    const quote = await retryAsync(
      () => this.ammRead.getAmountOut(vol.roundSize, baseReserve, decoReserve), 'buy quote');
    if (quote === 0n) throw new Error('Buy quote is 0 — pool too thin for the round size; aborting.');
    this.quotePerBuy = quote;
    log(`Reserves: ${fmt(decoReserve)} DECO / ${fmt(baseReserve, vol.baseDecimals)} ${vol.baseSymbol}; ` +
      `quote for ${fmt(vol.roundSize, vol.baseDecimals)} ${vol.baseSymbol} = ${fmt(quote)} DECO`);

    // Balances + base-balance check (base is recycled each round, so the
    // run needs ~one round size plus accumulated ~1% round-trip fees).
    const nativeBal = await this.provider.getBalance(BURNER);
    const baseBal = await this.baseBalance();
    log(`Burner native balance: ${fmt(nativeBal)} ${chain.gasToken.symbol}` +
      (vol.baseIsNative ? '' : ` | ${vol.baseSymbol} balance: ${fmt(baseBal, vol.baseDecimals)}`));
    const feeEstimate = (vol.roundSize * BigInt(this.roundsRequested)) / 100n; // ~1% fees
    const baseRequired = vol.roundSize + feeEstimate;
    if (baseBal < baseRequired) {
      throw new Error(
        `Insufficient ${vol.baseSymbol} balance: have ${fmt(baseBal, vol.baseDecimals)}, ` +
        `need ~${fmt(baseRequired, vol.baseDecimals)} (one round size + ~1% fees over ${this.roundsRequested} rounds). ` +
        'Reduce --rounds or fund the burner.',
      );
    }

    // DECO baseline for the end-of-run cleanup: only DECO above this line
    // may ever be sold by cleanupSell. The burner holds its 990,000 DECO
    // supply on each chain — selling the whole balance (the pre-fix bug)
    // would dump it all into the pool.
    this.decoBaseline = await retryAsync(
      () => this.deco.balanceOf(BURNER), 'DECO baseline balance');
    log(`DECO baseline (cleanup sells only above this): ${fmt(this.decoBaseline)} DECO`);

    // Approvals BEFORE the gas estimate: on Arc the buy simulation reverts
    // without USDC allowance. Approvals persist on-chain, so they are not
    // wasted if a later check aborts the run.
    await this.ensureApprovals();

    // Gas estimate for one buy; sell assumed similar. 1.5x safety factor.
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (!gasPrice) throw new Error('Could not read a gas price from the RPC — aborting.');
    const minOut = minOutFor(quote);
    let buyGas;
    try {
      buyGas = await this.amm.buy.estimateGas(
        vol.roundSize, minOut, vol.baseIsNative ? { value: vol.roundSize } : {},
      );
    } catch (e) {
      throw new Error(`Buy gas estimate failed — the buy would likely revert (${shortErr(e)}). Check reserves/allowance; aborting.`);
    }
    this.estRoundCost = (buyGas * 2n * gasPrice * 150n) / 100n;
    log(`Estimated gas: buy ~${buyGas} gas at ${fmt(gasPrice, 9)} gwei -> ` +
      `~${fmt(this.estRoundCost)} ${chain.gasToken.symbol}/round (sell assumed similar, 1.5x safety)`);

    // Gas-balance check against what the run can actually spend:
    // min(full estimated cost, budget). Re-read the native balance — the
    // approval txs above already spent some gas.
    const estTotal = this.estRoundCost * BigInt(this.roundsRequested);
    const gasRequired = estTotal < this.budget ? estTotal : this.budget;
    const nativeBalAfter = await this.provider.getBalance(BURNER);
    if (nativeBalAfter < gasRequired) {
      throw new Error(
        `Insufficient gas balance: have ${fmt(nativeBalAfter)} ${chain.gasToken.symbol}, ` +
        `need ~${fmt(gasRequired)} (estimated run cost, capped by the ${fmt(this.budget)} budget). ` +
        'Reduce --rounds or fund the burner.',
      );
    }
    log(`Gas budget: ${fmt(this.budget)} ${chain.gasToken.symbol} | estimated total: ${fmt(estTotal)} ${chain.gasToken.symbol}`);
  }

  // Per-round balance guard: stop gracefully (not a failed round) if the
  // wallet can no longer fund a round.
  async balanceGuard(projectedGas) {
    const { vol, chain } = this;
    // Both reads are retried: a single transient RPC drop here used to throw
    // to the top-level handler and kill the whole run (Arc first run,
    // 2026-11-16 — round 476 finished, then a socket hang-up in this guard
    // stopped the run with 524 rounds left, gas budget untouched).
    const nativeBal = await retryAsync(
      () => this.provider.getBalance(BURNER), 'balanceGuard native balance');
    if (vol.baseIsNative) {
      if (nativeBal < vol.roundSize + projectedGas) {
        log(`Stopping: native balance ${fmt(nativeBal)} ${chain.gasToken.symbol} cannot fund another round ` +
          `(${fmt(vol.roundSize)} base + ~${fmt(projectedGas)} gas).`);
        return false;
      }
    } else {
      if (nativeBal < projectedGas) {
        log(`Stopping: native gas balance ${fmt(nativeBal)} ${chain.gasToken.symbol} below projected round gas ~${fmt(projectedGas)}.`);
        return false;
      }
      const baseBal = await retryAsync(
        () => this.baseToken.balanceOf(BURNER), 'balanceGuard base balance');
      if (baseBal < vol.roundSize) {
        log(`Stopping: ${vol.baseSymbol} balance ${fmt(baseBal, vol.baseDecimals)} below round size ${fmt(vol.roundSize, vol.baseDecimals)}.`);
        return false;
      }
    }
    return true;
  }

  async runRound(round) {
    const { vol, chain } = this;
    try {
      // --- BUY ---
      const [decoReserve, baseReserve] = await retryAsync(
        () => this.ammRead.getReserves(), `round ${round} getReserves`);
      if (decoReserve === 0n || baseReserve === 0n) {
        this.logRoundFailure(round, 'buy', 'empty reserves');
        return false;
      }
      const quote = await retryAsync(
        () => this.ammRead.getAmountOut(vol.roundSize, baseReserve, decoReserve),
        `round ${round} buy quote`);
      const minOut = minOutFor(quote);
      if (minOut === 0n) {
        this.logRoundFailure(round, 'buy', 'quote too small (minOut 0)');
        return false;
      }
      const decoBefore = await retryAsync(
        () => this.deco.balanceOf(BURNER), `round ${round} DECO balance (pre-buy)`);
      const sentBuy = await this.sendTx(`round ${round} buy`, (nonce) =>
        this.amm.buy(vol.roundSize, minOut,
          vol.baseIsNative
            ? this.txOverrides(nonce, { value: vol.roundSize })
            : this.txOverrides(nonce)));
      const buyReceipt = await sentBuy.wait();
      const buyCost = txCost(buyReceipt, sentBuy);
      this.stats.gasTotalNative += buyCost;
      if (buyReceipt.status !== 1) {
        this.logger.log(txEntry({
          chainKey: this.chainKey, round, side: 'buy', receipt: buyReceipt, sent: sentBuy,
          amountIn: vol.roundSize, amountOut: 0n, inAsset: vol.baseSymbol, outAsset: 'DECO',
        }));
        log(`  round ${round} BUY reverted: ${buyReceipt.hash} — continuing`);
        this.stats.roundsFailed++;
        return false;
      }
      // DECO received, by balance delta. If the read fails even after
      // retries, log the buy with an unknown output and skip the sell —
      // the DECO stays in the wallet for the end-of-run cleanup.
      let decoReceived;
      try {
        const decoAfter = await retryAsync(
          () => this.deco.balanceOf(BURNER), `round ${round} DECO balance (post-buy)`);
        decoReceived = decoAfter - decoBefore;
      } catch (e) {
        this.logger.log(txEntry({
          chainKey: this.chainKey, round, side: 'buy', receipt: buyReceipt, sent: sentBuy,
          amountIn: vol.roundSize, amountOut: null, inAsset: vol.baseSymbol, outAsset: 'DECO',
          error: `post-buy DECO balance read failed: ${shortErr(e)}`,
        }));
        log(`  round ${round} BUY confirmed (${buyReceipt.hash}) but DECO balance unreadable — sell skipped, cleanup at end`);
        this.stats.boughtTotal += vol.roundSize;
        this.stats.roundsFailed++;
        return false;
      }
      this.logger.log(txEntry({
        chainKey: this.chainKey, round, side: 'buy', receipt: buyReceipt, sent: sentBuy,
        amountIn: vol.roundSize, amountOut: decoReceived, inAsset: vol.baseSymbol, outAsset: 'DECO',
      }));
      this.stats.boughtTotal += vol.roundSize;
      this.stats.decoBoughtTotal += decoReceived;
      if (decoReceived === 0n) {
        log(`  round ${round} BUY confirmed but 0 DECO received — skipping sell`);
        this.stats.roundsFailed++;
        return false;
      }

      // --- SELL (exactly the DECO received) ---
      const [decoReserve2, baseReserve2] = await retryAsync(
        () => this.ammRead.getReserves(), `round ${round} getReserves (sell)`);
      const sellQuote = await retryAsync(
        () => this.ammRead.getAmountOut(decoReceived, decoReserve2, baseReserve2),
        `round ${round} sell quote`);
      const minBaseOut = minOutFor(sellQuote);
      if (minBaseOut === 0n) {
        log(`  round ${round} sell quote too small — ${fmt(decoReceived)} DECO left in wallet (cleanup at end)`);
        this.stats.roundsFailed++;
        return false;
      }
      const baseBefore = await retryAsync(() => this.baseBalance(), `round ${round} base balance (pre-sell)`);
      const sentSell = await this.sendTx(`round ${round} sell`, (nonce) =>
        this.amm.sell(decoReceived, minBaseOut, this.txOverrides(nonce)));
      const sellReceipt = await sentSell.wait();
      const sellCost = txCost(sellReceipt, sentSell);
      this.stats.gasTotalNative += sellCost;
      if (sellReceipt.status !== 1) {
        this.logger.log(txEntry({
          chainKey: this.chainKey, round, side: 'sell', receipt: sellReceipt, sent: sentSell,
          amountIn: decoReceived, amountOut: 0n, inAsset: 'DECO', outAsset: vol.baseSymbol,
        }));
        log(`  round ${round} SELL reverted: ${sellReceipt.hash} — ${fmt(decoReceived)} DECO left in wallet (cleanup at end)`);
        this.stats.roundsFailed++;
        return false;
      }
      let baseOut = null;
      try {
        const baseAfter = await retryAsync(() => this.baseBalance(), `round ${round} base balance (post-sell)`);
        baseOut = baseAfter - baseBefore;
        // Where gas moves the measured base balance (native-base chains, and
        // Arc where native-USDC gas moves the USDC view), the delta includes
        // the gas this tx paid — add it back (converted to base units) to
        // get the true base received.
        if (this.gasAffectsBaseDelta()) baseOut += this.gasCostInBaseUnits(sellCost);
      } catch (e) {
        log(`  round ${round} SELL confirmed but base balance unreadable — sold total will undercount this round`);
      }
      this.logger.log(txEntry({
        chainKey: this.chainKey, round, side: 'sell', receipt: sellReceipt, sent: sentSell,
        amountIn: decoReceived, amountOut: baseOut, inAsset: 'DECO', outAsset: vol.baseSymbol,
        ...(baseOut === null ? { error: 'post-sell base balance read failed' } : {}),
      }));
      if (baseOut !== null) this.stats.soldTotal += baseOut;
      this.stats.decoSoldTotal += decoReceived;
      this.stats.roundsCompleted++;
      log(`  round ${round} done: bought ${fmt(decoReceived)} DECO for ${fmt(vol.roundSize, vol.baseDecimals)} ${vol.baseSymbol}, ` +
        `sold back for ${baseOut === null ? '?' : fmt(baseOut, vol.baseDecimals)} ${vol.baseSymbol} ` +
        `(gas ${fmt(buyCost + sellCost)} ${chain.gasToken.symbol})`);
      return true;
    } catch (e) {
      // RPC/send failure after retries — log the round as failed and
      // CONTINUE to the next round.
      this.logger.log(txEntry({
        chainKey: this.chainKey, round, side: 'round', receipt: null, sent: null,
        amountIn: null, amountOut: null, error: shortErr(e),
      }));
      log(`  round ${round} FAILED: ${shortErr(e)} — continuing to next round`);
      this.stats.roundsFailed++;
      return false;
    }
  }

  logRoundFailure(round, side, reason) {
    this.logger.log(txEntry({
      chainKey: this.chainKey, round, side, receipt: null, sent: null,
      amountIn: null, amountOut: null, error: reason,
    }));
    log(`  round ${round} ${side.toUpperCase()} skipped: ${reason} — continuing`);
    this.stats.roundsFailed++;
  }

  // Best-effort sell of DECO THIS RUN left behind (e.g. from a round whose
  // sell failed). Sells ONLY the amount above the init baseline, capped at
  // (failed rounds + 1) x buy size. Never fails the run. NEVER sells the
  // burner's standing DECO supply — see the 2026-11-16 Arc incident.
  async cleanupSell() {
    try {
      if (this.decoBaseline === null) {
        log('Cleanup skipped: no DECO baseline recorded — never selling blind.');
        return;
      }
      const current = await retryAsync(() => this.deco.balanceOf(BURNER), 'cleanup DECO balance');
      let leftover = current - this.decoBaseline;
      if (leftover <= 0n) {
        log(`Cleanup: no leftover DECO (balance ${fmt(current)}, baseline ${fmt(this.decoBaseline)}) — nothing to sell.`);
        return;
      }
      // Safety cap: each failed round leaves at most ~one buy's DECO.
      const cap = this.quotePerBuy * BigInt(this.stats.roundsFailed + 1);
      if (leftover > cap) {
        log(`Cleanup: leftover ${fmt(leftover)} exceeds the ${fmt(cap)} cap (failed rounds x buy size) — selling only the cap.`);
        leftover = cap;
      }
      log(`Cleanup: selling leftover ${fmt(leftover)} DECO…`);
      const projected = this.projectedRoundCost();
      if (wouldBreachBudget(this.stats.gasTotalNative, projected, this.budget)) {
        log('Cleanup skipped: gas budget would be breached — leftover DECO stays in the wallet.');
        return;
      }
      const [decoReserve, baseReserve] = await retryAsync(
        () => this.ammRead.getReserves(), 'cleanup getReserves');
      const quote = await retryAsync(
        () => this.ammRead.getAmountOut(leftover, decoReserve, baseReserve), 'cleanup sell quote');
      const minOut = minOutFor(quote);
      if (minOut === 0n) {
        log('Cleanup skipped: quote too small.');
        return;
      }
      const baseBefore = await retryAsync(() => this.baseBalance(), 'cleanup base balance (pre-sell)');
      const sent = await this.sendTx('cleanup sell', (nonce) =>
        this.amm.sell(leftover, minOut, this.txOverrides(nonce)));
      const receipt = await sent.wait();
      const cost = txCost(receipt, sent);
      this.stats.gasTotalNative += cost;
      if (receipt.status !== 1) {
        this.logger.log(txEntry({
          chainKey: this.chainKey, round: 0, side: 'sell-cleanup', receipt, sent,
          amountIn: leftover, amountOut: 0n, inAsset: 'DECO', outAsset: this.vol.baseSymbol,
        }));
        log(`Cleanup sell reverted: ${receipt.hash} — leftover DECO stays in the wallet.`);
        return;
      }
      const baseAfter = await retryAsync(() => this.baseBalance(), 'cleanup base balance (post-sell)');
      let baseOut = baseAfter - baseBefore;
      if (this.gasAffectsBaseDelta()) baseOut += this.gasCostInBaseUnits(cost);
      this.logger.log(txEntry({
        chainKey: this.chainKey, round: 0, side: 'sell-cleanup', receipt, sent,
        amountIn: leftover, amountOut: baseOut, inAsset: 'DECO', outAsset: this.vol.baseSymbol,
      }));
      this.stats.soldTotal += baseOut;
      this.stats.decoSoldTotal += leftover;
      log(`Cleanup: sold ${fmt(leftover)} DECO for ${fmt(baseOut, this.vol.baseDecimals)} ${this.vol.baseSymbol}`);
    } catch (e) {
      log(`Cleanup sell failed (non-fatal): ${shortErr(e)}`);
    }
  }

  summaryPath() {
    const { date, time } = jakartaParts(this.startedAt);
    return path.join(this.opts.logDir, `${date}-${this.chainKey}-summary-${time}.json`);
  }

  async finish() {
    const finishedAt = new Date();
    const summary = buildSummary({
      chainKey: this.chainKey, chain: this.chain, vol: this.vol,
      roundsRequested: this.roundsRequested, stats: this.stats,
      logFile: this.logger.logFile, startedAt: this.startedAt,
      finishedAt, stoppedReason: this.stoppedReason,
    });
    const summaryFile = this.summaryPath();
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    console.log('\n=== VOLUME RUN SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
    log(`Summary written to ${summaryFile}`);
  }

  async run() {
    process.on('SIGINT', () => {
      if (this.stopRequested) {
        console.log('\nSecond interrupt — exiting immediately (no summary).');
        process.exit(130);
      }
      this.stopRequested = true;
      console.log('\nInterrupt received — finishing the current round, then writing the summary…');
    });
    await this.init();
    try {
      for (let round = 1; round <= this.roundsRequested; round++) {
        if (this.stopRequested) {
          this.stoppedReason = 'interrupted';
          break;
        }
        const projected = this.projectedRoundCost();
        if (wouldBreachBudget(this.stats.gasTotalNative, projected, this.budget)) {
          log(`Gas budget ${fmt(this.budget)} ${this.chain.gasToken.symbol} would be breached by round ${round} ` +
            `(spent ${fmt(this.stats.gasTotalNative)}, projected +${fmt(projected)}) — stopping gracefully.`);
          this.stoppedReason = 'gas-budget';
          break;
        }
        if (!(await this.balanceGuard(projected))) {
          this.stoppedReason = 'insufficient-balance';
          break;
        }
        await this.runRound(round);
        // Per-chain pacing (Velana: RPC rate limit 240 req/min). Zero on
        // the 3 original chains — no behavior change there.
        if (this.vol.paceMs > 0 && round < this.roundsRequested && !this.stopRequested) {
          await sleep(this.vol.paceMs);
        }
      }
      await this.cleanupSell();
    } catch (e) {
      // Unexpected error in the loop (not a per-round failure): stop, but
      // still write the summary for what did run.
      log(`Unexpected run error: ${shortErr(e)} — stopping and writing the summary.`);
      this.stoppedReason = 'error';
    }
    await this.finish();
  }
}

// ---------------------------------------------------------------- self-test

// No RPC, no keystore. Exercises round math, JSONL logging, summary
// generation, the AMM-address loader error paths, arg validation, and the
// budget check — all against a temp dir. Exits 0 on success.
async function selfTest() {
  console.log('volume.js self-test (no RPC, no keystore)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-selftest-'));
  try {
    const ok = (cond, msg) => {
      if (!cond) throw new Error(`SELF-TEST FAIL: ${msg}`);
      console.log(`  ok — ${msg}`);
    };

    // 1. Round math (constant-product, 0.3% fee).
    // 1000 in, reserves 100000/50000: (1000*997*50000)/(100000*1000+1000*997)
    // = 49,850,000,000 / 100,997,000 = 493.57… -> 493 (floor).
    ok(amountOutMirror(1000n, 100000n, 50000n) === 493n,
      'quote mirror: 1000 in, reserves 100000/50000 -> 493 out');
    ok(amountOutMirror(0n, 100n, 100n) === 0n, 'quote mirror: zero input -> 0');
    ok(amountOutMirror(100n, 0n, 100n) === 0n, 'quote mirror: empty reserve -> 0');
    // Realistic Arc case: 0.1 USDC (6 dec) into a 5,000 USDC / 500,000 DECO
    // pool. No-fee out would be exactly 10 DECO; with fee it must be just under.
    const arcQuote = amountOutMirror(100000n, 5000000000n, 500000n * 10n ** 18n);
    ok(arcQuote > 9n * 10n ** 18n && arcQuote < 10n * 10n ** 18n,
      `quote mirror: 0.1 USDC into 5000 USDC / 500k DECO -> ${fmt(arcQuote)} DECO (just under 10)`);
    // 2. Slippage (5%).
    ok(minOutFor(10000n) === 9500n, 'slippage: minOut(10000 @5%) = 9500');
    ok(minOutFor(493n) === 468n, 'slippage: minOut(493 @5%) = 468 (floor)');
    // 3. Budget check.
    ok(wouldBreachBudget(90n, 11n, 100n) === true, 'budget: 90 spent + 11 projected > 100 budget');
    ok(wouldBreachBudget(90n, 10n, 100n) === false, 'budget: 90 spent + 10 projected = 100 budget (allowed)');
    ok(wouldBreachBudget(0n, 0n, 0n) === false, 'budget: zero/zero/zero does not breach');

    // 4. JSONL logging: write mock entries, read back, verify shape.
    const logger = new JsonlLogger(tmpDir, 'robinhood');
    const mockReceipt = { hash: '0xabc', status: 1, gasUsed: 120000n, gasPrice: 1000000000n };
    logger.log(txEntry({
      chainKey: 'robinhood', round: 1, side: 'buy', receipt: mockReceipt, sent: mockReceipt,
      amountIn: 100000000000000n, amountOut: 9500000000000000000n, inAsset: 'ETH', outAsset: 'DECO',
    }));
    logger.log(txEntry({
      chainKey: 'robinhood', round: 1, side: 'sell', receipt: mockReceipt, sent: mockReceipt,
      amountIn: 9500000000000000000n, amountOut: 99000000000000n, inAsset: 'DECO', outAsset: 'ETH',
    }));
    logger.log(txEntry({
      chainKey: 'robinhood', round: 2, side: 'buy', receipt: null, sent: null,
      amountIn: null, amountOut: null, error: 'mock RPC failure',
    }));
    const lines = fs.readFileSync(logger.logFile, 'utf8').trim().split('\n');
    ok(lines.length === 3, 'JSONL: 3 lines written');
    const parsed = lines.map((l) => JSON.parse(l));
    ok(parsed[0].side === 'buy' && parsed[0].status === 'confirmed' && parsed[0].txHash === '0xabc',
      'JSONL: buy line has side/status/txHash');
    ok(parsed[1].amountIn === '9500000000000000000' && parsed[1].amountOut === '99000000000000',
      'JSONL: sell line amounts are raw-unit strings');
    ok(parsed[2].status === 'failed' && parsed[2].error === 'mock RPC failure' && parsed[2].txHash === null,
      'JSONL: failed line carries error, null txHash');
    const serialized = JSON.stringify(parsed);
    ok(!serialized.includes('privateKey') && !serialized.includes('seed') && !serialized.includes(BURNER),
      'JSONL: entries carry no key material and no wallet address');

    // 5. Summary generation from mocked stats.
    const startedAt = new Date('2026-11-16T07:00:00.000Z');
    const finishedAt = new Date('2026-11-16T07:05:00.000Z');
    const summary = buildSummary({
      chainKey: 'robinhood', chain: CHAINS.robinhood, vol: VOLUME.robinhood,
      roundsRequested: 2,
      stats: {
        roundsCompleted: 1, roundsFailed: 1, txsSent: 2,
        boughtTotal: 100000000000000n, soldTotal: 99000000000000n,
        decoBoughtTotal: 9500000000000000000n, decoSoldTotal: 9500000000000000000n,
        gasTotalNative: 240000000000000n,
      },
      logFile: logger.logFile, startedAt, finishedAt, stoppedReason: 'completed',
    });
    ok(summary.feesPaid === (100000000000000n - 99000000000000n).toString(),
      `summary: feesPaid = bought - sold = ${summary.feesPaid} wei`);
    ok(summary.roundsCompleted === 1 && summary.roundsFailed === 1 && summary.txsSent === 2,
      'summary: round/tx counts pass through');
    ok(summary.formatted.gasTotalNative === '0.00024 ETH',
      `summary: formatted gas = ${summary.formatted.gasTotalNative}`);
    ok(!('gasTotalUsd' in summary), 'summary: no USD field anywhere');
    const summaryFile = path.join(tmpDir, 'summary-test.json');
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    ok(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).chain === 'robinhood',
      'summary: written to disk and re-readable');

    // 6. AMM address loader error paths.
    let threw = false;
    try {
      loadAmmAddress('robinhood', path.join(tmpDir, 'does-not-exist.json'));
    } catch (e) {
      threw = /AMM addresses file not found/.test(e.message);
    }
    ok(threw, 'amm-addresses: missing file throws a clear error');
    const partialFile = path.join(tmpDir, 'partial.json');
    fs.writeFileSync(partialFile, JSON.stringify({ arc: '0x1111111111111111111111111111111111111111' }));
    threw = false;
    try {
      loadAmmAddress('robinhood', partialFile);
    } catch (e) {
      threw = /No valid SimpleAMM address for chain "robinhood"/.test(e.message);
    }
    ok(threw, 'amm-addresses: missing chain entry throws a clear error');
    fs.writeFileSync(partialFile, JSON.stringify({
      robinhood: '0x2222222222222222222222222222222222222222',
    }));
    ok(loadAmmAddress('robinhood', partialFile) === '0x2222222222222222222222222222222222222222',
      'amm-addresses: valid entry loads');

    // 7. Arg validation.
    threw = false;
    try {
      parseArgs(['node', 'volume.js', '--chain', 'arc', '--rounds', '1', '--inflight', '2']);
    } catch (e) {
      threw = /NOT implemented/.test(e.message);
    }
    ok(threw, 'args: --inflight=2 refused (sequential only)');
    threw = false;
    try {
      parseArgs(['node', 'volume.js', '--chain', 'arc', '--rounds', '1', '--live', '--dry-run']);
    } catch (e) {
      threw = /mutually exclusive/.test(e.message);
    }
    ok(threw, 'args: --live + --dry-run refused');
    threw = false;
    try {
      parseArgs(['node', 'volume.js', '--chain', 'mainnet', '--rounds', '1']);
    } catch (e) {
      threw = /--chain must be/.test(e.message);
    }
    ok(threw, 'args: unknown chain refused');

    // 8. Velana chain support (added 2026-11-16; the 3 original chains
    // must keep working exactly as before).
    const velanaArgs = parseArgs(['node', 'volume.js', '--chain', 'velana', '--rounds', '5',
      '--amm-file', path.join(tmpDir, 'amm.json')]);
    ok(velanaArgs.chain === 'velana' && velanaArgs.rounds === 5 &&
      velanaArgs.ammFile === path.join(tmpDir, 'amm.json'),
      'args: --chain velana + --amm-file parse');
    ok(VOLUME.velana.roundSize === ethers.parseUnits('0.0001', 18) &&
      VOLUME.velana.baseSymbol === 'VELA' && VOLUME.velana.legacyTx === true &&
      VOLUME.velana.baseIsNative === true,
      'velana: round size 0.0001 VELA, native base, legacy tx mode');
    ok(VOLUME.arc.deco === DECO && VOLUME.robinhood.deco === DECO && VOLUME.litvm.deco === DECO,
      'volume: the 3 original chains still use the shared DECO address');
    ok(ethers.isAddress(VOLUME.velana.deco) && VOLUME.velana.deco !== DECO,
      'velana: own DECO address, different from the 3-chain address');
    ok(VOLUME_CHAINS.velana.chainId === 484148 && VOLUME_CHAINS.arc.chainId === 5042002 &&
      VOLUME_CHAINS.robinhood.chainId === 46630 && VOLUME_CHAINS.litvm.chainId === 4441,
      'volume chains: velana 484148 added, the 3 originals unchanged');
    const vRunner = new VolumeRunner('velana', 1, { logDir: tmpDir, ammFile: path.join(tmpDir, 'amm.json') });
    vRunner.legacyGasPrice = 7n;
    const vOv = vRunner.txOverrides(9, { value: 123n });
    ok(vOv.type === 0 && vOv.gasPrice === 7n && vOv.nonce === 9 && vOv.value === 123n,
      'velana: txOverrides adds type 0 + gas price, keeps nonce/value');
    const rRunner = new VolumeRunner('robinhood', 1, { logDir: tmpDir, ammFile: path.join(tmpDir, 'amm.json') });
    const rOv = rRunner.txOverrides(9, { value: 123n });
    ok(!('type' in rOv) && !('gasPrice' in rOv) && rOv.nonce === 9 && rOv.value === 123n,
      'robinhood: txOverrides unchanged (plain nonce/value, no legacy fields)');

    console.log(`\nSELF-TEST PASSED (${tmpDir} — cleaned up)`);
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.selfTest) {
    const ok = await selfTest();
    process.exit(ok ? 0 : 1);
  }
  if (args.live) {
    log('*** LIVE MODE requested *** — real testnet transactions will be broadcast. Ctrl-C stops after the current round.');
    const runner = new VolumeRunner(args.chain, args.rounds, args);
    // A socket error escaping as an uncaught exception (Node http stack,
    // not a rejected promise) would otherwise kill the process with NO
    // summary (Robinhood top-up part 1, 2026-11-16: uncaught ECONNRESET
    // after round 124, no summary written). Best-effort: mark the run
    // crashed, write the summary for what did run, then exit non-zero.
    const crashHandler = (e) => {
      console.error(`UNCAUGHT: ${e instanceof Error ? (e.stack || e.message) : e}`);
      const done = () => process.exit(1);
      try {
        runner.stoppedReason = 'crashed';
        if (runner.logger) {
          runner.finish().then(done, done);
          setTimeout(done, 5000); // fallback if finish hangs
        } else {
          done();
        }
      } catch {
        done();
      }
    };
    process.on('uncaughtException', crashHandler);
    process.on('unhandledRejection', crashHandler);
    await runner.run();
  } else {
    await runDry(args.chain, args.rounds, args);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  VOLUME, VOLUME_CHAINS, VELANA_CHAIN, AMM_ABI, ERC20_ABI, SLIPPAGE_BPS,
  amountOutMirror, minOutFor, wouldBreachBudget,
  loadAmmAddress, parseArgs, buildSummary, JsonlLogger, VolumeRunner,
};
