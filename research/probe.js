// One-off DEX probe: check for contract code at canonical DEX addresses on
// the three testnets. Read-only, no keys. Uses raw JSON-RPC via fetch.
const CHAINS = {
  arc:      { name: 'Arc Testnet',            rpc: 'https://rpc.testnet.arc.io',                  chainId: 5042002 },
  robinhood:{ name: 'Robinhood Chain Testnet',rpc: 'https://rpc.testnet.chain.robinhood.com/rpc', chainId: 46630 },
  litvm:    { name: 'LitVM LiteForge',        rpc: 'https://rpc.testnet.liteforge.zeeve.net/',     chainId: 4441 },
};
const ADDRS = {
  'Uni V2 Factory':        '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  'Uni V2 Router02':       '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  'Uni V3 Factory':        '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  'Uni V3 SwapRouter':     '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  'Uni V3 SwapRouter02':   '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  'Uni V4 PoolManager (canonical)': '0x000000000004444c5dc75cB358380D2e3dE08A90',
  'Uni V4 PoolManager (Arc per Bitquery)': '0x1d70945634f618eefdf9edaadb59b9a183cef929',
  'Permit2':               '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  'WETH9 (mainnet addr)':  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};
const UA = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' };

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function main() {
  for (const [key, c] of Object.entries(CHAINS)) {
    console.log(`\n=== ${c.name} (chain ${c.chainId}) ===`);
    try {
      const cid = await rpc(c.rpc, 'eth_chainId', []);
      const block = await rpc(c.rpc, 'eth_blockNumber', []);
      console.log(`chainId: ${parseInt(cid, 16)} (expected ${c.chainId})  block: ${parseInt(block, 16)}`);
    } catch (e) { console.log(`RPC ERROR: ${e.message}`); continue; }
    for (const [label, addr] of Object.entries(ADDRS)) {
      try {
        const code = await rpc(c.rpc, 'eth_getCode', [addr, 'latest']);
        const hasCode = code && code !== '0x';
        console.log(`${hasCode ? 'CODE ' : 'empty'} ${label}: ${addr}${hasCode ? ` (${(code.length - 2) / 2} bytes)` : ''}`);
      } catch (e) { console.log(`ERR   ${label}: ${e.message}`); }
    }
    // If V2 factory has code, read allPairsLength (0x574f2ba3)
    try {
      const code = await rpc(c.rpc, 'eth_getCode', [ADDRS['Uni V2 Factory'], 'latest']);
      if (code && code !== '0x') {
        const n = await rpc(c.rpc, 'eth_call', [{ to: ADDRS['Uni V2 Factory'], data: '0x574f2ba3' }, 'latest']);
        console.log(`V2 factory allPairsLength: ${parseInt(n, 16)}`);
      }
    } catch (e) { console.log(`V2 allPairsLength ERR: ${e.message}`); }
  }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
