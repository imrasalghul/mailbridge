// Copyright (c) 2026 Ra's al Ghul

const crypto = require('crypto');

function parseQueueMasterKey(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    throw new Error('QUEUE_MASTER_KEY is required to protect queued mail at rest');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    throw new Error('QUEUE_MASTER_KEY must be a base64-encoded 32-byte value');
  }

  return decoded;
}

function serializeRaw(raw) {
  if (Buffer.isBuffer(raw)) {
    return { encoding: 'base64', value: raw.toString('base64') };
  }

  return {
    encoding: 'utf8',
    value: String(raw || '')
  };
}

function deserializeRaw(serializedRaw) {
  if (!serializedRaw || typeof serializedRaw !== 'object') return '';
  if (serializedRaw.encoding === 'base64') {
    return Buffer.from(serializedRaw.value || '', 'base64');
  }
  return serializedRaw.value || '';
}

function createQueueCrypto({ env = process.env, masterKey = env.QUEUE_MASTER_KEY } = {}) {
  const masterKeyBytes = parseQueueMasterKey(masterKey);
  const auditKey = Buffer.from(crypto.hkdfSync(
    'sha256',
    masterKeyBytes,
    Buffer.from('mailbridge-audit-salt', 'utf8'),
    Buffer.from('mailbridge-audit-v1', 'utf8'),
    32
  ));

  function generatePerMessageSecret() {
    return crypto.randomBytes(32).toString('base64');
  }

  function deriveQueueKey(queueId, perMessageSecret) {
    const secretBytes = Buffer.from(String(perMessageSecret || ''), 'base64');
    if (secretBytes.length !== 32) {
      throw new Error(`Queue item ${queueId || 'unknown'} is missing a valid per-message secret`);
    }

    return Buffer.from(crypto.hkdfSync(
      'sha256',
      masterKeyBytes,
      secretBytes,
      Buffer.from(`mailbridge-queue:${queueId}`, 'utf8'),
      32
    ));
  }

  function encryptQueuePayload({ queueId, perMessageSecret, payload }) {
    const iv = crypto.randomBytes(12);
    const key = deriveQueueKey(queueId, perMessageSecret);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  function decryptQueuePayload({ queueId, perMessageSecret, encryptedPayload }) {
    const buffer = Buffer.isBuffer(encryptedPayload)
      ? encryptedPayload
      : Buffer.from(encryptedPayload || '');

    if (buffer.length < 29) {
      throw new Error(`Queue item ${queueId || 'unknown'} is too short to decrypt`);
    }

    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    const key = deriveQueueKey(queueId, perMessageSecret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  function hashAuditValue(namespace, value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return crypto
      .createHmac('sha256', auditKey)
      .update(`${namespace}:${normalized}`, 'utf8')
      .digest('hex');
  }

  function signAuditEvent(eventPayload) {
    return crypto
      .createHmac('sha256', auditKey)
      .update(JSON.stringify(eventPayload), 'utf8')
      .digest('hex');
  }

  return {
    decryptQueuePayload,
    deserializeRaw,
    encryptQueuePayload,
    generatePerMessageSecret,
    hashAuditValue,
    parseQueueMasterKey,
    serializeRaw,
    signAuditEvent
  };
}

module.exports = {
  createQueueCrypto,
  deserializeRaw,
  parseQueueMasterKey,
  serializeRaw
};
