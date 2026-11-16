// Create the DECO/ETH Uniswap v4 pool on Robinhood Chain Testnet (46630)
// and seed it with liquidity via the PositionManager.
//
// Pool: currency0 = native ETH (address 0), currency1 = DECO,
// fee 3000 (0.3%), tickSpacing 60, hooks 0x0.
// Initial price: 1 DECO = 0.00000003 ETH (3e-8), i.e. 100,000 DECO per
// 0.003 ETH — the seed ratio sets the price. Full-range position
// (ticks -887220 / +887220).
//
// Steps (each max 2 attempts):
//   1. ERC20 approve DECO -> Permit2 (1,000,000 DECO)
//   2. Permit2.approve DECO -> PositionManager (needed for SETTLE_PAIR)
//   3. Permit2.approve DECO -> UniversalRouter (needed for later sells)
//   4. PositionManager.initializePool(key, sqrtPriceX96)
//   5. PositionManager.modifyLiquidities(MINT_POSITION + SETTLE_PAIR,
//      msg.value 0.003 ETH)
// Then verifies via StateView (slot0 + liquidity) and the position NFT.
//
// SAFETY: hard chain guard (46630 only, verified against the RPC before any
// signing). The burner key is decrypted in memory only and never logged.
// Budget: 0.003 ETH + 100,000 DECO seeded; >=0.005 ETH stays in reserve.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { CHAINS, TRADING, BURNER, DECO, PERMIT2, ZERO } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const { loadBurnerWallet } = require('./keystore');
const v4 = require('./dex/v4');

