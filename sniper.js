// Testnet-only buy/sell sniper for deco's burner wallet.
// Chains: Arc Testnet (v4), Robinhood Chain Testnet (v4), LitVM (V2 fork).
//
// SAFETY:
// - DRY-RUN IS THE DEFAULT. In dry-run the bot logs exactly what it WOULD
//   send (to, data, value, gas estimate) and never broadcasts, never touches
//   the keystore, never signs anything.
// - Live mode needs BOTH: LIVE.enabled = true in config.js AND the --live
//   flag. Live mode loads the private key from the VM keystore (in memory
//   only) and broadcasts real testnet transactions.
// - Hard testnet-only guard: any chainId outside {5042002, 46630, 4441} is
//   refused before any signing. Mainnet can never reach this bot.
// - Spend caps: per-trade, per-run, max concurrent positions (see config.js).
// - No seed/private key is ever printed, logged, or written by this bot.
//
// MODES:
// - target (default): watch one token (default DECO) until its pool appears,
//   buy once, then manage the position (take-profit / stop-loss / time exit).
// - watch: watch for ANY new pair/pool on the chain's DEX and log it; with
//   --auto-buy, buy new pairs that pass the filters (live only; dry-run logs).
//
// Public RPCs expose no mempool, so the watcher POLLS (factory pair count /
// PoolManager Initialize logs). Expect seconds of latency, not milliseconds
// — see README.md.
//
// Usage:
//   node sniper.js --chain litvm --mode target --token 0x5f1d... --once
//   node sniper.js --chain robinhood --mode watch --duration-seconds 300
//   node sniper.js --chain all --mode target
//   node sniper.js --chain litvm --mode target --live   (needs LIVE.enabled too)
const { ethers } = require('ethers');
const { CHAINS, TRADING, LIVE, BURNER, DECO, ZERO } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const { loadBurnerWallet } = require('./keystore');
const v2 = require('./dex/v2');
const v4 = require('./dex/v4');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    chain: 'litvm', mode: 'target', token: DECO, live: false,
    once: false, autoBuy: false, durationSeconds: 0,
    buyAmount: null, tp: TRADING.takeProfitPct, sl: TRADING.stopLossPct,
    maxHold: TRADING.maxHoldSeconds, slippage: TRADING.slippageBps,
    pollSeconds: TRADING.pollSeconds,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--chain') args.chain = next();
    else if (a === '--mode') args.mode = next();
    else if (a === '--token') args.token = next();
    else if (a === '--live') args.live = true;
    else if (a === '--once') args.once = true;
    else if (a === '--auto-buy') args.autoBuy = true;
    else if (a === '--duration-seconds') args.durationSeconds = Number(next());
    else if (a === '--buy-amount') args.buyAmount = next();
    else if (a === '--tp') args.tp = Number(next());
    else if (a === '--sl') args.sl = Number(next());
    else if (a === '--max-hold') args.maxHold = Number(next());
    else if (a === '--slippage-bps') args.slippage = Number(next());
    else if (a === '--poll-seconds') args.pollSeconds = Number(next());
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else throw new Error(`Unknown argument: ${a} (see --help)`);
  }
  if (!['target', 'watch'].includes(args.mode)) throw new Error(`--mode must be target or watch, got ${args.mode}`);
  if (args.chain !== 'all' && !CHAINS[args.chain]) throw new Error(`--chain must be one of ${Object.keys(CHAINS).join(', ')}, all — got ${args.chain}`);
  if (!ethers.isAddress(args.token)) throw new Error(`--token is not an address: ${args.token}`);
  return args;
}

const USAGE = `
Usage: node sniper.js [options]
  --chain <arc|robinhood|litvm|all>   Chain to run on (default litvm)
  --mode <target|watch>               target: watch one token's pool; watch: any new pair (default target)
  --token <0x...>                     Token to snipe in target mode (default DECO)
  --live                              Trade for real (ALSO needs LIVE.enabled=true in config.js)
  --once                              Run one watch cycle then exit
  --auto-buy                          In watch mode, buy new pairs that pass filters
  --duration-seconds <n>              Stop after n seconds (0 = run forever)
  --buy-amount <x>                    Buy size in native units (or USDC on Arc)
  --tp <pct> --sl <pct>               Take-profit / stop-loss percent (default 100 / 50)
  --max-hold <seconds>                Time-based exit (default 3600)
  --slippage-bps <n>                  Max slippage in basis points (default 500 = 5%)
  --poll-seconds <n>                  Watcher poll interval (default 10)
Dry-run is the default: without --live (+ LIVE.enabled) nothing is broadcast.
`;

