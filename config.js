// Per-chain config for the testnet sniper.
// Addresses come from research.md — every address was verified live on-chain
// 2026-11-16. Do NOT add mainnet chains here: the guard in sniper.js refuses
// any chainId outside ALLOWED_CHAIN_IDS.
const { ethers } = require('ethers');

// Hard allowlist. Any other chainId is refused before any signing or RPC
// write. Mainnet chain IDs (1, 4663, 5042, ...) can never reach this bot.
const ALLOWED_CHAIN_IDS = [5042002, 46630, 4441];

const BURNER = '0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31';
const DECO = '0x5f1dF574015C9D044b4C9Ef658cD55aFcC13D783';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZERO = ethers.ZeroAddress;

const CHAINS = {
  arc: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    gasToken: { symbol: 'USDC', decimals: 18, note: 'native USDC is the gas token' },
    dex: {
      type: 'v4',
      // Uniswap v4 PoolManager — live, bytecode identical to Robinhood
      // testnet's. NOT docs-listed for Arc; see research.md.
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
      positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
      quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
      // NO UniversalRouter on Arc testnet (verified empty at both known
      // addresses). Live v4 trading on Arc is BLOCKED until a router is
      // deployed/verified and its address is put here.
      universalRouter: null,
      // Quote asset for DECO pools: USDC ERC-20 view (6 decimals).
      // Native USDC has no wrapped form on Arc; native-value swaps revert.
      quoteToken: '0x3600000000000000000000000000000000000000',
      quoteTokenDecimals: 6,
      quoteTokenSymbol: 'USDC',
    },
  },
  robinhood: {
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpc: 'https://rpc.testnet.chain.robinhood.com/rpc',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    gasToken: { symbol: 'ETH', decimals: 18, note: 'test ETH' },
    dex: {
      type: 'v4',
      // Uniswap v4, de-facto official: all addresses match the docs-listed
      // Robinhood mainnet (4663) deployment. See research.md.
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
      positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
      quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
      universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
      // Quote asset for DECO pools: native ETH (v4 currency address 0).
      quoteToken: ZERO,
      quoteTokenDecimals: 18,
      quoteTokenSymbol: 'ETH',
    },
  },
  litvm: {
    name: 'LitVM LiteForge',
    chainId: 4441,
    rpc: 'https://rpc.testnet.liteforge.zeeve.net/',
    explorer: 'https://explorer.testnet.liteforge.zeeve.net',
    gasToken: { symbol: 'zkLTC', decimals: 18, note: 'native zkLTC' },
    dex: {
      type: 'v2',
      // Community Uniswap V2 FORK (not Uniswap's deployment): 852 pairs.
      factory: '0x5687FDA3BdE14d38057699c402606ab470EcA873',
      router: '0xd28967D75750f477E450Df81C73f34E2713B86B4',
      weth: '0x4fd3765cde8d1d2be4edbaa03940afc56794c304', // "Wrapped Ether"
      quoteToken: '0x4fd3765cde8d1d2be4edbaa03940afc56794c304',
      quoteTokenDecimals: 18,
      quoteTokenSymbol: 'WETH',
    },
  },
};

// Default trading parameters. Small on purpose: these are testnet funds and
// the DECO pools do not exist yet. Tune per run via CLI flags / env.
const TRADING = {
  // Buy size per trade, in native gas-token units (ETH/zkLTC) — except Arc,
  // where the quote asset is ERC-20 USDC (see arcBuyAmountUsdc).
  buyAmountNative: '0.001', // 0.001 ETH / zkLTC per buy
  arcBuyAmountUsdc: '1', // 1 USDC (ERC-20 view, 6 decimals) per buy on Arc
  slippageBps: 500, // 5% max slippage
  takeProfitPct: 100, // sell when price doubles (+100%)
  stopLossPct: 50, // sell when price halves (-50%)
  maxHoldSeconds: 3600, // time-based exit: 1h
  maxSpendPerTradeNative: '0.005', // hard cap per buy (native units)
  maxSpendPerTradeUsdcArc: '5', // hard cap per buy on Arc (USDC view, 6 dec)
  maxConcurrentPositions: 3,
  maxTotalSpendNative: '0.02', // hard cap per bot run (native units)
  maxTotalSpendUsdcArc: '20', // hard cap per bot run on Arc (USDC view)
  pollSeconds: 10, // pair-watcher poll interval
  // V4 pool key defaults for DECO pools (fee 3000 = 0.3%, tickSpacing 60).
  v4Fee: 3000,
  v4TickSpacing: 60,
  v4Hooks: ZERO,
};

// LIVE MODE GATE — two steps required to trade for real:
//   1. set LIVE.enabled = true in this file, AND
//   2. pass --live on the command line.
// Either one alone keeps the bot in dry-run (it only logs what it WOULD send).
// Live mode also requires deco's explicit approval per run — never enable
// this casually. Default: dry-run.
const LIVE = { enabled: false };

module.exports = { ALLOWED_CHAIN_IDS, BURNER, DECO, PERMIT2, ZERO, CHAINS, TRADING, LIVE };
