// Uniswap V4 watcher + trader — used on Robinhood (full official stack) and
// Arc (PoolManager live, but NO UniversalRouter — live trading on Arc is
// blocked until a router is configured; see research.md).
//
// Notes from on-chain verification (2026-11-16):
// - PoolManager.getSlot0()/getLiquidity() REVERT on direct eth_call even for
//   live pools on these chains. Pool state must be read via StateView.
// - Arc pairs DECO against the USDC ERC-20 view (0x3600…, 6 decimals);
//   Robinhood pairs DECO against native ETH (currency address 0).
const { ethers } = require('ethers');
const { ZERO } = require('../config');

const POOL_MANAGER_ABI = [
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
];
const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 exactAmountIn, bytes hookData) view returns (uint256 amountOut, uint256 gasEstimate)',
];
const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// V4 periphery action codes (v4-periphery Actions.sol).
const ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };
const V4_SWAP_COMMAND = 0x10;

function poolKeyFor(chain, token, fee, tickSpacing, hooks) {
  const quote = chain.dex.quoteToken;
  const [c0, c1] = BigInt(quote) < BigInt(token) ? [quote, token] : [token, quote];
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks };
}

function poolKeyTuple(key) {
  return [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
}

function poolId(key) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'], poolKeyTuple(key)));
}

// --- Watcher ---
// Polls PoolManager Initialize logs in small block windows (public RPCs cap
// eth_getLogs ranges: Arc rejects 10k blocks, LitVM caps at 3k). Returns
// decoded new pools and the block to resume from.
async function scanNewPools(chain, provider, fromBlock, toBlock, maxSpan = 1000) {
  const pm = new ethers.Contract(chain.dex.poolManager, POOL_MANAGER_ABI, provider);
  const pools = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + maxSpan - 1, toBlock);
    const events = await pm.queryFilter(pm.filters.Initialize(), cursor, end);
    for (const e of events) {
      pools.push({
        block: e.blockNumber,
        poolId: e.args.id,
        currency0: e.args.currency0,
        currency1: e.args.currency1,
        fee: Number(e.args.fee),
        tickSpacing: Number(e.args.tickSpacing),
        hooks: e.args.hooks,
      });
    }
    cursor = end + 1;
  }
  return { pools, nextFrom: toBlock + 1 };
}

// Target-token watch: is the DECO pool initialized? Uses StateView because
// PoolManager views revert on these chains. Returns null when uninitialized.
async function watchPool(chain, provider, token, fee, tickSpacing, hooks) {
  const key = poolKeyFor(chain, token, fee, tickSpacing, hooks);
  const id = poolId(key);
  const sv = new ethers.Contract(chain.dex.stateView, STATE_VIEW_ABI, provider);
  const slot0 = await sv.getSlot0(id);
  if (slot0[0] === 0n) return null;
  const liquidity = await sv.getLiquidity(id);
  return { key, poolId: id, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity };
}

// Price of token1 in token0 (quote per DECO), scaled by 1e18.
// sqrtPriceX96 = sqrt(token1/token0 in raw units) * 2^96, so
// token0 per token1 (raw) = 2^192 / sqrtPriceX96^2. Scale by 1e18 and
// adjust for the decimals difference (raw -> whole tokens).
function priceToken1InToken0(sqrtPriceX96, dec0, dec1) {
  if (sqrtPriceX96 === 0n) return null;
  const Q192 = 2n ** 192n;
  let human = (Q192 * 10n ** 18n) / (sqrtPriceX96 * sqrtPriceX96);
  const decDiff = BigInt(dec1) - BigInt(dec0);
  if (decDiff >= 0n) human = human * 10n ** decDiff;
  else human = human / 10n ** (-decDiff);
  return human;
}

