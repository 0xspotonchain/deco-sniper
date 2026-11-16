// Dry-run test harness: proves the sniper connects to all three chains,
// reads live state, and runs the full trade pipeline WITHOUT broadcasting
// anything or touching the keystore.
//
// Run: node dryrun.js
// Exit 0 when every check passes (a "pool not found yet" result is a PASS —
// it means the watcher correctly reports the DECO pools don't exist yet).
const { ethers } = require('ethers');
const { CHAINS, TRADING, BURNER, DECO, ALLOWED_CHAIN_IDS, ZERO } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const v2 = require('./dex/v2');
const v4 = require('./dex/v4');

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// A live LitVM V2 pair used to prove the quote -> build pipeline end to end
// (DECO has no pool yet, so the pipeline is exercised against real liquidity).
const LITVM_LIVE_TOKEN = '0xf143ecfe3dfeeb4ae188ca4f1c7c7ab0b5f592eb'; // paired vs WETH, pair[1]
// Live v4 poolIds observed in Swap logs (probe5) — used for StateView reads.
const LIVE_POOL_IDS = {
  arc: '0x933354b1699d786359c64068bf008a698e2cbd3e1a32f2cda4efcf147614d152',
  robinhood: '0xad46061426962ce3cdd72f85d73d5b904c2f76136162be56dc8e63e843848142',
};

