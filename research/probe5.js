// Probe round 5: debug v4 getSlot0 revert; check PM owner(); find a live
// poolId from recent Swap logs and query it via PoolManager + StateView.
const { ethers } = require('ethers');
const CHAINS = {
  arc:      { name: 'Arc Testnet',            rpc: 'https://rpc.testnet.arc.io' },
  robinhood:{ name: 'Robinhood Chain Testnet',rpc: 'https://rpc.testnet.chain.robinhood.com/rpc' },
};
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const STATEVIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const UA = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' };
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
console.log('getSlot0(bytes32) selector:', ethers.id('getSlot0(bytes32)').slice(0, 10));
console.log('owner() selector:', ethers.id('owner()').slice(0, 10));
async function main() {
  for (const [key, c] of Object.entries(CHAINS)) {
    console.log(`\n=== ${c.name} ===`);
    try {
      const owner = await call(c.rpc, PM, '0x8da5cb5b');
      console.log(`PM owner(): 0x${owner.slice(26)}`);
    } catch (e) { console.log('PM owner() ERR:', e.message); }
    // Find a live poolId from recent Swap logs
    const swapTopic = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
    try {
      const tip = parseInt(await rpc(c.rpc, 'eth_blockNumber', []), 16);
      const span = key === 'robinhood' ? 10000 : 2000;
      const logs = await rpc(c.rpc, 'eth_getLogs', [{ address: PM, fromBlock: '0x' + (tip - span).toString(16), toBlock: 'latest', topics: [swapTopic] }]);
      console.log(`Swap events in last ${span} blocks: ${logs.length}`);
      if (logs.length > 0) {
        const poolId = logs[0].topics[1];
        console.log(`sample poolId: ${poolId} (block ${parseInt(logs[0].blockNumber, 16)})`);
        const sel = ethers.id('getSlot0(bytes32)').slice(0, 10);
        try {
          const s0 = await call(c.rpc, PM, sel + poolId.slice(2));
          console.log(`PM.getSlot0: sqrtPriceX96=${BigInt('0x' + s0.slice(2, 66))} tick=${parseInt(s0.slice(66, 130), 16)}`);
        } catch (e) { console.log('PM.getSlot0 ERR:', e.message); }
        try {
          const s0 = await call(c.rpc, STATEVIEW, sel + poolId.slice(2));
          console.log(`StateView.getSlot0: sqrtPriceX96=${BigInt('0x' + s0.slice(2, 66))}`);
        } catch (e) { console.log('StateView.getSlot0 ERR:', e.message); }
        // getLiquidity(bytes32) on PM
        try {
          const liqSel = ethers.id('getLiquidity(bytes32)').slice(0, 10);
          const liq = await call(c.rpc, PM, liqSel + poolId.slice(2));
          console.log(`PM.getLiquidity: ${BigInt(liq)}`);
        } catch (e) { console.log('PM.getLiquidity ERR:', e.message); }
      }
    } catch (e) { console.log('Swap logs ERR:', e.message); }
    // getSlot0 on the DECO poolId via StateView (should return 0s, not revert)
    const DECO = '0x5f1dF574015C9D044b4C9Ef658cD55aFcC13D783';
    const sel = ethers.id('getSlot0(bytes32)').slice(0, 10);
    const pair = key === 'arc'
      ? ['0x3600000000000000000000000000000000000000', DECO]
      : [ethers.ZeroAddress, DECO];
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'], [pair[0], pair[1], 3000, 60, ethers.ZeroAddress]));
    try {
      const s0 = await call(c.rpc, STATEVIEW, sel + id.slice(2));
      console.log(`StateView.getSlot0(DECO pool ${id.slice(0, 18)}...): sqrtPriceX96=${BigInt('0x' + s0.slice(2, 66))}`);
    } catch (e) { console.log('StateView DECO getSlot0 ERR:', e.message); }
  }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
