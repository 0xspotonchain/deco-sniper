// One-off DECO sell-back against deco's own SimpleAMM pool.
//
// Use case: recover orphan DECO left in the burner by a killed volume run
// (e.g. a buy that landed on-chain but whose send response was lost to a
// socket hang-up or a VM reboot — Robinhood first run, 2026-11-16: the
// volume run died mid-round-594 and left 697.119046890119032528 DECO in the
// burner). A fresh volume run would bake the orphan into its baseline and
// never sell it, so the sell-back must happen BEFORE any top-up run.
//
// Sells an EXACT amount passed on the CLI — never a balance-derived amount
// (the burner holds its 990,000 DECO supply; selling the balance was the
// 2026-11-16 cleanup bug). Testnet only, burner wallet only.
//
// Usage:
//   node sell-deco.js --chain=robinhood --amount=697.119046890119032528 [--live]
// Without --live it prints the quote and exits without signing.
'use strict';

const { ethers } = require('ethers');
const { CHAINS, BURNER, DECO } = require('./config');
const { providerFor, assertTestnetChain } = require('./provider');
const { loadAmmAddress, minOutFor, AMM_ABI, ERC20_ABI, VOLUME } = require('./volume');

function usage() {
  console.log('Usage: node sell-deco.js --chain <arc|robinhood|litvm> --amount <DECO> [--live] [--amm-file <path>]');
  console.log('  --amount: exact DECO to sell, decimal string (e.g. 697.119046890119032528).');
  console.log('  Without --live: prints the quote only, signs nothing.');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { live: false, ammFile: undefined };
  for (const a of argv) {
    if (a === '--live') opts.live = true;
    else if (a.startsWith('--chain=')) opts.chain = a.slice(8);
    else if (a.startsWith('--amount=')) opts.amount = a.slice(9);
    else if (a.startsWith('--amm-file=')) opts.ammFile = a.slice(11);
    else if (a === '--help') usage();
    else { console.error(`Unknown arg: ${a}`); usage(); }
  }
  if (!opts.chain || !CHAINS[opts.chain] || !opts.amount) usage();
  try {
    opts.amountWei = ethers.parseUnits(opts.amount, 18);
  } catch {
    console.error(`Invalid --amount: ${opts.amount}`);
    process.exit(2);
  }
  if (opts.amountWei <= 0n) { console.error('--amount must be positive.'); process.exit(2); }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chain = CHAINS[opts.chain];
  const vol = VOLUME[opts.chain];
  const provider = providerFor(chain);
  await assertTestnetChain(provider, chain);
  const ammAddress = loadAmmAddress(opts.chain, opts.ammFile);
  console.log(`Chain: ${chain.name} | AMM: ${ammAddress}`);
  console.log(`Selling exactly ${opts.amount} DECO`);

  const ammRead = new ethers.Contract(ammAddress, AMM_ABI, provider);
  const deco = new ethers.Contract(DECO, ERC20_ABI, provider);
  const [decoReserve, baseReserve] = await ammRead.getReserves();
  const balance = await deco.balanceOf(BURNER);
  console.log(`Burner DECO balance: ${ethers.formatUnits(balance, 18)}`);
  console.log(`Pool reserves: ${ethers.formatUnits(decoReserve, 18)} DECO / ${ethers.formatUnits(baseReserve, vol.baseDecimals)} ${vol.baseSymbol}`);
  if (balance < opts.amountWei) {
    throw new Error(`Burner holds ${ethers.formatUnits(balance, 18)} DECO — less than the requested ${opts.amount}. Refusing.`);
  }
  const quote = await ammRead.getAmountOut(opts.amountWei, decoReserve, baseReserve);
  const minOut = minOutFor(quote);
  console.log(`Quote: ${ethers.formatUnits(quote, vol.baseDecimals)} ${vol.baseSymbol} (min out @5% slippage: ${ethers.formatUnits(minOut, vol.baseDecimals)})`);
  if (minOut === 0n) throw new Error('Quote too small — refusing.');

  if (!opts.live) {
    console.log('Dry-run: nothing sent. Re-run with --live to execute.');
    return;
  }

  const { loadBurnerWallet } = require('./keystore');
  const signer = loadBurnerWallet(provider);
  console.log('*** LIVE MODE *** signer loaded (burner, key never logged)');
  const amm = new ethers.Contract(ammAddress, AMM_ABI, signer);
  const decoSigner = new ethers.Contract(DECO, ERC20_ABI, signer);

  const allowance = await deco.allowance(BURNER, ammAddress);
  if (allowance < opts.amountWei) {
    console.log(`DECO allowance ${ethers.formatUnits(allowance, 18)} < amount — approving MaxUint256…`);
    const approveTx = await decoSigner.approve(ammAddress, ethers.MaxUint256);
    const approveReceipt = await approveTx.wait();
    if (approveReceipt.status !== 1) throw new Error(`Approval reverted: ${approveTx.hash}`);
    console.log(`Approve tx: ${approveTx.hash}`);
  } else {
    console.log('DECO allowance OK.');
  }

  const sent = await amm.sell(opts.amountWei, minOut);
  console.log(`Sell tx sent: ${sent.hash} — waiting for confirmation…`);
  const receipt = await sent.wait();
  if (receipt.status !== 1) throw new Error(`Sell reverted: ${sent.hash}`);
  console.log(`Sell CONFIRMED: ${sent.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  console.log(`Explorer: ${chain.explorer}/tx/${sent.hash}`);
  const [decoAfter, baseAfter] = await ammRead.getReserves();
  const balAfter = await deco.balanceOf(BURNER);
  console.log(`Pool reserves after: ${ethers.formatUnits(decoAfter, 18)} DECO / ${ethers.formatUnits(baseAfter, vol.baseDecimals)} ${vol.baseSymbol}`);
  console.log(`Burner DECO after: ${ethers.formatUnits(balAfter, 18)}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