async function main() {
  console.log('=== Sniper dry-run test — no broadcasts, no keystore access ===\n');

  // 0. Guard unit checks (no network needed)
  check('allowlist excludes mainnets',
    !ALLOWED_CHAIN_IDS.includes(1) && !ALLOWED_CHAIN_IDS.includes(4663) && !ALLOWED_CHAIN_IDS.includes(5042),
    `allowed: ${ALLOWED_CHAIN_IDS.join(', ')}`);
  check('price math: sqrtPrice 2^96, 18/18 dec => 1e18',
    v4.priceToken1InToken0(2n ** 96n, 18, 18) === 10n ** 18n);
  check('price math: sqrtPrice 2^96, 6/18 dec => 1e30',
    v4.priceToken1InToken0(2n ** 96n, 6, 18) === 10n ** 30n);
  // V4 swap encoding round-trip (pure function, no chain)
  const key = v4.poolKeyFor(CHAINS.robinhood, DECO, 3000, 60, ZERO);
  const { commands, inputs } = v4.encodeV4Swap(key, true, 1000n, 900n);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const actionsOk = actions === '0x060c0f';
  const [decodedKey, decodedZfo, decodedIn, decodedMin] = coder.decode(
    ['(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'], params[0]);
  const singleOk = decodedKey[0].toLowerCase() === key.currency0.toLowerCase()
    && decodedKey[1].toLowerCase() === key.currency1.toLowerCase()
    && decodedZfo === true && decodedIn === 1000n && decodedMin === 900n;
  check('v4 UniversalRouter encoding round-trips', commands === '0x10' && actionsOk && singleOk,
    `actions=${actions} amountIn=${decodedIn} minOut=${decodedMin}`);
  // PoolId consistency: same key construction as probe5 (independent run)
  // produced 0x0c6d73c11e075cd1… for the RH DECO/ETH 3000/60 pool.
  check('v4 DECO poolId (RH, ETH/DECO 3000/60) matches probe5',
    v4.poolId(key).startsWith('0x0c6d73c11e075cd1'),
    `poolId=${v4.poolId(key)}`);

  // 1. Per-chain: connect, verify chainId, read balances
  for (const [ck, chain] of Object.entries(CHAINS)) {
    console.log(`\n--- ${chain.name} ---`);
    const provider = providerFor(chain);
    try {
      const id = await assertTestnetChain(provider, chain);
      check(`${chain.name}: chainId verified`, id === chain.chainId, `chainId=${id}`);
    } catch (e) { check(`${chain.name}: chainId verified`, false, e.message); continue; }
    // Guard negative test: the same provider must refuse a wrong chainId.
    try {
      await assertTestnetChain(provider, { name: 'fake', chainId: 1 });
      check(`${chain.name}: guard refuses wrong chainId`, false, 'no error thrown');
    } catch { check(`${chain.name}: guard refuses wrong chainId`, true); }
    const block = await provider.getBlockNumber();
    const bal = await provider.getBalance(BURNER);
    console.log(`  block ${block}, burner native balance ${ethers.formatEther(bal)} ${chain.gasToken.symbol}`);
    const deco = new ethers.Contract(DECO, ['function balanceOf(address) view returns (uint256)'], provider);
    const decoBal = await deco.balanceOf(BURNER);
    check(`${chain.name}: DECO balance readable`, decoBal === 1000000n * 10n ** 18n,
      `${ethers.formatEther(decoBal)} DECO`);

    if (chain.dex.type === 'v2') {
      // Watcher: pair count + DECO pair (expect none yet)
      const { factory } = v2.contracts(chain, provider);
      const count = Number(await factory.allPairsLength());
      check(`${chain.name}: V2 factory readable`, count >= 852, `allPairsLength=${count} (852 at research time)`);
      const decoPair = await v2.watchPair(chain, provider, DECO);
      check(`${chain.name}: DECO/WETH pair correctly reported missing`, decoPair === null);
      // Full pipeline against the LIVE pair: quote -> build buy -> build sell
      const amountIn = ethers.parseEther('0.001');
      const out = await v2.quoteBuy(chain, provider, LITVM_LIVE_TOKEN, amountIn);
      check(`${chain.name}: quote buy 0.001 zkLTC -> token`, out > 0n, `out=${ethers.formatEther(out)}`);
      const buy = await v2.buildBuyTx(chain, provider, LITVM_LIVE_TOKEN, amountIn, 500, BURNER);
      check(`${chain.name}: build buy tx`, buy.tx.to.toLowerCase() === chain.dex.router.toLowerCase()
        && buy.tx.value === amountIn, `to=router value=0.001 minOut=${ethers.formatEther(buy.amountOutMin)}`);
      buy.tx.from = BURNER;
      try {
        const gas = await provider.estimateGas(buy.tx);
        check(`${chain.name}: buy tx gas-estimates (would execute)`, gas > 0n, `gas~${gas}`);
      } catch (e) { check(`${chain.name}: buy tx gas-estimates`, false, e.message.slice(0, 100)); }
      const sell = await v2.buildSellTx(chain, provider, LITVM_LIVE_TOKEN, out, 500, BURNER);
      check(`${chain.name}: build sell tx`, sell.tx.to.toLowerCase() === chain.dex.router.toLowerCase(),
        `expectedOut=${ethers.formatEther(sell.expectedOut)} zkLTC`);
      const price = v2.priceFromReserves(await v2.watchPair(chain, provider, LITVM_LIVE_TOKEN), 18);
      check(`${chain.name}: live-pair price readable`, price !== null && price > 0n,
        `WETH per token=${ethers.formatEther(price)}`);
    } else {
      // V4: DECO pool watch (expect uninitialized), StateView on a live pool,
      // Initialize-log scan, Quoter behavior on the missing pool.
      const pool = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
      check(`${chain.name}: DECO pool correctly reported uninitialized`, pool === null);
      const sv = new ethers.Contract(chain.dex.stateView, v4.STATE_VIEW_ABI, provider);
      const slot0 = await sv.getSlot0(LIVE_POOL_IDS[ck]);
      check(`${chain.name}: StateView reads live pool`, slot0[0] > 0n,
        `sqrtPriceX96=${slot0[0].toString().slice(0, 20)}… tick=${slot0[1]}`);
      const tip = await provider.getBlockNumber();
      const { pools } = await v4.scanNewPools(chain, provider, tip - 500, tip);
      check(`${chain.name}: Initialize-log scan works`, Array.isArray(pools),
        `${pools.length} new pools in last 500 blocks`);
      try {
        await v4.quoteExactInputSingle(chain, provider, DECO, true, 1000n,
          TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
        check(`${chain.name}: Quoter on missing DECO pool`, false, 'unexpectedly returned a quote');
      } catch {
        check(`${chain.name}: Quoter on missing DECO pool reverts (expected)`, true);
      }
      if (chain.dex.universalRouter) {
        // Encoding-only check (quoter would revert, so build the calldata
        // directly and verify its shape).
        const k = v4.poolKeyFor(chain, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
        const enc = v4.encodeV4Swap(k, true, ethers.parseEther('0.001'), 1n);
        check(`${chain.name}: V4_SWAP calldata encodes`, enc.commands === '0x10' && enc.inputs.length === 1);
      } else {
        try {
          await v4.buildBuyTx(chain, provider, DECO, 1000n, 500, BURNER,
            TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
          check(`${chain.name}: Arc buy correctly blocked (no router)`, false, 'no error thrown');
        } catch (e) {
          check(`${chain.name}: Arc buy correctly blocked (no router)`, /no UniversalRouter/.test(e.message));
        }
      }
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
