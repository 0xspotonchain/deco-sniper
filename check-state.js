// Read-only state check for the volume sniper: per chain, prints the burner
// DECO balance, native (gas-token) balance, SimpleAMM pool reserves, burner
// nonce, and live gas price. Optionally checks tx receipts passed as extra
// args (hashes must belong to the given chain).
// No signing, no keystore. Safe to run any time.
// Usage: node check-state.js [arc|robinhood|litvm] [0xhash ...]
'use strict';

const { ethers } = require('ethers');
const { CHAINS, BURNER, DECO } = require('./config');
const { providerFor } = require('./provider');
const { loadAmmAddress, AMM_ABI, ERC20_ABI, VOLUME } = require('./volume');

async function main() {
  const args = process.argv.slice(2);
  const chainFilter = args.find((a) => CHAINS[a]);
  const hashes = args.filter((a) => a.startsWith('0x') && a.length === 66);
  const chains = chainFilter ? [chainFilter] : ['arc', 'robinhood', 'litvm'];
  for (const name of chains) {
    const chain = CHAINS[name];
    const vol = VOLUME[name];
    const provider = providerFor(chain);
    const ammAddress = loadAmmAddress(name);
    const deco = new ethers.Contract(DECO, ERC20_ABI, provider);
    const amm = new ethers.Contract(ammAddress, AMM_ABI, provider);
    const [decoBal, reserves, nonce, feeData, nativeBal] = await Promise.all([
      deco.balanceOf(BURNER),
      amm.getReserves(),
      provider.getTransactionCount(BURNER),
      provider.getFeeData(),
      provider.getBalance(BURNER),
    ]);
    console.log(`== ${name} (${chain.name})`);
    console.log(`   burner DECO: ${ethers.formatUnits(decoBal, 18)}`);
    console.log(`   burner ${chain.gasToken.symbol}: ${ethers.formatUnits(nativeBal, chain.gasToken.decimals)}`);
    console.log(`   pool ${ammAddress}: ${ethers.formatUnits(reserves[0], 18)} DECO / ${ethers.formatUnits(reserves[1], vol.baseDecimals)} ${vol.baseSymbol}`);
    console.log(`   nonce: ${nonce} | gas price: ${ethers.formatUnits(feeData.gasPrice, 'gwei')} gwei`);
    for (const h of hashes) {
      const r = await provider.getTransactionReceipt(h).catch(() => null);
      console.log(`   tx ${h.slice(0, 18)}… status=${r ? r.status : 'NOT FOUND'} block=${r ? r.blockNumber : '-'}`);
    }
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