// --- Quoting (manual sqrtPrice math — NOT the on-chain Quoter) ---
// The Quoter at chain.dex.quoter (0x8dc1…) is UNUSABLE on Robinhood testnet:
// the address holds a non-quoter contract (10 selectors, no quote function
// at all — verified 2026-11-16 by dispatcher inspection; every quote call
// reverts with empty returndata). Uniswap's own docs warn not to assume the
// same v4 addresses across chains. So quotes are computed locally from
// StateView (sqrtPrice + liquidity) with exact UniV3 sqrtPrice math.
// ASSUMPTION: constant liquidity across the swap — exact for full-range
// single-position pools (our DECO pool). Do NOT use blindly on
// multi-position pools (a swap crossing an initialized tick would change L
// mid-swap and the quote would be wrong).
const Q96 = 2n ** 96n;

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

// Exact-input quote from pool state. Rounding is conservative (output
// slightly under-estimated), so a minOut derived from it never exceeds the
// actual swap output.
async function quoteExactInputSingleManual(chain, provider, token, zeroForOne, amountIn, fee, tickSpacing, hooks) {
  const pool = await watchPool(chain, provider, token, fee, tickSpacing, hooks);
  if (!pool) throw new Error('quote: pool not initialized');
  if (pool.liquidity === 0n) throw new Error('quote: pool has no liquidity');
  const sqrtP = pool.sqrtPriceX96;
  const L = pool.liquidity;
  const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
  if (amountInAfterFee === 0n) throw new Error('quote: amount after fee is 0');
  let amountOut;
  if (zeroForOne) {
    // Token0 in, token1 out. sqrtP falls: sqrtP' = (L*sqrtP) / (L + in*sqrtP/Q96).
    const denom = L + (amountInAfterFee * sqrtP) / Q96;
    const sqrtPNext = ceilDiv(L * sqrtP, denom); // round UP -> output conservative
    if (sqrtPNext >= sqrtP) throw new Error('quote: price did not move (amount too small?)');
    amountOut = (L * (sqrtP - sqrtPNext)) / Q96; // round DOWN -> conservative
  } else {
    // Token1 in, token0 out. sqrtP rises: sqrtP' = sqrtP + in*Q96/L.
    const sqrtPNext = sqrtP + (amountInAfterFee * Q96) / L; // round DOWN -> conservative
    if (sqrtPNext <= sqrtP) throw new Error('quote: price did not move (amount too small?)');
    amountOut = (L * Q96 * (sqrtPNext - sqrtP)) / (sqrtP * sqrtPNext); // round DOWN
  }
  if (amountOut <= 0n) throw new Error('quote: output is 0');
  return amountOut;
}

// Public quote entry point (manual math; see above). Same signature as the
// old Quoter-based version so callers are unchanged.
async function quoteExactInputSingle(chain, provider, token, zeroForOne, amountIn, fee, tickSpacing, hooks) {
  return quoteExactInputSingleManual(chain, provider, token, zeroForOne, amountIn, fee, tickSpacing, hooks);
}

// --- Trade builders (UniversalRouter V4_SWAP) ---
// Throws when the chain has no UniversalRouter configured (Arc) — live v4
// trading there is blocked until a router is deployed/verified.
function requireRouter(chain) {
  if (!chain.dex.universalRouter) {
    throw new Error(
      `${chain.name}: no UniversalRouter configured — live v4 swaps are blocked. ` +
      `Deploy or verify a v4 router first (see research.md).`);
  }
  return chain.dex.universalRouter;
}

function withSlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
}

// Encodes UniversalRouter.execute(V4_SWAP, [actions+params], deadline).
// actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (standard v4 exact-in).
function encodeV4Swap(key, zeroForOne, amountIn, amountOutMin) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.solidityPacked(
    ['uint8', 'uint8', 'uint8'],
    [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL]);
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const params = [
    coder.encode(
      ['(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'bytes'],
      // hookData '0x00', NOT '0x': the Robinhood testnet router reverts with
      // SliceOutOfBounds (0x3b99b53d) on EMPTY hookData (verified 2026-11-16:
      // swap-only probe with '0x' -> SliceOutOfBounds, with '0x00' -> swap
      // executed, CurrencyNotSettled as expected). Our pool has hooks = 0x0,
      // so hookData is never read by any hook — the byte is inert.
      [poolKeyTuple(key), zeroForOne, amountIn, amountOutMin, '0x00']),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),
    coder.encode(['address', 'uint256'], [currencyOut, amountOutMin]),
  ];
  const inputs = [coder.encode(['bytes', 'bytes[]'], [actions, params])];
  return { commands: '0x10', inputs };
}

