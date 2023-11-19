const crypto = require('crypto');
const config = require('../modules/config/reader');

const iv = crypto.randomBytes(16);
const secretKey = crypto
    .createHash('sha256')
    .update(String(config.com_server_secret_key))
    .digest('base64')
    .substr(0, 32);

const encrypt = (text) => {
  const cipher = crypto.createCipheriv('aes-256-ctr', secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);

  return {
    iv: iv.toString('hex'),
    content: encrypted.toString('hex'),
  };
};

const decrypt = (hash) => {
  const decipher = crypto.createDecipheriv('aes-256-ctr', secretKey, Buffer.from(hash.iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(hash.content, 'hex')), decipher.final()]);

  return decrypted.toString();
};

module.exports = { encrypt, decrypt };