const CHAIN_ID = 46630;
const SEED_ETH = ethers.parseEther('0.003');
const SEED_DECO = ethers.parseEther('100000');
const APPROVE_DECO = ethers.parseEther('1000000');
const PERMIT2_EXPIRATION = 4102444800; // 2100-01-01
const TICK_LOWER = -887220; // full range, multiple of 60
const TICK_UPPER = 887220;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
const POSITION_MANAGER_ABI = [
  'function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) payable returns (int24 tick)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function balanceOf(address owner) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

// Integer square root (Newton) for BigInt.
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Send a tx, wait for the receipt, retry once on failure. Returns receipt.
async function sendWithRetry(label, sendFn) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tx = await sendFn();
      log(`${label}: sent ${tx.hash} (attempt ${attempt}) — waiting…`);
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error(`tx ${tx.hash} reverted (status 0)`);
      log(`${label}: confirmed block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
      return receipt;
    } catch (e) {
      lastErr = e;
      log(`${label}: attempt ${attempt} FAILED: ${e.message.slice(0, 400)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

async function main() {
  const chain = CHAINS.robinhood;
  if (chain.chainId !== CHAIN_ID) throw new Error('Config chain mismatch — refusing.');
  const provider = providerFor(chain);
  await assertTestnetChain(provider, chain);
  log(`chain ${chain.name} (${chain.chainId}) verified`);

  const key = v4.poolKeyFor(chain, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  const poolId = v4.poolId(key);
  log(`poolId: ${poolId}`);
  const existing = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  if (existing) throw new Error(`Pool already initialized (liquidity ${existing.liquidity}) — aborting, no overwrite.`);

  const ethBefore = await provider.getBalance(BURNER);
  const decoRead = new ethers.Contract(DECO, ERC20_ABI, provider);
  const decoBefore = await decoRead.balanceOf(BURNER);
  log(`burner before: ${ethers.formatEther(ethBefore)} ETH, ${ethers.formatEther(decoBefore)} DECO`);
  if (ethBefore < SEED_ETH + ethers.parseEther('0.005')) {
    throw new Error('Burner ETH too low to seed 0.003 and keep 0.005 reserve — aborting.');
  }
  if (decoBefore < SEED_DECO) throw new Error('Burner DECO below seed amount — aborting.');

  // --- price + liquidity math (exact BigInt) ---
  // sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96, both 18 decimals.
  const sqrtPriceX96 = isqrt((SEED_DECO * 2n ** 192n) / SEED_ETH);
  // Full-range liquidity L = sqrt(amount0 * amount1), with a 0.1% haircut so
  // the mint can never exceed amount0Max/amount1Max through rounding.
  const liquidity = (isqrt(SEED_ETH * SEED_DECO) * 999n) / 1000n;
  log(`sqrtPriceX96=${sqrtPriceX96} (1 DECO = 3e-8 ETH)`);
  log(`liquidity=${liquidity} ticks=[${TICK_LOWER}, ${TICK_UPPER}]`);

  const wallet = loadBurnerWallet(provider);
  log('signer loaded (burner address verified, key never logged)');
  const results = { chain: 'robinhood', chainId: CHAIN_ID, poolId, poolKey: key,
    sqrtPriceX96: sqrtPriceX96.toString(), tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
    liquidity: liquidity.toString(), seedEth: ethers.formatEther(SEED_ETH),
    seedDeco: ethers.formatEther(SEED_DECO), steps: {} };

  const deco = new ethers.Contract(DECO, ERC20_ABI, wallet);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet);
  const pm = new ethers.Contract(chain.dex.positionManager, POSITION_MANAGER_ABI, wallet);

  // 1. ERC20 approve Permit2
  const p2Allow = await decoRead.allowance(BURNER, PERMIT2);
  if (p2Allow < SEED_DECO) {
    const r = await sendWithRetry('approve DECO -> Permit2', () => deco.approve(PERMIT2, APPROVE_DECO));
    results.steps.approvePermit2 = { txHash: r.hash, block: r.blockNumber, gasUsed: r.gasUsed.toString() };
  } else log(`DECO->Permit2 allowance already ${ethers.formatEther(p2Allow)} — skipping approve`);

  // 2+3. Permit2 allowances for PositionManager and UniversalRouter
  for (const [label, spender] of [['PositionManager', chain.dex.positionManager], ['UniversalRouter', chain.dex.universalRouter]]) {
    const [amt] = await permit2.allowance(BURNER, DECO, spender);
    if (amt >= SEED_DECO) { log(`Permit2 allowance for ${label} already ${ethers.formatEther(amt)} — skipping`); continue; }
    const r = await sendWithRetry(`Permit2.approve DECO -> ${label}`,
      () => permit2.approve(DECO, spender, APPROVE_DECO, PERMIT2_EXPIRATION));
    results.steps[`permit2_${label.toLowerCase()}`] = { txHash: r.hash, block: r.blockNumber, gasUsed: r.gasUsed.toString() };
  }

  // 4. Initialize the pool (staticCall first to catch encoding errors)
  try {
    await pm.initializePool.staticCall(v4.poolKeyTuple(key), sqrtPriceX96);
    log('initializePool staticCall OK');
  } catch (e) {
    throw new Error(`initializePool staticCall failed — aborting before broadcast: ${e.message.slice(0, 400)}`);
  }
  const initReceipt = await sendWithRetry('initializePool',
    () => pm.initializePool(v4.poolKeyTuple(key), sqrtPriceX96));
  results.steps.initializePool = { txHash: initReceipt.hash, block: initReceipt.blockNumber, gasUsed: initReceipt.gasUsed.toString() };

  // 5. Mint the position: MINT_POSITION (0x02) + SETTLE_PAIR (0x0d)
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.solidityPacked(['uint8', 'uint8'], [0x02, 0x0d]);
  const mintParams = coder.encode(
    ['(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [v4.poolKeyTuple(key), TICK_LOWER, TICK_UPPER, liquidity, SEED_ETH, SEED_DECO, BURNER, '0x']);
  const settleParams = coder.encode(['address', 'address'], [key.currency0, key.currency1]);
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions, [mintParams, settleParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  try {
    const nextTokenId = await pm.nextTokenId();
    log(`next position tokenId (expected mint): ${nextTokenId}`);
  } catch (e) {
    log(`nextTokenId read failed (non-fatal, will parse Transfer event): ${e.message.slice(0, 120)}`);
  }

  try {
    await pm.modifyLiquidities.staticCall(unlockData, deadline, { value: SEED_ETH });
    log('modifyLiquidities staticCall OK');
  } catch (e) {
    throw new Error(`modifyLiquidities staticCall failed — aborting before broadcast: ${e.message.slice(0, 400)}`);
  }
  const mintReceipt = await sendWithRetry('modifyLiquidities (mint + settle)',
    () => pm.modifyLiquidities(unlockData, deadline, { value: SEED_ETH }));
  results.steps.mintPosition = { txHash: mintReceipt.hash, block: mintReceipt.blockNumber, gasUsed: mintReceipt.gasUsed.toString() };

  // --- verification ---
  const pool = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  if (!pool) throw new Error('Post-mint check: pool still uninitialized!');
  log(`verified: sqrtPriceX96=${pool.sqrtPriceX96} tick=${pool.tick} liquidity=${pool.liquidity}`);
  results.verification = { sqrtPriceX96: pool.sqrtPriceX96.toString(), tick: pool.tick, liquidity: pool.liquidity.toString() };

  const pmRead = new ethers.Contract(chain.dex.positionManager, POSITION_MANAGER_ABI, provider);
  const nftBal = await pmRead.balanceOf(BURNER);
  log(`burner position-NFT balance: ${nftBal}`);
  results.verification.positionNftBalance = nftBal.toString();
  // Find the minted tokenId from the Transfer event in the mint receipt.
  const iface = new ethers.Interface(POSITION_MANAGER_ABI);
  for (const l of mintReceipt.logs) {
    try {
      const parsed = iface.parseLog(l);
      if (parsed && parsed.name === 'Transfer' && parsed.args.from === ZERO && parsed.args.to.toLowerCase() === BURNER.toLowerCase()) {
        results.verification.positionTokenId = parsed.args.tokenId.toString();
        log(`position NFT tokenId: ${parsed.args.tokenId}`);
      }
    } catch { /* not a PM log */ }
  }

  const ethAfter = await provider.getBalance(BURNER);
  const decoAfter = await decoRead.balanceOf(BURNER);
  log(`burner after: ${ethers.formatEther(ethAfter)} ETH, ${ethers.formatEther(decoAfter)} DECO`);
  results.balances = {
    ethBefore: ethers.formatEther(ethBefore), ethAfter: ethers.formatEther(ethAfter),
    decoBefore: ethers.formatEther(decoBefore), decoAfter: ethers.formatEther(decoAfter),
    ethSpentTotal: ethers.formatEther(ethBefore - ethAfter),
    decoSpentTotal: ethers.formatEther(decoBefore - decoAfter),
  };

  fs.writeFileSync(path.join(__dirname, 'robinhood-pool-results.json'), JSON.stringify(results, null, 2) + '\n');
  log('results written to robinhood-pool-results.json');
  log('POOL CREATED + SEEDED');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
