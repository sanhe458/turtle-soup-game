const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// Derive a 32-byte key from the KEK env var using scrypt
function getKey() {
  const kek = process.env.API_KEY_ENCRYPTION_KEY;
  if (!kek || kek.length < 16) {
    throw new Error('API_KEY_ENCRYPTION_KEY 必须设置且长度>=16');
  }
  return crypto.scryptSync(kek, 'turtle-soup-salt', 32);
}

function encrypt(plain) {
  if (!plain) return '';
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv) + ':' + base64(tag) + ':' + base64(enc)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(encStr) {
  if (!encStr) return '';
  // If the value doesn't look encrypted (no colons), return as-is for backward compat with legacy plaintext
  const parts = encStr.split(':');
  if (parts.length !== 3) return encStr;
  const key = getKey();
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const enc = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt };
