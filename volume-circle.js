// Volume-mode sniper for the CIRCLE wallet's DM/USDC SimpleAMM pool on Arc
// Testnet. Same discipline as volume.js (buy then sell back each round,
// reconcile balances exactly, log every tx) but the Circle wallet is a
// smart-contract account: every write goes through `circle wallet execute`
// (bundler userOp), so each round is ~2 CLI calls at ~8s each.
//
// One round = buy 0.1 USDC of DM, then sell back exactly the DM received.
// Round size mirrors the burner Arc runs (0.1 USDC, ERC-20 view, 6 dec).
//
// Safety:
// - Arc testnet only (chainId guard 5042002). Never mainnet.
// - Gas pre-check: abort if gas price > 100 gwei (same rule as the daily cron).
// - Budget guard: abort if Circle USDC view balance < 55 (hard floor is 50).
// - A failed buy/sell is logged, never blindly retried: a CLI failure does
//   NOT mean the tx didn't land. After any failed write the runner re-reads
//   the DM balance — if the buy landed anyway it sells the DM back at once;
//   if the sell landed anyway it recovers the tx hash from the pool's Swap
//   events and skips the retry. A sell that genuinely didn't land gets ONE
//   recovery sell with a fresh quote; if that fails the run STOPS so the
//   wallet never accumulates unbalanced round DM silently.
//   LESSON (round 61, 2026-11-16): the original code retried a sell
//   blindly after a CLI reporting failure — the first sell HAD landed, so
//   the retry sold the same 98.36 DM twice (both txs verified on-chain via
//   Swap events). Never retry a CLI-failed write without checking on-chain
//   state first.
// - The CLI-reported networkFee is NOT deducted from the Circle wallet's
//   balance on Arc testnet (verified 2026-11-16: balance moved only by the
//   10 USDC seed across 5 txs); it is logged for the record only.
//
// Usage:
//   node volume-circle.js --rounds <N> [--pool <addr>] [--start-round <N>]
//   --start-round resumes an interrupted run: rounds <N>..--rounds run and
//   append to the same jsonl (a resumed segment writes its own summary;
//   the jsonl is the full record). After a crash, reconcile on-chain first:
//   a buy whose CLI call was killed may still have landed — sell it back
//   exactly before resuming (see the 2026-11-16 round-8 recovery).
// Logs: volume-logs/2026-11-16-circle-dm.jsonl + summary JSON next to it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ethers } = require('ethers');

const DIR = __dirname;
const RPC = 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002;
const CIRCLE = '0xc7d81269debced5e62069a4d42950965853aa300';
const DM = '0x104a92386b4a7ddbfb35214b72ddbb8ed0134438';
const USDC_VIEW = '0x3600000000000000000000000000000000000000'; // 6 dec
const DEFAULT_POOL = '0x53661d12527e02019d991d2f24bf4b6661a96ba7';
const CLI = path.join(process.env.HOME, 'workspace/circle-agent-wallet/node_modules/.bin/circle');
const CLI_CWD = path.join(process.env.HOME, 'workspace/circle-agent-wallet');
const BUY_SIZE = 100000n; // 0.1 USDC (6 dec)
const SLIPPAGE_BPS = 9500; // 95% minOut (5% tolerance)
const MAX_GAS_GWEI = 100n;
const MIN_USDC = 55n * 10n ** 6n; // abort below 55 USDC view balance
const EXPLORER = 'https://explorer.testnet.arc.io';

const AMM_ABI = [
  'function getAmountOut(uint256,uint256,uint256) view returns (uint256)',
  'function getReserves() view returns (uint256,uint256)',
  'event Swap(address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { rounds: null, pool: DEFAULT_POOL, startRound: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rounds') out.rounds = Number(args[++i]);
    else if (args[i] === '--pool') out.pool = args[++i];
    else if (args[i] === '--start-round') out.startRound = Number(args[++i]);
  }
  if (!Number.isInteger(out.rounds) || out.rounds < 1 || out.rounds > 1000) {
    throw new Error('--rounds must be an integer between 1 and 1000');
  }
  if (!Number.isInteger(out.startRound) || out.startRound < 1 || out.startRound > out.rounds) {
    throw new Error('--start-round must be an integer between 1 and --rounds');
  }
  return out;
}

