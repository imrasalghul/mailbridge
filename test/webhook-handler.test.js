const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createWebhookHandler } = require('../lib/webhook-handler');
const { createDeliveryReceiptStore } = require('../lib/delivery-receipts');

async function harness(t, processWebhook, options = { receiptsEnabled: true }) {
  const receiptStore = options.receiptsEnabled ? createDeliveryReceiptStore({ dbPath: ':memory:' }) : undefined;
  if (receiptStore) await receiptStore.init();
  const app = express();
  app.use(express.json());
  app.post('/email', createWebhookHandler({ webhookSecret: 'test-secret', receiptStore, processWebhook, ...options }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (receiptStore) await new Promise((resolve, reject) => receiptStore.db.close(error => error ? reject(error) : resolve()));
  });
  return (body, secret = 'test-secret', id = 'object-1') => fetch(`http://127.0.0.1:${server.address().port}/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret, ...(id ? { 'X-Mailbridge-Delivery-Id': id } : {}) },
    body: JSON.stringify(body)
  });
}
const payload = { from: '', to: 'recipient@example.com', raw: 'Subject: notice\r\n\r\nDelivery notification' };

test('webhook checks authentication before retrieving a completed delivery', async t => {
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; });
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload, 'wrong')).status, 403);
  assert.equal((await post(payload)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post({ ...payload, raw: 'Different mail' })).status, 409);
});

test('webhook errors never expose exception text or render mail content as HTML', async t => {
  const marker = '<script>alert("private stack /secret/path")</script>';
  const post = await harness(t, async () => { throw new Error(marker); });
  const response = await post(payload);
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.doesNotMatch(await response.text(), /script|private|secret/);
});

test('plain webhook calls without a delivery ID remain distinct deliveries', async t => {
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; });
  for (let i = 0; i < 2; i++) assert.equal((await post(payload, 'test-secret', null)).status, 200);
  assert.equal(calls, 2);
});

test('modern receipts deduplicate encrypted requests from older Workers by ciphertext', async t => {
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; });
  const body = { encryptedPayload: { version: 'v1', algorithm: 'test', wrappedKey: 'key', iv: 'iv', ciphertext: 'cipher' } };
  for (let i = 0; i < 2; i++) assert.equal((await post(body, 'test-secret', null)).status, 200);
  assert.equal(calls, 1);
});

test('encrypted retries keep their receipt identity while Worker delivery headers roll out', async t => {
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; });
  const encryptedPayload = { version: 'v1', algorithm: 'test', wrappedKey: 'key', iv: 'iv', ciphertext: 'cipher' };
  assert.equal((await post({ encryptedPayload }, 'test-secret', null)).status, 200);
  assert.equal((await post({ encryptedPayload }, 'test-secret', 'new-worker-object')).status, 200);
  const nextPayload = { encryptedPayload: { ...encryptedPayload, ciphertext: 'different' } };
  assert.equal((await post(nextPayload, 'test-secret', 'second-object')).status, 200);
  assert.equal((await post(nextPayload, 'test-secret', null)).status, 200);
  assert.equal((await post(nextPayload, 'test-secret', 'new-worker-object')).status, 409);
  assert.equal(calls, 2);
});

test('legacy webhook requests ignore delivery identities without a receipt store', async t => {
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; }, { receiptsEnabled: false });
  const encryptedPayload = { version: 'v1', algorithm: 'test', wrappedKey: 'key', iv: 'iv', ciphertext: 'cipher' };
  assert.equal((await post({ encryptedPayload }, 'test-secret', 'x'.repeat(513))).status, 200);
  assert.equal((await post({ encryptedPayload }, 'test-secret', 'x'.repeat(513))).status, 200);
  assert.equal((await post(payload, 'test-secret', 'same-object')).status, 200);
  assert.equal((await post({ ...payload, raw: 'Another message' }, 'test-secret', 'same-object')).status, 200);
  assert.equal(calls, 4);
});

test('webhook defaults to independent deliveries when compatibility settings are absent', async t => {
  const names = ['MAILBRIDGE_BEHAVIOR_PROFILE', 'MAILBRIDGE_DELIVERY_RECEIPTS'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => { delete process.env[name]; });
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  let calls = 0;
  const post = await harness(t, async () => { calls++; return { statusCode: 200, body: 'OK' }; }, {});
  const body = { encryptedPayload: { version: 'v1', algorithm: 'test', wrappedKey: 'key', iv: 'iv', ciphertext: 'cipher' } };
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200);
  assert.equal(calls, 2);
});
