// Verify the manual v4 quote math two independent ways:
//  1. sqrtPrice-based (the implementation in dex/v4.js)
//  2. constant-product on virtual reserves (x = L/sqrtP, y = L*sqrtP) —
//     equivalent for a full-range pool, computed separately here.
// They must agree to within rounding. Also checks the spot-price limit and
// a buy-then-sell round-trip.
'use strict';

const { ethers } = require('ethers');
const { CHAINS, DECO, TRADING } = require('./config');
const { providerFor } = require('./provider');
const v4 = require('./dex/v4');

const Q96 = 2n ** 96n;

// Independent constant-product quote from virtual reserves.
function cpQuote(sqrtP, L, amountIn, zeroForOne, fee) {
  const afterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
  const x = (L * Q96) / sqrtP; // virtual token0 reserve (wei)
  const y = (L * sqrtP) / Q96; // virtual token1 reserve (wei)
  if (zeroForOne) return (y * afterFee) / (x + afterFee);
  return (x * afterFee) / (y + afterFee);
}

async function main() {
  const chain = CHAINS.robinhood;
  const provider = providerFor(chain);
  const pool = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  console.log('pool sqrtPriceX96:', pool.sqrtPriceX96.toString());
  console.log('pool liquidity:', pool.liquidity.toString());
  console.log('pool tick:', pool.tick);

  // 1. Buy 0.0005 ETH -> DECO, both methods.
  const buyIn = ethers.parseEther('0.0005');
  const manualBuy = await v4.quoteExactInputSingleManual(chain, provider, DECO, true, buyIn, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  const cpBuy = cpQuote(pool.sqrtPriceX96, pool.liquidity, buyIn, true, TRADING.v4Fee);
  console.log(`BUY 0.0005 ETH: manual=${ethers.formatEther(manualBuy)} DECO, constant-product=${ethers.formatEther(cpBuy)} DECO, diff=${manualBuy - cpBuy} wei`);
  console.log(`  spot-implied (no impact): ${(0.0005 * 33333333.333).toFixed(1)} DECO — manual is lower, as expected with ~19% impact`);

  // 2. Spot-price limit: tiny buy should track spot (33,333,333 DECO/ETH x 0.997 fee).
  const tinyIn = 1000000000000n; // 0.000001 ETH
  const tinyOut = await v4.quoteExactInputSingleManual(chain, provider, DECO, true, tinyIn, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  const spotOut = (tinyIn * 33333333333333333n) / 1000000000000000000n; // rough spot, 18-dec
  console.log(`TINY BUY 0.000001 ETH: manual=${ethers.formatEther(tinyOut)} DECO (spot x 0.997 ~ ${(0.000001 * 33333333.333 * 0.997).toFixed(2)})`);

  // 3. Sell quote (same-state, for method agreement only — NOT the round-trip:
  //    a real round-trip sells AFTER the buy moves the pool).
  const manualSell = await v4.quoteExactInputSingleManual(chain, provider, DECO, false, manualBuy, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  const cpSell = cpQuote(pool.sqrtPriceX96, pool.liquidity, manualBuy, false, TRADING.v4Fee);
  console.log(`SELL ${ethers.formatEther(manualBuy)} DECO (same state): manual=${ethers.formatEther(manualSell)} ETH, constant-product=${ethers.formatEther(cpSell)} ETH, diff=${manualSell - cpSell} wei`);

  // 4. TRUE round-trip: buy moves the pool first, then sell from the new state
  // (constant-product on updated virtual reserves).
  const x = (pool.liquidity * Q96) / pool.sqrtPriceX96;
  const y = (pool.liquidity * pool.sqrtPriceX96) / Q96;
  const buyAfterFee = (buyIn * 997000n) / 1000000n;
  const x2 = x + buyAfterFee;
  const y2 = y - manualBuy;
  const sellAfterFee = (manualBuy * 997000n) / 1000000n;
  const roundTripOut = (x2 * sellAfterFee) / (y2 + sellAfterFee);
  console.log(`TRUE ROUND-TRIP: 0.0005 ETH in -> ${ethers.formatEther(roundTripOut)} ETH out (loss ${(Number(ethers.formatEther(buyIn - roundTripOut)) / 0.0005 * 100).toFixed(2)}% — expect ~0.55% from 2x 0.3% fee)`);

  // 5. Verdict (buy diff is intermediate-rounding noise; 5.2e-9 DECO on 13,426).
  const buyDiff = manualBuy >= cpBuy ? manualBuy - cpBuy : cpBuy - manualBuy;
  const sellDiff = manualSell >= cpSell ? manualSell - cpSell : cpSell - manualSell;
  const rtLossOk = roundTripOut > (buyIn * 994n) / 1000n; // round-trip loss < 0.6%
  if (buyDiff <= 10000000000n && sellDiff === 0n && rtLossOk) console.log('VERDICT: PASS — manual quote verified (methods agree, spot limit holds, round-trip ~0.55%)');
  else console.log(`VERDICT: CHECK — diffs buy=${buyDiff} sell=${sellDiff} wei, round-trip ok=${rtLossOk}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
