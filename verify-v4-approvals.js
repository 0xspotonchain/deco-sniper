// Read-only: verify the Robinhood v4 Permit2 approvals from the paused
// 2026-11-16 04:24 attempt are still in place, and confirm the DECO/ETH
// v4 pool does not exist yet. No signing.
'use strict';

const { ethers } = require('ethers');
const { CHAINS, BURNER, DECO, PERMIT2 } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const v4 = require('./dex/v4');
const { TRADING } = require('./config');

const ERC20_ABI = ['function allowance(address owner, address spender) view returns (uint256)'];
const PERMIT2_ABI = ['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'];

async function main() {
  const chain = CHAINS.robinhood;
  const provider = providerFor(chain);
  await assertTestnetChain(provider, chain);
  const deco = new ethers.Contract(DECO, ERC20_ABI, provider);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, provider);

  const p2Allow = await deco.allowance(BURNER, PERMIT2);
  console.log(`DECO -> Permit2 allowance: ${ethers.formatEther(p2Allow)} DECO`);
  const [pmAmt, pmExp] = await permit2.allowance(BURNER, DECO, chain.dex.positionManager);
  console.log(`Permit2 -> PositionManager: ${ethers.formatEther(pmAmt)} DECO, expiration ${pmExp} (${new Date(Number(pmExp) * 1000).toISOString().slice(0, 10)})`);
  const [urAmt, urExp] = await permit2.allowance(BURNER, DECO, chain.dex.universalRouter);
  console.log(`Permit2 -> UniversalRouter: ${ethers.formatEther(urAmt)} DECO, expiration ${urExp}`);
  const ethBal = await provider.getBalance(BURNER);
  console.log(`Burner ETH: ${ethers.formatEther(ethBal)}`);
  const pool = await v4.watchPool(chain, provider, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks);
  console.log(`DECO/ETH v4 pool exists: ${pool ? `YES (liquidity ${pool.liquidity})` : 'NO'}`);
  console.log(`poolId would be: ${v4.poolId(v4.poolKeyFor(chain, DECO, TRADING.v4Fee, TRADING.v4TickSpacing, TRADING.v4Hooks))}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