// Run one `circle wallet execute` and return { ok, txHash, networkFee, raw }.
// Never throws for a CLI-level failure: returns ok:false with the raw output.
function circleExecute(sig, params, contract) {
  const argv = ['wallet', 'execute', sig, ...params.map(String),
    '--contract', contract, '--address', CIRCLE, '--chain', 'ARC-TESTNET', '--output', 'json'];
  const started = Date.now();
  const res = spawnSync(CLI, argv, {
    cwd: CLI_CWD,
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  const ms = Date.now() - started;
  const out = (res.stdout || '') + (res.stderr || '');
  const jsonStart = out.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(out.slice(jsonStart));
      const d = parsed.data || {};
      if (d.state === 'COMPLETE' && d.txHash) {
        return { ok: true, txHash: d.txHash, networkFee: d.networkFee || '0', ms, raw: out.slice(0, 500) };
      }
      return { ok: false, error: `state=${d.state || '?'} txHash=${d.txHash || 'none'}`, ms, raw: out.slice(0, 500) };
    } catch (e) { /* fall through */ }
  }
  return { ok: false, error: `CLI exit ${res.status} / unparsable output`, ms, raw: out.slice(0, 500) };
}

async function main() {
  const { rounds, pool, startRound } = parseArgs();
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`Chain guard: RPC reports ${net.chainId}, expected ${CHAIN_ID}`);
  const amm = new ethers.Contract(pool, AMM_ABI, provider);
  const dm = new ethers.Contract(DM, ERC20_ABI, provider);
  const usdc = new ethers.Contract(USDC_VIEW, ERC20_ABI, provider);

  const logPath = path.join(DIR, 'volume-logs', '2026-11-16-circle-dm.jsonl');
  // A resumed segment writes its own summary; the jsonl is the full record.
  const summaryPath = path.join(DIR, 'volume-logs', startRound > 1
    ? '2026-11-16-circle-dm-summary-resume.json'
    : '2026-11-16-circle-dm-summary.json');
  const log = (obj) => fs.appendFileSync(logPath, JSON.stringify(obj) + '\n');

  // Find the round's swap tx in the pool's Swap events, anchored at the
  // block the round started in. Rounds are sequential, so the first
  // matching event at/after that block is this round's. Used to recover tx
  // hashes the CLI failed to report (round 8 buy, round 61 sell).
  async function findSwapTx(fromBlock, isBuy) {
    const events = await amm.queryFilter(amm.filters.Swap(CIRCLE), fromBlock, 'latest');
    const match = events.find((e) => e.args.isBuy === isBuy);
    return match ? match.transactionHash : null;
  }

  // Sell an exact DM amount at a fresh quote (used by recovery paths).
  async function sellAmount(dmAmount) {
    const [rD, rB] = await amm.getReserves();
    const q = await amm.getAmountOut(dmAmount, rD, rB);
    return circleExecute('sell(uint256,uint256)', [dmAmount.toString(), ((q * BigInt(SLIPPAGE_BPS)) / 10000n).toString()], pool);
  }

  const [decoAddr, quoteAddr] = await Promise.all([
    new ethers.Contract(pool, ['function deco() view returns (address)'], provider).deco(),
    new ethers.Contract(pool, ['function quote() view returns (address)'], provider).quote(),
  ]);
  if (decoAddr.toLowerCase() !== DM.toLowerCase() || quoteAddr.toLowerCase() !== USDC_VIEW.toLowerCase()) {
    throw new Error(`Pool token mismatch: deco=${decoAddr} quote=${quoteAddr}`);
  }

  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? fee.maxFeePerGas;
  if (gp && gp > MAX_GAS_GWEI * 10n ** 9n) throw new Error(`Gas price ${ethers.formatUnits(gp, 'gwei')} gwei > ${MAX_GAS_GWEI} gwei — aborting (spike guard)`);

  const startDm = await dm.balanceOf(CIRCLE);
  const startUsdc = await usdc.balanceOf(CIRCLE);
  if (startUsdc < MIN_USDC) throw new Error(`USDC view balance ${ethers.formatUnits(startUsdc, 6)} < 55 — aborting (budget guard)`);
  const [rDeco0, rBase0] = await amm.getReserves();
  console.log(`Circle pool ${pool} | start DM ${ethers.formatUnits(startDm, 18)} | start USDC ${ethers.formatUnits(startUsdc, 6)} | reserves ${ethers.formatUnits(rDeco0, 18)} DM / ${ethers.formatUnits(rBase0, 6)} USDC | gas ${ethers.formatUnits(gp, 'gwei')} gwei`);

  const stats = {
    chain: 'arc-circle', pool, roundsPlanned: rounds - startRound + 1, startRound, roundsCompleted: 0, roundsFailed: 0,
    txs: 0, boughtUsdc: 0n, soldUsdc: 0n, boughtDm: 0n, soldDm: 0n,
    networkFees: 0n, firstTx: null, lastTx: null, startedAt: new Date().toISOString(),
    startDm: startDm.toString(), startUsdc: startUsdc.toString(),
  };
  const writeSummary = (endedAt) => {
    stats.endedAt = endedAt || new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify({
      ...stats,
      boughtUsdc: stats.boughtUsdc.toString(), soldUsdc: stats.soldUsdc.toString(),
      boughtDm: stats.boughtDm.toString(), soldDm: stats.soldDm.toString(),
      networkFees: stats.networkFees.toString(),
    }, null, 2) + '\n');
  };
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (!stopping) { stopping = true; console.log(`\n${sig} — writing summary and stopping after the current round.`); } });
  }

  for (let round = startRound; round <= rounds; round++) {
    if (stopping) { console.log('Stopped early by signal.'); break; }
    const t0 = Date.now();
    const entry = { round, ts: new Date().toISOString() };
    try {
      const roundStartBlock = await provider.getBlockNumber();
      // Re-check guards every 10 rounds (cheap reads).
      if (round % 10 === 1) {
        const feeNow = await provider.getFeeData();
        const gpNow = feeNow.gasPrice ?? feeNow.maxFeePerGas;
        if (gpNow && gpNow > MAX_GAS_GWEI * 10n ** 9n) { console.log(`Round ${round}: gas spiked to ${ethers.formatUnits(gpNow, 'gwei')} gwei — stopping.`); entry.stopped = 'gas-spike'; log(entry); break; }
        const usdcNow = await usdc.balanceOf(CIRCLE);
        if (usdcNow < MIN_USDC) { console.log(`Round ${round}: USDC ${ethers.formatUnits(usdcNow, 6)} < 55 — stopping.`); entry.stopped = 'budget'; log(entry); break; }
      }
      const [rDeco, rBase] = await amm.getReserves();
      const quotedOut = await amm.getAmountOut(BUY_SIZE, rBase, rDeco);
      const minOut = (quotedOut * BigInt(SLIPPAGE_BPS)) / 10000n;
      const dmBefore = await dm.balanceOf(CIRCLE);

      const buy = circleExecute('buy(uint256,uint256)', [BUY_SIZE.toString(), minOut.toString()], pool);
      if (!buy.ok) {
        // CLI failure != tx failure: the buy may have landed anyway (round
        // 8: the CLI was killed mid-call but the buy executed). Check the
        // balance — if DM arrived, sell it back at once and mark recovered.
        const dmCheck = await dm.balanceOf(CIRCLE);
        if (dmCheck > dmBefore) {
          const landed = dmCheck - dmBefore;
          console.log(`Round ${round}: buy CLI failed but ${ethers.formatUnits(landed, 18)} DM landed — selling it back.`);
          const usdcBeforeBack = await usdc.balanceOf(CIRCLE);
          const back = await sellAmount(landed);
          if (back.ok) {
            entry.buyTx = await findSwapTx(roundStartBlock, true);
            entry.dmReceived = landed.toString();
            entry.sellTx = back.txHash;
            entry.usdcReceived = ((await usdc.balanceOf(CIRCLE)) - usdcBeforeBack).toString();
            stats.txs += 2; stats.firstTx = stats.firstTx || entry.buyTx; stats.lastTx = back.txHash;
            stats.boughtUsdc += BUY_SIZE; stats.boughtDm += landed;
            stats.soldUsdc += BigInt(entry.usdcReceived); stats.soldDm += landed;
            entry.status = 'recovered'; entry.ms = Date.now() - t0;
            stats.roundsCompleted++; log(entry);
            console.log(`Round ${round}: recovered (buy landed despite CLI failure, sold back).`);
            continue;
          }
          entry.status = 'buy-landed-sellback-failed'; entry.error = back.error;
          entry.dmReceived = landed.toString();
          stats.roundsFailed++; log(entry);
          console.log(`Round ${round}: buy landed but sell-back failed — ${ethers.formatUnits(landed, 18)} DM stays in the wallet. Stopping.`);
          break;
        }
        entry.status = 'buy-failed'; entry.error = buy.error; stats.roundsFailed++; log(entry);
        console.log(`Round ${round}: BUY FAILED (${buy.error})`); continue;
      }
      stats.txs++; stats.firstTx = stats.firstTx || buy.txHash; stats.lastTx = buy.txHash;
      if (buy.networkFee) stats.networkFees += ethers.parseUnits(buy.networkFee, 18);
      entry.buyTx = buy.txHash;

      const dmAfterBuy = await dm.balanceOf(CIRCLE);
      const dmReceived = dmAfterBuy - dmBefore;
      if (dmReceived <= 0n) { entry.status = 'buy-no-delta'; entry.error = 'DM balance did not increase after buy'; stats.roundsFailed++; log(entry); console.log(`Round ${round}: BUY landed but no DM delta — stopping.`); break; }
      entry.dmReceived = dmReceived.toString();
      stats.boughtUsdc += BUY_SIZE; stats.boughtDm += dmReceived;

      const [rDeco2, rBase2] = await amm.getReserves();
      const quotedBack = await amm.getAmountOut(dmReceived, rDeco2, rBase2);
      const minBack = (quotedBack * BigInt(SLIPPAGE_BPS)) / 10000n;
      const usdcBefore = await usdc.balanceOf(CIRCLE);
      let sell = circleExecute('sell(uint256,uint256)', [dmReceived.toString(), minBack.toString()], pool);
      if (!sell.ok) {
        // CLI failure != tx failure: the sell may have landed (round 61:
        // it HAD, and a blind retry sold the same DM twice). Check the
        // balance first — if the DM is gone, the sell landed; recover its
        // tx hash from the pool's Swap events and skip the retry.
        console.log(`Round ${round}: sell failed (${sell.error}) — checking whether it landed on-chain before any recovery.`);
        const dmNow = await dm.balanceOf(CIRCLE);
        if (dmNow <= dmBefore) {
          const recoveredTx = await findSwapTx(roundStartBlock, false);
          if (recoveredTx) {
            sell = { ok: true, txHash: recoveredTx };
            entry.sellRecovered = 'cli-unreported';
            console.log(`Round ${round}: sell HAD landed on-chain (tx ${recoveredTx}) — no retry.`);
          }
        }
        if (!sell.ok) {
          // ONE recovery sell with a fresh quote, then stop if it fails.
          console.log(`Round ${round}: sell genuinely missing — one recovery attempt with a fresh quote.`);
          sell = await sellAmount(dmReceived);
          entry.sellRecovered = sell.ok;
        }
      }
      if (!sell.ok) {
        entry.status = 'sell-failed'; entry.error = sell.error; stats.roundsFailed++; log(entry);
        console.log(`Round ${round}: SELL FAILED twice — ${ethers.formatUnits(dmReceived, 18)} DM stays in the wallet. Stopping the run.`);
        break;
      }
      stats.txs++; stats.lastTx = sell.txHash;
      if (sell.networkFee) stats.networkFees += ethers.parseUnits(sell.networkFee, 18);
      entry.sellTx = sell.txHash;
      const usdcAfter = await usdc.balanceOf(CIRCLE);
      const usdcReceived = usdcAfter - usdcBefore;
      entry.usdcReceived = usdcReceived.toString();
      stats.soldUsdc += usdcReceived; stats.soldDm += dmReceived;
      entry.status = 'ok'; entry.ms = Date.now() - t0;
      stats.roundsCompleted++;
      log(entry);
      if (round % 10 === 0 || round === rounds) {
        console.log(`Round ${round}/${rounds} ok — bought ${ethers.formatUnits(stats.boughtUsdc, 6)} USDC / sold ${ethers.formatUnits(stats.soldUsdc, 6)} USDC so far (${((Date.now() - t0) / 1000).toFixed(0)}s this round)`);
      }
    } catch (e) {
      entry.status = 'error'; entry.error = e.message.slice(0, 300); stats.roundsFailed++; log(entry);
      console.log(`Round ${round}: ERROR ${e.message.slice(0, 200)}`);
    }
  }

  const endDm = await dm.balanceOf(CIRCLE);
  const endUsdc = await usdc.balanceOf(CIRCLE);
  const [rDecoEnd, rBaseEnd] = await amm.getReserves();
  stats.endDm = endDm.toString(); stats.endUsdc = endUsdc.toString();
  stats.dmDelta = (endDm - startDm).toString();
  stats.usdcDelta = (endUsdc - startUsdc).toString();
  stats.reservesEnd = { deco: rDecoEnd.toString(), base: rBaseEnd.toString() };
  writeSummary();
  console.log(`\nDone: ${stats.roundsCompleted}/${rounds} rounds, ${stats.roundsFailed} failed, ${stats.txs} txs.`);
  console.log(`DM delta: ${ethers.formatUnits(endDm - startDm, 18)} (expect 0) | USDC delta: ${ethers.formatUnits(endUsdc - startUsdc, 6)} (gas is not deducted; expect only slippage/fees, ~-0.0006/round).`);
  console.log(`Reserves end: ${ethers.formatUnits(rDecoEnd, 18)} DM / ${ethers.formatUnits(rBaseEnd, 6)} USDC.`);
  console.log(`Log: ${logPath}\nSummary: ${summaryPath}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
