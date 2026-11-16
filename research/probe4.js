// Probe round 4: official v3 addresses (RH mainnet docs + Arc mainnet sdk-core)
// on the three TESTNETS; StateView; DECO token + DECO pool existence;
// recent pool-creation activity in RPC-safe windows.
const { ethers } = require('ethers');
const CHAINS = {
  arc:      { name: 'Arc Testnet',            rpc: 'https://rpc.testnet.arc.io',                  chainId: 5042002 },
  robinhood:{ name: 'Robinhood Chain Testnet',rpc: 'https://rpc.testnet.chain.robinhood.com/rpc', chainId: 46630 },
  litvm:    { name: 'LitVM LiteForge',        rpc: 'https://rpc.testnet.liteforge.zeeve.net/',     chainId: 4441 },
};
const UA = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' };
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const addr = (hex) => '0x' + hex.slice(26);

// Addresses to check on every testnet (label, address, source)
const CHECK = [
  ['RH v3 Factory (Uniswap docs 4663)', '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'],
  ['RH v3 SwapRouter02 (Uniswap docs 4663)', '0xcaf681a66d020601342297493863e78c959e5cb2'],
  ['RH v3 NFPM (Uniswap docs 4663)', '0x73991a25c818bf1f1128deaab1492d45638de0d3'],
  ['RH v3 QuoterV2 (Uniswap docs 4663)', '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'],
  ['RH v4 StateView (Uniswap docs 4663)', '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'],
  ['Arc v3 Factory (sdk-core ARC)', '0xf0db7b58379503491d857dB50AC9ece64c653918'],
  ['Arc v3 SwapRouter02 (sdk-core ARC)', '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77'],
  ['Arc v3 NFPM (sdk-core ARC)', '0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377'],
  ['Arc v3 QuoterV2 (sdk-core ARC)', '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468'],
  ['Arc v2 Factory (Eco docs 5042)', '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba'],
];
const DECO = '0x5f1dF574015C9D044b4C9Ef658cD55aFcC13D783';
const BURNER = '0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31';