function fmt(bi, decimals = 18) {
  return ethers.formatUnits(bi, decimals);
}

class ChainBot {
  constructor(chainKey, chain, args, dryRun) {
    this.key = chainKey;
    this.chain = chain;
    this.args = args;
    this.dryRun = dryRun;
    this.provider = providerFor(chain);
    this.signer = null; // set in live mode only
    this.positions = new Map(); // token -> position
    this.spentNative = 0n;
    this.spentUsdcArc = 0n; // Arc buys are USDC-view amounts, tracked separately
    this.knownPairs = null; // V2 allPairsLength baseline
    this.lastBlock = null; // V4 Initialize-log cursor
    this.stopped = false;
  }

  async init() {
    await assertTestnetChain(this.provider, this.chain);
    if (!this.dryRun) {
      this.signer = loadBurnerWallet(this.provider);
      log(`${this.chain.name}: live mode — signer loaded (burner address verified, key never logged)`);
    } else {
      log(`${this.chain.name}: DRY-RUN — no keystore access, nothing will be broadcast`);
    }
    // Baselines
    if (this.chain.dex.type === 'v2') {
      const { factory } = v2.contracts(this.chain, this.provider);
      this.knownPairs = Number(await factory.allPairsLength());
      log(`${this.chain.name}: V2 factory pairs: ${this.knownPairs}`);
    } else {
      this.lastBlock = await this.provider.getBlockNumber();
      log(`${this.chain.name}: v4 watcher starting at block ${this.lastBlock}`);
    }
    const bal = await this.provider.getBalance(BURNER);
    log(`${this.chain.name}: burner native balance: ${fmt(bal)} ${this.chain.gasToken.symbol}`);
  }

  get actor() { return this.dryRun ? this.provider : this.signer; }

  buyAmountNative() {
    if (this.args.buyAmount) return ethers.parseUnits(this.args.buyAmount, 18);
    if (this.key === 'arc') return ethers.parseUnits(TRADING.arcBuyAmountUsdc, 6); // USDC view, 6 dec
    return ethers.parseUnits(TRADING.buyAmountNative, 18);
  }