async function buildBuyTx(chain, signerOrProvider, token, amountIn, slippageBps, to, fee, tickSpacing, hooks) {
  const routerAddr = requireRouter(chain);
  const key = poolKeyFor(chain, token, fee, tickSpacing, hooks);
  const provider = signerOrProvider.provider ?? signerOrProvider;
  // zeroForOne = paying currency0. Buy pays the quote asset.
  const zeroForOne = key.currency0.toLowerCase() === chain.dex.quoteToken.toLowerCase();
  const expectedOut = await quoteExactInputSingle(chain, provider, token, zeroForOne, amountIn, fee, tickSpacing, hooks);
  const amountOutMin = withSlippage(expectedOut, slippageBps);
  const { commands, inputs } = encodeV4Swap(key, zeroForOne, amountIn, amountOutMin);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const router = new ethers.Contract(routerAddr, UNIVERSAL_ROUTER_ABI, signerOrProvider);
  const isNativeIn = chain.dex.quoteToken === ZERO;
  const tx = await router.execute.populateTransaction(
    commands, inputs, deadline, isNativeIn ? { value: amountIn } : {});
  return { tx, key, poolId: poolId(key), expectedOut, amountOutMin };
}

async function buildSellTx(chain, signerOrProvider, token, amountIn, slippageBps, to, fee, tickSpacing, hooks) {
  const routerAddr = requireRouter(chain);
  const key = poolKeyFor(chain, token, fee, tickSpacing, hooks);
  const provider = signerOrProvider.provider ?? signerOrProvider;
  // Sell pays DECO: zeroForOne = DECO is currency0.
  const zeroForOne = key.currency0.toLowerCase() === token.toLowerCase();
  const expectedOut = await quoteExactInputSingle(chain, provider, token, zeroForOne, amountIn, fee, tickSpacing, hooks);
  const amountOutMin = withSlippage(expectedOut, slippageBps);
  const { commands, inputs } = encodeV4Swap(key, zeroForOne, amountIn, amountOutMin);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const router = new ethers.Contract(routerAddr, UNIVERSAL_ROUTER_ABI, signerOrProvider);
  const tx = await router.execute.populateTransaction(commands, inputs, deadline);
  return { tx, key, poolId: poolId(key), expectedOut, amountOutMin };
}

// ERC-20 approve of Permit2 (needed before the first v4 sell of a token —
// the UniversalRouter pulls ERC-20 input through Permit2).
async function buildPermit2ApproveTx(chain, signerOrProvider, token, amount) {
  const { PERMIT2 } = require('../config');
  const erc20 = new ethers.Contract(token, ERC20_ABI, signerOrProvider);
  const tx = await erc20.approve.populateTransaction(PERMIT2, amount);
  return { tx };
}

async function permit2Allowance(chain, provider, token, owner) {
  const { PERMIT2 } = require('../config');
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  return erc20.allowance(owner, PERMIT2);
}

module.exports = {
  poolKeyFor, poolKeyTuple, poolId, scanNewPools, watchPool, priceToken1InToken0,
  quoteExactInputSingle, quoteExactInputSingleManual, buildBuyTx, buildSellTx, buildPermit2ApproveTx,
  permit2Allowance, encodeV4Swap,
  POOL_MANAGER_ABI, STATE_VIEW_ABI, QUOTER_ABI, UNIVERSAL_ROUTER_ABI,
};
