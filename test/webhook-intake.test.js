const test = require('node:test');
const assert = require('node:assert/strict');

const { validateWebhookRequest } = require('../lib/webhook-intake');

test('webhook validation prefers worker sender IP over Cloudflare request IP', () => {
  const result = validateWebhookRequest({
    headers: {
      'x-webhook-secret': 'secret',
      'cf-connecting-ip': '198.51.100.10'
    },
    body: {
      from: 'sender@example.com',
      to: 'dest@example.com',
      raw: 'Subject: hi\r\n\r\nbody',
      senderIp: '203.0.113.7'
    },
    ip: '::ffff:127.0.0.1'
  }, 'secret');

  assert.equal(result.ok, true);
  assert.equal(result.messageSourceIp, '203.0.113.7');
  assert.equal(result.requestIp, '198.51.100.10');
});

test('webhook validation accepts encrypted payloads without plaintext mail fields', () => {
  const result = validateWebhookRequest({
    headers: {
      'x-webhook-secret': 'secret',
      'cf-connecting-ip': '198.51.100.10'
    },
    body: {
      encryptedPayload: {
        version: 'v1',
        algorithm: 'RSA-OAEP-256+A256GCM',
        wrappedKey: 'ZmFrZQ==',
        iv: 'ZmFrZQ==',
        ciphertext: 'ZmFrZQ=='
      }
    },
    ip: '::ffff:127.0.0.1'
  }, 'secret');

  assert.equal(result.ok, true);
  assert.equal(result.messageSourceIp, null);
  assert.equal(result.requestIp, '198.51.100.10');
  assert.equal(result.payload.encryptedPayload.version, 'v1');
});
