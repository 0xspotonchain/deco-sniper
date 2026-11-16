// Probe round 3: LitVM router mapping + pair tokens + PairCreated activity;
// Arc canonical UniversalRouter + USDC view contract; v4 Initialize activity
// on Arc + Robinhood; bytecode comparison of 0x8366... across chains.
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
function str(hex) {
  try {
    const buf = Buffer.from(hex.slice(2), 'hex');
    const len = parseInt(buf.subarray(64, 96).toString('hex'), 16);
    return buf.subarray(96, 96 + len).toString('utf8');
  } catch { return '?'; }
}
async function main() {
  // --- LitVM routers: which factory + WETH each points at ---
  console.log('=== LitVM V2 routers ===');
  const lit = CHAINS.litvm.rpc;
  for (const router of ['0x03D2D542100fa926de135a08B609c8538E45F6ee', '0x35e8FE95948E1F589751121085c044C6094d993b', '0xd28967D75750f477E450Df81C73f34E2713B86B4']) {
    try {
      const f = await call(lit, router, '0xc45a0155'); // factory()
      const w = await call(lit, router, '0xad5c4648'); // WETH()
      console.log(`${router}\n  factory: ${addr(f)}\n  WETH:    ${addr(w)}`);
    } catch (e) { console.log(`${router} ERR: ${e.message}`); }
  }
  // --- LitVM: token symbols for sampled pair + first 5 pairs ---
  console.log('\n=== LitVM factory 0x5687... pairs ===');
  const factory = '0x5687fda3bde14d38057699c402606ab470eca873';
  for (let i = 0; i < 5; i++) {
    const p = addr(await call(lit, factory, '0x1e3dd18b' + i.toString(16).padStart(64, '0')));
    const t0 = addr(await call(lit, p, '0x0dfe1681'));
    const t1 = addr(await call(lit, p, '0xd21220a7'));
    const res = await call(lit, p, '0x0902f1ac');
    const r0 = BigInt('0x' + res.slice(2, 66)), r1 = BigInt('0x' + res.slice(66, 130));
    const s0 = str(await call(lit, t0, '0x95d89b41'));
    const s1 = str(await call(lit, t1, '0x95d89b41'));
    console.log(`pair[${i}] ${p} :: ${s0} (${t0}) / ${s1} (${t1}) reserves ${r0} / ${r1}`);
  }
  // --- LitVM PairCreated in last 5000 blocks ---
  const tipLit = parseInt(await rpc(lit, 'eth_blockNumber', []), 16);
  const pcTopic = ethers.id('PairCreated(address,address,address,uint256)');
  try {
    const logs = await rpc(lit, 'eth_getLogs', [{ address: factory, fromBlock: '0x' + (tipLit - 5000).toString(16), toBlock: 'latest', topics: [pcTopic] }]);
    console.log(`\nLitVM PairCreated in last 5000 blocks (tip ${tipLit}): ${logs.length}`);
  } catch (e) { console.log('LitVM logs ERR:', e.message); }

  // --- Arc: canonical UniversalRouter + USDC view contract ---
  console.log('\n=== Arc extras ===');
  const arc = CHAINS.arc.rpc;
  for (const [label, a] of [['UniversalRouter (canonical 0x3fC9...)', '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'], ['USDC ERC-20 view 0x3600...', '0x3600000000000000000000000000000000000000']]) {
    const code = await rpc(arc, 'eth_getCode', [a, 'latest']);
    console.log(`${code !== '0x' ? 'CODE ' : 'empty'} ${label}: ${a}${code !== '0x' ? ` (${(code.length - 2) / 2} bytes)` : ''}`);
  }
  // --- v4 Initialize activity ---
  const initTopic = ethers.id('Initialize(bytes32,address,address,uint24,int24,address)');
  for (const [key, c, pm] of [['arc', CHAINS.arc, '0x8366a39CC670B4001A1121B8F6A443A643e40951'], ['arc', CHAINS.arc, '0x1d70945634f618eefdf9edaadb59b9a183cef929'], ['robinhood', CHAINS.robinhood, '0x8366a39CC670B4001A1121B8F6A443A643e40951']]) {
    try {
      const tip = parseInt(await rpc(c.rpc, 'eth_blockNumber', []), 16);
      const logs = await rpc(c.rpc, 'eth_getLogs', [{ address: pm, fromBlock: '0x' + (tip - 10000).toString(16), toBlock: 'latest', topics: [initTopic] }]);
      console.log(`\n${c.name} PM ${pm}: Initialize events in last 10000 blocks (tip ${tip}): ${logs.length}`);
      for (const l of logs.slice(0, 3)) console.log(`  block ${parseInt(l.blockNumber, 16)} poolId ${l.topics[1]}`);
    } catch (e) { console.log(`${c.name} ${pm} logs ERR:`, e.message); }
  }
  // --- bytecode comparison of 0x8366... Arc vs RH ---
  console.log('\n=== 0x8366... bytecode hash ===');
  for (const [key, c] of [['arc', CHAINS.arc], ['robinhood', CHAINS.robinhood]]) {
    const code = await rpc(c.rpc, 'eth_getCode', ['0x8366a39CC670B4001A1121B8F6A443A643e40951', 'latest']);
    console.log(`${c.name}: len ${(code.length - 2) / 2} keccak ${ethers.keccak256(code)}`);
  }
  console.log('\n=== 0x58da... (PositionManager) bytecode hash ===');
  for (const [key, c] of [['arc', CHAINS.arc], ['robinhood', CHAINS.robinhood]]) {
    const code = await rpc(c.rpc, 'eth_getCode', ['0x58daec3116aae6D93017bAAea7749052E8a04fA7', 'latest']);
    console.log(`${c.name}: len ${(code.length - 2) / 2} keccak ${ethers.keccak256(code)}`);
  }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
