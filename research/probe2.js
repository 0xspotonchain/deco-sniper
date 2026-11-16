// Probe round 2: check the specific v4 addresses found in research, plus
// LitVM's V2 pair contracts (factory()/token0/token1/getReserves).
const CHAINS = {
  arc:      { name: 'Arc Testnet',            rpc: 'https://rpc.testnet.arc.io',                  chainId: 5042002 },
  robinhood:{ name: 'Robinhood Chain Testnet',rpc: 'https://rpc.testnet.chain.robinhood.com/rpc', chainId: 46630 },
  litvm:    { name: 'LitVM LiteForge',        rpc: 'https://rpc.testnet.liteforge.zeeve.net/',     chainId: 4441 },
};
const ADDRS = {
  'v4 PoolManager (official RH/Arc mainnet addr)': '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  'v4 PoolManager (Radian Arc testnet)':           '0x24219d0F3611fE4E438850bB7DB165439957dc9f',
  'v4 PositionManager':                            '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  'UniversalRouter':                               '0x8876789976decbfcbbbe364623c63652db8c0904',
  'v4 Quoter (RH mainnet addr)':                   '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  'v4 PoolManager (LitVM Blockscout)':             '0xDF6166bEf93B3aE8BFCe73225Dc5348c5A0Ad96A',
  'v4 PoolManager (Bitquery Arc)':                 '0x1d70945634f618eefdf9edaadb59b9a183cef929',
};
const UA = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' };
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
const call = (rpcUrl, to, data) => rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest']);

async function main() {
  for (const [key, c] of Object.entries(CHAINS)) {
    console.log(`\n=== ${c.name} ===`);
    for (const [label, addr] of Object.entries(ADDRS)) {
      try {
        const code = await rpc(c.rpc, 'eth_getCode', [addr, 'latest']);
        const hasCode = code && code !== '0x';
        console.log(`${hasCode ? 'CODE ' : 'empty'} ${label}: ${addr}${hasCode ? ` (${(code.length - 2) / 2} bytes)` : ''}`);
      } catch (e) { console.log(`ERR   ${label}: ${e.message}`); }
    }
  }

  // LitVM V2 pair inspection
  console.log('\n=== LitVM V2 pair 0x02580ba4b52ca612F1625A77127309245A697C25 ===');
  const lit = CHAINS.litvm.rpc;
  const pair = '0x02580ba4b52ca612F1625A77127309245A697C25';
  try {
    const factory = await call(lit, pair, '0xc45a0155'); // factory()
    const token0 = await call(lit, pair, '0x0dfe1681');  // token0()
    const token1 = await call(lit, pair, '0xd21220a7');  // token1()
    const reserves = await call(lit, pair, '0x0902f1ac'); // getReserves()
    console.log('factory():', '0x' + factory.slice(26));
    console.log('token0():', '0x' + token0.slice(26));
    console.log('token1():', '0x' + token1.slice(26));
    const r0 = BigInt('0x' + reserves.slice(2, 66));
    const r1 = BigInt('0x' + reserves.slice(66, 130));
    console.log(`reserves: token0=${r0} token1=${r1}`);
    const f = '0x' + factory.slice(26);
    const n = await call(lit, f, '0x574f2ba3'); // allPairsLength()
    console.log(`factory ${f} allPairsLength: ${parseInt(n, 16)}`);
    // sample first 5 pairs
    for (let i = 0; i < Math.min(5, parseInt(n, 16)); i++) {
      const p = await call(lit, f, '0x1e3dd18b' + i.toString(16).padStart(64, '0')); // allPairs(i)
      console.log(`  allPairs(${i}): 0x${p.slice(26)}`);
    }
  } catch (e) { console.log('LitVM pair ERR:', e.message); }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
