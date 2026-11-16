// Uniswap V2 (fork) watcher + trader — used on LitVM (factory 0x5687…,
// router 0xd289…, WETH 0x4fd3…). Standard V2 ABI: the fork was verified to
// implement factory()/token0()/token1()/getReserves()/allPairsLength() per
// spec (see research.md).
const { ethers } = require('ethers');

const FACTORY_ABI = [
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function getPair(address,address) view returns (address)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const ROUTER_ABI = [
  'function getAmountsOut(uint256, address[]) view returns (uint256[])',
  'function getAmountsIn(uint256, address[]) view returns (uint256[])',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function contracts(chain, provider) {
  return {
    factory: new ethers.Contract(chain.dex.factory, FACTORY_ABI, provider),
    router: new ethers.Contract(chain.dex.router, ROUTER_ABI, provider),
    weth: chain.dex.weth,
  };
}

// --- Watcher ---
// Polls factory.allPairsLength(); when it grows, reads the new pairs and
// returns their details. Public RPCs expose no mempool, so polling is the
// realistic approach (see README).
async function scanNewPairs(chain, provider, knownCount) {
  const { factory } = contracts(chain, provider);
  const count = Number(await factory.allPairsLength());
  const fresh = [];
  for (let i = knownCount; i < count; i++) {
    const pairAddr = await factory.allPairs(i);
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [token0, token1, reserves] = await Promise.all([
      pair.token0(), pair.token1(), pair.getReserves(),
    ]);
    fresh.push({ index: i, pair: pairAddr, token0, token1, reserve0: reserves[0], reserve1: reserves[1] });
  }
  return { count, fresh };
}

// Target-token watch: does a pair for `token` vs WETH exist yet, and what
// are its reserves? Returns null when no pair exists.
async function watchPair(chain, provider, token) {
  const { factory } = contracts(chain, provider);
  const pairAddr = await factory.getPair(token, chain.dex.weth);
  if (pairAddr === ethers.ZeroAddress) return null;
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
  const tokenIs0 = token0.toLowerCase() === token.toLowerCase();
  return {
    pair: pairAddr,
    tokenReserve: tokenIs0 ? reserves[0] : reserves[1],
    wethReserve: tokenIs0 ? reserves[1] : reserves[0],
  };
}

// --- Pricing ---
// Price of `token` in WETH (wei per whole token, 18-decimals adjusted).
// Returns null when the pair has no liquidity.
function priceFromReserves(pairInfo, tokenDecimals = 18) {
  if (pairInfo.tokenReserve === 0n || pairInfo.wethReserve === 0n) return null;
  // weth per token, scaled to 1e18
  return (pairInfo.wethReserve * 10n ** BigInt(tokenDecimals)) / pairInfo.tokenReserve;
}

async function quoteBuy(chain, provider, token, amountInNative) {
  const { router } = contracts(chain, provider);
  const amounts = await router.getAmountsOut(amountInNative, [chain.dex.weth, token]);
  return amounts[1];
}

async function quoteSell(chain, provider, token, amountInToken) {
  const { router } = contracts(chain, provider);
  const amounts = await router.getAmountsOut(amountInToken, [token, chain.dex.weth]);
  return amounts[1];
}

// --- Trade builders (return unsigned populated txs; the caller signs or logs) ---
function withSlippage(amountOut, slippageBps) {
  return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
}

async function buildBuyTx(chain, signerOrProvider, token, amountInNative, slippageBps, to) {
  const router = new ethers.Contract(chain.dex.router, ROUTER_ABI, signerOrProvider);
  const expectedOut = await router.getAmountsOut(amountInNative, [chain.dex.weth, token]);
  const amountOutMin = withSlippage(expectedOut[1], slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = await router.swapExactETHForTokens.populateTransaction(
    amountOutMin, [chain.dex.weth, token], to, deadline, { value: amountInNative });
  return { tx, expectedOut: expectedOut[1], amountOutMin };
}

async function buildSellTx(chain, signerOrProvider, token, amountInToken, slippageBps, to) {
  const router = new ethers.Contract(chain.dex.router, ROUTER_ABI, signerOrProvider);
  const expectedOut = await router.getAmountsOut(amountInToken, [token, chain.dex.weth]);
  const amountOutMin = withSlippage(expectedOut[1], slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = await router.swapExactTokensForETH.populateTransaction(
    amountInToken, amountOutMin, [token, chain.dex.weth], to, deadline);
  return { tx, expectedOut: expectedOut[1], amountOutMin };
}

// ERC-20 approve of the router (needed before the first sell of a token).
async function buildApproveTx(chain, signerOrProvider, token, spender, amount) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, signerOrProvider);
  const tx = await erc20.approve.populateTransaction(spender, amount);
  return { tx };
}

async function allowance(chain, provider, token, owner, spender) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  return erc20.allowance(owner, spender);
}

module.exports = {
  contracts, scanNewPairs, watchPair, priceFromReserves,
  quoteBuy, quoteSell, buildBuyTx, buildSellTx, buildApproveTx, allowance,
  FACTORY_ABI, PAIR_ABI, ROUTER_ABI, ERC20_ABI,
};
