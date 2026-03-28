// Copyright (c) 2026 Ra's al Ghul

const crypto = require('crypto');
const fs = require('fs');

function pemToDer(pem) {
  return Buffer.from(
    String(pem || '')
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, ''),
    'base64'
  );
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64');
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64');
}

function isEncryptedPayload(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version
    && value.algorithm
    && value.wrappedKey
    && value.iv
    && value.ciphertext
  );
}

function createPayloadCryptoError(message, { statusCode = 400, permanent = true } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.permanent = permanent;
  return error;
}

async function encryptPayloadWithPublicKey({
  publicKeyPem,
  payload,
  version = 'v1',
  algorithm = 'RSA-OAEP-256+A256GCM',
  webcryptoImpl = crypto.webcrypto
}) {
  if (!publicKeyPem) {
    throw new Error('A public key PEM is required');
  }

  const publicKey = await webcryptoImpl.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aesKey = await webcryptoImpl.subtle.importKey(
    'raw',
    dataKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.from(await webcryptoImpl.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  ));
  const wrappedKey = Buffer.from(await webcryptoImpl.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    dataKey
  ));

  return {
    version,
    algorithm,
    wrappedKey: toBase64Url(wrappedKey),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext)
  };
}

function createInboundMessageDecryptor({
  env = process.env,
  privateKeyPath = env.MAILBRIDGE_PRIVATE_KEY_PATH,
  fsImpl = fs
} = {}) {
  let privateKeyCache = null;

  function getPrivateKey() {
    if (privateKeyCache) return privateKeyCache;
    if (!privateKeyPath) {
      throw createPayloadCryptoError('MAILBRIDGE_PRIVATE_KEY_PATH is not configured', {
        statusCode: 503,
        permanent: false
      });
    }

    try {
      const privateKeyPem = fsImpl.readFileSync(privateKeyPath, 'utf8');
      privateKeyCache = crypto.createPrivateKey(privateKeyPem);
      return privateKeyCache;
    } catch (error) {
      throw createPayloadCryptoError(`Unable to load Mailbridge private key: ${error.message}`, {
        statusCode: 503,
        permanent: false
      });
    }
  }

  function decryptPayload(encryptedPayload) {
    if (!isEncryptedPayload(encryptedPayload)) {
      throw createPayloadCryptoError('Malformed encrypted payload');
    }

    if (encryptedPayload.version !== 'v1') {
      throw createPayloadCryptoError(`Unsupported encrypted payload version: ${encryptedPayload.version}`);
    }

    if (encryptedPayload.algorithm !== 'RSA-OAEP-256+A256GCM') {
      throw createPayloadCryptoError(`Unsupported encrypted payload algorithm: ${encryptedPayload.algorithm}`);
    }

    try {
      const privateKey = getPrivateKey();
      const wrappedKey = fromBase64Url(encryptedPayload.wrappedKey);
      const iv = fromBase64Url(encryptedPayload.iv);
      const ciphertextWithTag = fromBase64Url(encryptedPayload.ciphertext);

      if (iv.length !== 12 || ciphertextWithTag.length <= 16) {
        throw new Error('Ciphertext envelope is invalid');
      }

      const dataKey = crypto.privateDecrypt({
        key: privateKey,
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
      }, wrappedKey);

      const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
      const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const payload = JSON.parse(plaintext.toString('utf8'));

      if (!payload || typeof payload !== 'object' || !payload.from || !payload.to || !payload.raw) {
        throw new Error('Decrypted payload is missing required mail fields');
      }

      return payload;
    } catch (error) {
      if (error.statusCode) throw error;
      throw createPayloadCryptoError(`Unable to decrypt inbound payload: ${error.message}`);
    }
  }

  return {
    decryptPayload
  };
}

module.exports = {
  createInboundMessageDecryptor,
  createPayloadCryptoError,
  encryptPayloadWithPublicKey,
  isEncryptedPayload
};
