const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createInboundMessageDecryptor,
  encryptPayloadWithPublicKey
} = require('../lib/inbound-message-crypto');

test('mailbridge can decrypt worker-compatible encrypted payloads', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-r2-crypto-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const privateKeyPath = path.join(tempDir, 'mailbridge-r2-private.pem');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

  const encryptedPayload = await encryptPayloadWithPublicKey({
    publicKeyPem,
    payload: {
      from: 'sender@example.com',
      to: 'dest@example.com',
      senderIp: '203.0.113.7',
      raw: 'Subject: hi\r\n\r\nbody',
      receivedAt: '2026-03-28T00:00:00.000Z'
    }
  });

  const decryptor = createInboundMessageDecryptor({
    privateKeyPath
  });
  const decryptedPayload = decryptor.decryptPayload(encryptedPayload);

  assert.deepEqual(decryptedPayload, {
    from: 'sender@example.com',
    to: 'dest@example.com',
    senderIp: '203.0.113.7',
    raw: 'Subject: hi\r\n\r\nbody',
    receivedAt: '2026-03-28T00:00:00.000Z'
  });
});

test('mailbridge rejects malformed encrypted payloads safely', () => {
  const decryptor = createInboundMessageDecryptor({
    privateKeyPath: '/definitely/missing.pem'
  });

  assert.throws(
    () => decryptor.decryptPayload({ version: 'v1' }),
    /Malformed encrypted payload/
  );
});

test('mailbridge rejects decrypted payloads with non-string mail fields', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-r2-crypto-fields-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = path.join(tempDir, 'private.pem');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const encryptedPayload = await encryptPayloadWithPublicKey({
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    payload: {
      from: { address: 'sender@example.com' },
      to: 'dest@example.com',
      raw: 'Subject: hi\r\n\r\nbody'
    }
  });

  const decryptor = createInboundMessageDecryptor({ privateKeyPath });
  assert.throws(
    () => decryptor.decryptPayload(encryptedPayload),
    /missing required mail fields/
  );
});

test('a valid envelope encrypted for another key is retained for configuration recovery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-crypto-key-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const senderKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'fixture.pem');
  fs.writeFileSync(keyPath, wrongKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const envelope = await encryptPayloadWithPublicKey({ publicKeyPem: senderKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    payload: { from: '', to: 'recipient@example.com', raw: 'Subject: notice\r\n\r\nSynthetic notification' } });
  assert.throws(() => createInboundMessageDecryptor({ privateKeyPath: keyPath }).decryptPayload(envelope), error => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.permanent, false);
    return true;
  });
});
