// VM keystore access — reuses the exact pattern from
// ~/workspace/multichain-wallet/generate.js (AES-256-GCM, key in a separate
// 0600 file). The private key is decrypted in memory only and is NEVER
// printed, logged, or written anywhere by this module. Dry-run mode never
// calls this module at all (no signing needed to build unsigned calldata).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const HOME = process.env.HOME;
const KEYSTORE_PATH = path.join(HOME, 'workspace', 'multichain-wallet', 'keystore.enc.json');
const VM_KEY_PATH = path.join(HOME, '.config', 'multichain-wallet', 'vm-key');
const EXPECTED_EVM = '0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31';

function decryptAesGcm(enc, keyBuf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
}

// Returns an ethers.Wallet connected to `provider`. Throws if the keystore
// is missing/unreadable or the derived address is not the burner EVM address.
function loadBurnerWallet(provider) {
  const ks = JSON.parse(fs.readFileSync(KEYSTORE_PATH, 'utf8'));
  if (ks.format !== 'muse-vm-keystore-v1' || ks.cipher !== 'aes-256-gcm') {
    throw new Error('Unexpected keystore format — refusing to decrypt.');
  }
  const key = Buffer.from(fs.readFileSync(VM_KEY_PATH, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error('VM key is not 32 bytes — refusing to decrypt.');
  const payload = JSON.parse(decryptAesGcm(ks, key).toString('utf8'));
  const privkey = payload.keys.evm.privateKey;
  const wallet = new ethers.Wallet(privkey, provider);
  if (wallet.address.toLowerCase() !== EXPECTED_EVM.toLowerCase()) {
    throw new Error('Decrypted key does not match the burner EVM address — refusing to sign.');
  }
  return wallet;
}

module.exports = { loadBurnerWallet, EXPECTED_EVM };
