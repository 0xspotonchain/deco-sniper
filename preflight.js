// Read-only pre-flight for the Robinhood v4 DECO pool + live spam run.
// No keystore access, no signing, no broadcasts.
const { ethers } = require('ethers');
const { CHAINS, TRADING, BURNER, DECO, PERMIT2, ZERO } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const v4 = require('./dex/v4');

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

async function main() {
  const chain = CHAINS.robinhood;
  const provider = providerFor(chain);
  await assertTestnetChain(provider, chain);
  console.log(`chain: ${chain.name} (${chain.chainId}) OK`);

  const ethBal = await provider.getBalance(BURNER);
  const deco = new ethers.Contract(DECO, ERC20_ABI, provider);
  const decoBal = await deco.balanceOf(BURNER);
  console.log(`burner ETH: ${ethers.formatEther(ethBal)}`);
  console.log(`burner DECO: ${ethers.formatEther(decoBal)}`);

  const feeData = await provider.getFeeData();
  console.log(`gas price: ${feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') + ' gwei' : 'n/a'}`);

  for (const [name, addr] of Object.entries({
    PoolManager: chain.dex.poolManager,
    PositionManager: chain.dex.positionManager,
    Quoter: chain.dex.quoter,
    StateView: chain.dex.stateView,
    UniversalRouter: chain.dex.universalRouter,
    Permit2: PERMIT2,
  })) {
    const code = await provider.getCode(addr);
    console.log(`${name} ${addr}: ${code === '0x' ? 'EMPTY ***' : (code.length - 2) / 2 + ' bytes code'}`);
  }

  const key = v4.poolKeyFor(chain, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  const id = v4.poolId(key);
  console.log(`pool key: c0=${key.currency0} c1=${key.currency1} fee=${key.fee} tickSpacing=${key.tickSpacing} hooks=${key.hooks}`);
  console.log(`poolId: ${id}`);
  const pool = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  console.log(pool ? `pool ALREADY initialized: sqrtPriceX96=${pool.sqrtPriceX96} tick=${pool.tick} liquidity=${pool.liquidity}` : 'pool uninitialized (sqrtPriceX96 = 0) — ready to create');

  const p2Allow = await deco.allowance(BURNER, PERMIT2);
  console.log(`DECO allowance to Permit2: ${ethers.formatEther(p2Allow)}`);
  const block = await provider.getBlockNumber();
  console.log(`tip block: ${block}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