  // --- pool / price reads ---
  async poolFor(token) {
    if (this.chain.dex.type === 'v2') return v2.watchPair(this.chain, this.provider, token);
    return v4.watchPool(this.chain, this.provider, token,
      TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  }

  async priceOf(token) {
    if (this.chain.dex.type === 'v2') {
      const pair = await v2.watchPair(this.chain, this.provider, token);
      if (!pair) return null;
      return v2.priceFromReserves(pair, 18); // WETH per DECO, 1e18 scale
    }
    const pool = await v4.watchPool(this.chain, this.provider, token,
      TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
    if (!pool) return null;
    const dec0 = pool.key.currency0.toLowerCase() === this.chain.dex.quoteToken.toLowerCase()
      ? this.chain.dex.quoteTokenDecimals : 18;
    const dec1 = dec0 === this.chain.dex.quoteTokenDecimals ? 18 : this.chain.dex.quoteTokenDecimals;
    // priceToken1InToken0 gives quote-per-DECO when DECO is currency1 (the
    // usual case: quote sorts below DECO on RH (0x0) and Arc (0x3600…)).
    if (pool.key.currency1.toLowerCase() === token.toLowerCase()) {
      return v4.priceToken1InToken0(pool.sqrtPriceX96, dec0, dec1);
    }
    // DECO is currency0 (unusual): invert.
    const p = v4.priceToken1InToken0(pool.sqrtPriceX96, 18, this.chain.dex.quoteTokenDecimals);
    return p ? (10n ** 36n) / p : null;
  }

  // --- trade execution (dry-run logs, live sends) ---
  async execute(label, buildFn) {
    const { tx, ...info } = await buildFn();
    tx.from = BURNER;
    if (this.dryRun) {
      let gas = null;
      try { gas = await this.provider.estimateGas(tx); } catch (e) {
        log(`  [dry-run] ${label}: gas estimate failed (${e.message.slice(0, 120)}) — tx would likely revert; NOT sent`);
      }
      log(`  [dry-run] ${label}: WOULD SEND tx to=${tx.to} value=${tx.value ? fmt(tx.value, this.key === 'arc' ? 6 : 18) : '0'} gas~${gas ?? '?'}`);
      log(`  [dry-run] ${label}: data=${tx.data}`);
      if (info.expectedOut !== undefined) log(`  [dry-run] ${label}: expectedOut=${fmt(info.expectedOut)} minOut=${fmt(info.amountOutMin)}`);
      return { dryRun: true, tx, ...info };
    }
    const sent = await this.signer.sendTransaction(tx);
    log(`  [live] ${label}: sent ${sent.hash} — waiting for receipt…`);
    const receipt = await sent.wait();
    log(`  [live] ${label}: confirmed in block ${receipt.blockNumber} (status ${receipt.status}, gas ${receipt.gasUsed})`);
    return { dryRun: false, tx, receipt, hash: sent.hash, ...info };
  }

  async buy(token) {
    const amountIn = this.buyAmountNative();
    // Spend caps (Arc buys are USDC-view amounts, capped separately).
    if (this.key === 'arc') {
      const capUsdc = ethers.parseUnits(TRADING.maxSpendPerTradeUsdcArc, 6);
      if (amountIn > capUsdc) {
        log(`  buy blocked: amount ${fmt(amountIn, 6)} USDC exceeds per-trade cap ${fmt(capUsdc, 6)} USDC`);
        return null;
      }
      const totalCapUsdc = ethers.parseUnits(TRADING.maxTotalSpendUsdcArc, 6);
      if (this.spentUsdcArc + amountIn > totalCapUsdc) {
        log(`  buy blocked: run USDC cap ${fmt(totalCapUsdc, 6)} would be exceeded`);
        return null;
      }
    } else {
      const cap = ethers.parseUnits(TRADING.maxSpendPerTradeNative, 18);
      if (amountIn > cap) {
        log(`  buy blocked: amount ${fmt(amountIn)} exceeds per-trade cap ${fmt(cap)}`);
        return null;
      }
      const totalCap = ethers.parseUnits(TRADING.maxTotalSpendNative, 18);
      if (this.spentNative + amountIn > totalCap) {
        log(`  buy blocked: run spend cap ${fmt(totalCap)} would be exceeded`);
        return null;
      }
    }
    if (this.positions.size >= TRADING.maxConcurrentPositions) {
      log(`  buy blocked: ${this.positions.size} open positions (max ${TRADING.maxConcurrentPositions})`);
      return null;
    }
    log(`  BUY ${token} on ${this.chain.name} for ${fmt(amountIn, this.key === 'arc' ? 6 : 18)} ${this.key === 'arc' ? 'USDC' : this.chain.gasToken.symbol}`);
    const build = this.chain.dex.type === 'v2'
      ? () => v2.buildBuyTx(this.chain, this.actor, token, amountIn, this.args.slippage, BURNER)
      : () => v4.buildBuyTx(this.chain, this.actor, token, amountIn, this.args.slippage, BURNER,
          TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
    // Live: measure the actual tokens received (balance delta) so the sell
    // later sells ONLY this position. The burner holds its ~920k DECO
    // supply — selling the whole balance (the old sell() behavior) would
    // dump it all into the pool. Same class of bug as the volume.js
    // cleanup incident (2026-11-16); fixed here before the first live run.
    let decoBefore = null;
    if (!this.dryRun) {
      try {
        const erc20 = new ethers.Contract(token, v2.ERC20_ABI, this.provider);
        decoBefore = await erc20.balanceOf(BURNER);
      } catch (e) {
        log(`  buy: pre-buy balance read failed (${e.message.slice(0, 120)}) — will fall back to the quoted output`);
      }
    }
    const res = await this.execute(`buy ${token.slice(0, 10)}…`, build);
    let decoReceived = null;
    if (!this.dryRun && decoBefore !== null) {
      try {
        const erc20 = new ethers.Contract(token, v2.ERC20_ABI, this.provider);
        const decoAfter = await erc20.balanceOf(BURNER);
        decoReceived = decoAfter - decoBefore;
        log(`  buy: received ${fmt(decoReceived)} ${token.slice(0, 10)}… (quoted ${fmt(res.expectedOut ?? 0n)})`);
      } catch (e) {
        log(`  buy: post-buy balance read failed (${e.message.slice(0, 120)}) — will fall back to the quoted output`);
      }
    }
    const entryPrice = await this.priceOf(token);
    this.positions.set(token.toLowerCase(), {
      token, amountIn, expectedOut: res.expectedOut ?? null,
      decoReceived, entryPrice, boughtAt: Date.now(), txHash: res.hash ?? null,
    });
    if (this.key === 'arc') this.spentUsdcArc += amountIn;
    else this.spentNative += amountIn;
    log(`  position opened: entry price ${entryPrice ? fmt(entryPrice) : '?'} (quote per token)`);
    return res;
  }

  async sell(token, reason) {
    const pos = this.positions.get(token.toLowerCase());
    if (!pos) return null;
    log(`  SELL ${token} on ${this.chain.name} — ${reason}`);
    // How much do we sell? ONLY this position's tokens (measured at buy
    // time, falling back to the quoted buy output). NEVER the whole wallet
    // balance: the burner holds its ~920k DECO supply, and selling the
    // balance would dump it all into the pool (fixed 2026-11-16 before
    // the first live run — the old code sold balanceOf(BURNER)).
    let amountIn;
    if (this.dryRun) {
      amountIn = pos.expectedOut ?? 0n;
      if (amountIn === 0n) { log('  [dry-run] no quoted buy output to sell — skipping'); return null; }
    } else {
      amountIn = pos.decoReceived ?? pos.expectedOut ?? 0n;
      if (amountIn === 0n) {
        log('  live: no recorded position size — refusing to sell blind');
        this.positions.delete(token.toLowerCase());
        return null;
      }
      const erc20 = new ethers.Contract(token, v2.ERC20_ABI, this.provider);
      const bal = await erc20.balanceOf(BURNER);
      if (bal < amountIn) {
        // Wallet holds less than the position (tokens moved out?) — sell
        // what is there; this is bounded by the position size, never more.
        log(`  live: balance ${fmt(bal)} < position size ${fmt(amountIn)} — selling the balance instead`);
        amountIn = bal;
      }
      log(`  live: selling position size ${fmt(amountIn)} (wallet balance ${fmt(bal)})`);
    }
    // Allowance: V2 router / Permit2 (v4). Approve first if needed.
    if (this.chain.dex.type === 'v2') {
      const allow = await v2.allowance(this.chain, this.provider, token, BURNER, this.chain.dex.router);
      if (allow < amountIn) {
        await this.execute(`approve router for ${token.slice(0, 10)}…`,
          () => v2.buildApproveTx(this.chain, this.actor, token, this.chain.dex.router, amountIn));
      }
    } else {
      const allow = await v4.permit2Allowance(this.chain, this.provider, token, BURNER);
      if (allow < amountIn) {
        await this.execute(`approve Permit2 for ${token.slice(0, 10)}…`,
          () => v4.buildPermit2ApproveTx(this.chain, this.actor, token, amountIn));
      }
    }
    const build = this.chain.dex.type === 'v2'
      ? () => v2.buildSellTx(this.chain, this.actor, token, amountIn, this.args.slippage, BURNER)
      : () => v4.buildSellTx(this.chain, this.actor, token, amountIn, this.args.slippage, BURNER,
          TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
    const res = await this.execute(`sell ${token.slice(0, 10)}… (${reason})`, build);
    this.positions.delete(token.toLowerCase());
    return res;
  }

  // --- position management: TP / SL / time exit ---
  async managePositions() {
    for (const [key, pos] of [...this.positions.entries()]) {
      const price = await this.priceOf(pos.token);
      if (price === null || pos.entryPrice === null) continue;
      const changeBps = Number(((price - pos.entryPrice) * 10000n) / pos.entryPrice);
      const heldSec = (Date.now() - pos.boughtAt) / 1000;
      log(`  position ${pos.token.slice(0, 10)}…: ${changeBps >= 0 ? '+' : ''}${(changeBps / 100).toFixed(2)}% held ${heldSec.toFixed(0)}s`);
      if (changeBps >= this.args.tp * 100) await this.sell(pos.token, `take-profit +${(changeBps / 100).toFixed(1)}%`);
      else if (changeBps <= -this.args.sl * 100) await this.sell(pos.token, `stop-loss ${(changeBps / 100).toFixed(1)}%`);
      else if (heldSec >= this.args.maxHold) await this.sell(pos.token, `max hold ${this.args.maxHold}s reached`);
    }
  }

  // --- watch cycles ---
  async targetCycle() {
    const token = this.args.token;
    if (this.positions.has(token.toLowerCase())) { await this.managePositions(); return; }
    const pool = await this.poolFor(token);
    if (!pool) {
      log(`${this.chain.name}: no pool for ${token.slice(0, 10)}… yet — watching`);
      return;
    }
    log(`${this.chain.name}: pool found for ${token.slice(0, 10)}… — buying`);
    await this.buy(token);
  }

  async watchCycle() {
    if (this.chain.dex.type === 'v2') {
      const { count, fresh } = await v2.scanNewPairs(this.chain, this.provider, this.knownPairs);
      this.knownPairs = count;
      for (const p of fresh) {
        log(`${this.chain.name}: NEW PAIR #${p.index} ${p.pair} token0=${p.token0} token1=${p.token1} reserves=${fmt(p.reserve0)}/${fmt(p.reserve1)}`);
        if (this.args.autoBuy) {
          // Only auto-buy pairs with real liquidity on both sides.
          if (p.reserve0 > 0n && p.reserve1 > 0n) {
            const target = p.token0.toLowerCase() === this.chain.dex.weth.toLowerCase() ? p.token1 : p.token0;
            await this.buy(target);
          } else log('  skipped auto-buy: empty reserves');
        }
      }
      if (!fresh.length) log(`${this.chain.name}: no new pairs (total ${count})`);
    } else {
      const tip = await this.provider.getBlockNumber();
      const { pools, nextFrom } = await v4.scanNewPools(this.chain, this.provider, this.lastBlock, tip);
      this.lastBlock = nextFrom;
      for (const p of pools) {
        log(`${this.chain.name}: NEW POOL ${p.poolId} c0=${p.currency0} c1=${p.currency1} fee=${p.fee} tickSpacing=${p.tickSpacing} hooks=${p.hooks} (block ${p.block})`);
        if (this.args.autoBuy) {
          const target = p.currency0 === ZERO ? p.currency1 : p.currency0;
          await this.buy(target);
        }
      }
      if (!pools.length) log(`${this.chain.name}: no new pools (scanned to block ${tip})`);
    }
    await this.managePositions();
  }

  async run() {
    await this.init();
    const started = Date.now();
    for (;;) {
      if (this.stopped) break;
      try {
        if (this.args.mode === 'target') await this.targetCycle();
        else await this.watchCycle();
      } catch (e) {
        log(`${this.chain.name}: cycle error: ${e.message.slice(0, 300)}`);
      }
      if (this.args.once) break;
      if (this.args.durationSeconds && (Date.now() - started) / 1000 >= this.args.durationSeconds) break;
      await new Promise((r) => setTimeout(r, this.args.pollSeconds * 1000));
    }
    log(`${this.chain.name}: stopped (${this.positions.size} open positions — run again to manage them)`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !(args.live && LIVE.enabled);
  if (args.live && !LIVE.enabled) {
    log('WARNING: --live passed but LIVE.enabled is false in config.js — staying in DRY-RUN.');
  }
  if (!dryRun) {
    log('*** LIVE MODE *** — real testnet transactions will be broadcast. Ctrl-C to stop.');
  }
  const keys = args.chain === 'all' ? Object.keys(CHAINS) : [args.chain];
  const bots = keys.map((k) => new ChainBot(k, CHAINS[k], args, dryRun));
  await Promise.all(bots.map((b) => b.run()));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
