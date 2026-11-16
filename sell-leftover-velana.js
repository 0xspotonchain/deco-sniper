// One-off recovery: sell leftover DECO from an interrupted Velana volume
// round back to the SimpleAMM pool. Used when the VM dies mid-round after a
// buy landed but before its sell (round 490, 2026-11-16 ~18:23 WIB restart).
// Sells ONLY (burner DECO balance - 990,000 baseline) — never the supply.
// Appends the sell to volume-logs/2026-11-16-velana.jsonl as the round's
// sell leg. Velana testnet only (chain 484148), legacy type-0 txs.
// Usage: node sell-leftover-velana.js --round <N>
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { loadBurnerWallet } = require('./keystore');

const RPC = 'https://velanachain.com/rpc';
const CHAIN_ID = 484148;
const BURNER = '0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31';
const DECO = '0xDf8A3BaAFffc5de3938bff1158584E841531BcbF';
const AMM = '0xa81056EF621c952B5Fc033D7db159a0Da4ED5163';
const BASELINE = 990000n * 10n ** 18n; // burner's standing DECO supply
const LOG_FILE = path.join(__dirname, 'volume-logs', '2026-11-16-velana.jsonl');
const AMM_ABI = [
  'function sell(uint256 decoAmountIn, uint256 minBaseOut)',
  'function getReserves() view returns (uint256 decoReserve, uint256 baseReserve)',
  'function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

async function main() {
  const roundArg = process.argv.find((a) => a.startsWith('--round='));
  const round = roundArg ? Number(roundArg.split('=')[1]) : NaN;
  if (!Number.isInteger(round) || round < 1) {
    console.error('Usage: node sell-leftover-velana.js --round=<N>');
    process.exit(2);
  }
  const req = new ethers.FetchRequest(RPC);
  req.timeout = 60000;
  const provider = new ethers.JsonRpcProvider(req, CHAIN_ID, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`Wrong chain: ${net.chainId}`);
  const wallet = loadBurnerWallet(provider);
  const amm = new ethers.Contract(AMM, AMM_ABI, wallet);
  const ammRead = new ethers.Contract(AMM, AMM_ABI, provider);
  const deco = new ethers.Contract(DECO, ERC20_ABI, provider);

  const decoBal = await deco.balanceOf(BURNER);
  const leftover = decoBal - BASELINE;
  console.log(`burner DECO: ${ethers.formatEther(decoBal)} | baseline: 990000 | leftover: ${ethers.formatEther(leftover)}`);
  if (leftover <= 0n) {
    console.log('No leftover DECO — nothing to sell.');
    return;
  }
  const allow = await deco.allowance(BURNER, AMM);
  if (allow < leftover) throw new Error(`Allowance ${ethers.formatEther(allow)} < leftover — approve first (refusing to guess).`);

  const [decoReserve, baseReserve] = await ammRead.getReserves();
  const quote = await ammRead.getAmountOut(leftover, decoReserve, baseReserve);
  const minOut = (quote * 95n) / 100n;
  console.log(`reserves: ${ethers.formatEther(decoReserve)} DECO / ${ethers.formatEther(baseReserve)} VELA`);
  console.log(`sell quote: ${ethers.formatEther(quote)} VELA (min out @5%: ${ethers.formatEther(minOut)})`);

  const baseBefore = await provider.getBalance(BURNER);
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 7n;
  const tx = await amm.sell(leftover, minOut, { type: 0, gasPrice });
  console.log(`sell tx ${tx.hash} ...`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Sell reverted (${tx.hash})`);
  const cost = receipt.gasUsed * (receipt.gasPrice ?? gasPrice);
  const baseAfter = await provider.getBalance(BURNER);
  const baseOut = (baseAfter - baseBefore) + cost; // gas is paid in the base asset
  const decoAfter = await deco.balanceOf(BURNER);
  console.log(`confirmed in block ${receipt.blockNumber} (gas ${receipt.gasUsed}); received ${ethers.formatEther(baseOut)} VELA`);
  console.log(`burner DECO now: ${ethers.formatEther(decoAfter)}`);
  if (decoAfter !== BASELINE) {
    console.log(`WARNING: DECO balance ${ethers.formatEther(decoAfter)} != baseline 990000 — investigate before continuing.`);
  }

  const entry = {
    ts: new Date().toISOString(), chain: 'velana', round, side: 'sell', txHash: tx.hash,
    status: 'confirmed', gasUsed: receipt.gasUsed.toString(), gasPrice: (receipt.gasPrice ?? gasPrice).toString(),
    amountIn: leftover.toString(), amountOut: baseOut.toString(), inAsset: 'DECO', outAsset: 'VELA',
    note: 'MANUAL sell-back after VM restart 2026-11-16 ~18:23 WIB: the volume run died after round 490 buy landed; this completes round 490.',
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  console.log(`sell logged to ${LOG_FILE}`);
  console.log(`SELL DONE: ${ethers.formatEther(leftover)} DECO -> ${ethers.formatEther(baseOut)} VELA, tx ${tx.hash}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