async function main() {
  for (const [key, c] of Object.entries(CHAINS)) {
    console.log(`\n=== ${c.name} ===`);
    for (const [label, a] of CHECK) {
      try {
        const code = await rpc(c.rpc, 'eth_getCode', [a, 'latest']);
        const has = code !== '0x';
        console.log(`${has ? 'CODE ' : 'empty'} ${label}: ${a}${has ? ` (${(code.length - 2) / 2} bytes)` : ''}`);
      } catch (e) { console.log(`ERR   ${label}: ${e.message}`); }
    }
    // DECO token
    try {
      const code = await rpc(c.rpc, 'eth_getCode', [DECO, 'latest']);
      const bal = await call(c.rpc, DECO, '0x70a08231' + BURNER.slice(2).padStart(64, '0'));
      const ts = await call(c.rpc, DECO, '0x18160ddd'); // totalSupply()
      console.log(`DECO ${code !== '0x' ? 'CODE' : 'EMPTY'}: burner balance ${ethers.formatEther(bal)} DECO, totalSupply ${ethers.formatEther(ts)}`);
    } catch (e) { console.log('DECO ERR:', e.message); }
  }

  // --- DECO pool existence ---
  console.log('\n=== DECO pool existence ===');
  // LitVM V2: getPair(DECO, WETH) on factory 0x5687...
  try {
    const data = '0xe6a43905' + DECO.slice(2).padStart(64, '0') + '4fd3765cde8d1d2be4edbaa03940afc56794c304'.padStart(64, '0');
    const pair = await call(CHAINS.litvm.rpc, '0x5687fda3bde14d38057699c402606ab470eca873', data);
    console.log(`LitVM V2 getPair(DECO, WETH): ${addr(pair)} ${pair === '0x' + '0'.repeat(64) ? '(no pool yet)' : '(POOL EXISTS)'}`);
  } catch (e) { console.log('LitVM getPair ERR:', e.message); }
  // v4: getSlot0(poolId) — 0 sqrtPrice means uninitialized
  const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
  const getSlot0Sel = ethers.id('getSlot0(bytes32)').slice(0, 10);
  function poolId(c0, c1, fee, tickSpacing, hooks) {
    const key = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, tickSpacing, hooks]);
    return ethers.keccak256(key);
  }
  // Arc: DECO vs USDC ERC-20 view 0x3600... (fee 3000, tickSpacing 60, hooks 0)
  try {
    const id = poolId('0x3600000000000000000000000000000000000000', DECO, 3000, 60, ethers.ZeroAddress);
    const slot0 = await call(CHAINS.arc.rpc, PM, getSlot0Sel + id.slice(2));
    const sqrt = BigInt('0x' + slot0.slice(2, 66));
    console.log(`Arc v4 DECO/USDC-view poolId ${id}: sqrtPriceX96=${sqrt} ${sqrt === 0n ? '(not initialized)' : '(INITIALIZED)'}`);
  } catch (e) { console.log('Arc v4 pool ERR:', e.message); }
  // RH: DECO vs native ETH (address 0)
  try {
    const id = poolId(ethers.ZeroAddress, DECO, 3000, 60, ethers.ZeroAddress);
    const slot0 = await call(CHAINS.robinhood.rpc, PM, getSlot0Sel + id.slice(2));
    const sqrt = BigInt('0x' + slot0.slice(2, 66));
    console.log(`RH v4 DECO/ETH poolId ${id}: sqrtPriceX96=${sqrt} ${sqrt === 0n ? '(not initialized)' : '(INITIALIZED)'}`);
  } catch (e) { console.log('RH v4 pool ERR:', e.message); }
  // Arc v3: getPool(DECO, USDC view, 3000) if factory has code
  try {
    const code = await rpc(CHAINS.arc.rpc, 'eth_getCode', ['0xf0db7b58379503491d857dB50AC9ece64c653918', 'latest']);
    if (code !== '0x') {
      const data = '0x1698ee82' + DECO.slice(2).padStart(64, '0') + '3600000000000000000000000000000000000000'.padStart(64, '0') + (3000).toString(16).padStart(64, '0');
      const pool = await call(CHAINS.arc.rpc, '0xf0db7b58379503491d857dB50AC9ece64c653918', data);
      console.log(`Arc v3 getPool(DECO, USDC, 3000): ${addr(pool)} ${pool === '0x' + '0'.repeat(64) ? '(no pool yet)' : '(POOL EXISTS)'}`);
    } else console.log('Arc v3 factory: no code, getPool skipped');
  } catch (e) { console.log('Arc v3 getPool ERR:', e.message); }

  // --- Recent pool-creation activity (RPC-safe windows) ---
  console.log('\n=== Recent pool-creation activity ===');
  const initTopic = ethers.id('Initialize(bytes32,address,address,uint24,int24,address)');
  const pcTopic = ethers.id('PairCreated(address,address,address,uint256)');
  async function countLogs(c, address, topic, span, label) {
    try {
      const tip = parseInt(await rpc(c.rpc, 'eth_blockNumber', []), 16);
      const logs = await rpc(c.rpc, 'eth_getLogs', [{ address, fromBlock: '0x' + (tip - span).toString(16), toBlock: 'latest', topics: [topic] }]);
      console.log(`${label}: ${logs.length} in last ${span} blocks (tip ${tip})`);
    } catch (e) { console.log(`${label} ERR: ${e.message}`); }
  }
  await countLogs(CHAINS.litvm, '0x5687fda3bde14d38057699c402606ab470eca873', pcTopic, 3000, 'LitVM V2 PairCreated');
  await countLogs(CHAINS.arc, PM, initTopic, 2000, 'Arc v4 (0x8366) Initialize');
  await countLogs(CHAINS.arc, '0x1d70945634f618eefdf9edaadb59b9a183cef929', initTopic, 2000, 'Arc v4 (0x1d70) Initialize');
  const tipRH = parseInt(await rpc(CHAINS.robinhood.rpc, 'eth_blockNumber', []), 16);
  let total = 0;
  for (let w = 0; w < 3; w++) {
    const to = tipRH - w * 10000, from = to - 10000;
    try {
      const logs = await rpc(CHAINS.robinhood.rpc, 'eth_getLogs', [{ address: PM, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [initTopic] }]);
      total += logs.length;
    } catch (e) { console.log(`RH window ${w} ERR: ${e.message}`); }
  }
  console.log(`RH v4 (0x8366) Initialize: ${total} in last 30000 blocks (~50 min at 100ms/block)`);
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
