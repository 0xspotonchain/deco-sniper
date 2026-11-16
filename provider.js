// ethers v6 providers with a browser-like User-Agent (several public RPCs
// 403 the default UA — same pattern as ~/workspace/wallet-balances/
// check-balances.py) plus chainId verification against config.
const { ethers } = require('ethers');
const { ALLOWED_CHAIN_IDS } = require('./config');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function providerFor(chain) {
  const req = new ethers.FetchRequest(chain.rpc);
  req.setHeader('User-Agent', UA);
  req.timeout = 20000;
  return new ethers.JsonRpcProvider(req, chain.chainId, { staticNetwork: true });
}

// Throws unless the RPC reports a chainId that (a) is in the testnet
// allowlist and (b) matches the chain's configured chainId. Call before any
// signing or state-changing work.
async function assertTestnetChain(provider, chain) {
  const net = await provider.getNetwork();
  const id = Number(net.chainId);
  if (!ALLOWED_CHAIN_IDS.includes(id)) {
    throw new Error(`REFUSED: chainId ${id} is not an allowed testnet (${ALLOWED_CHAIN_IDS.join(', ')}).`);
  }
  if (id !== chain.chainId) {
    throw new Error(`REFUSED: RPC for ${chain.name} reports chainId ${id}, expected ${chain.chainId}.`);
  }
  return id;
}

module.exports = { providerFor, assertTestnetChain };
