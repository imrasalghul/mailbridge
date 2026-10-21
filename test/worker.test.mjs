import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDeliveryReceiptStore } = require('../lib/delivery-receipts');
const { createWebhookHandler } = require('../lib/webhook-handler');

import worker, { buildBridgeEndpointUrl } from '../worker.js';

test('worker accepts NODE_APP_URL as a bare origin and appends webhook path', () => {
  assert.equal(
    buildBridgeEndpointUrl('https://mailbridge.example.com'),
    'https://mailbridge.example.com/api/webhook/email'
  );
});

test('worker preserves an explicit webhook path in NODE_APP_URL', () => {
  assert.equal(
    buildBridgeEndpointUrl('https://mailbridge.example.com/custom/inbound'),
    'https://mailbridge.example.com/custom/inbound'
  );
});

test('worker fails clearly when NODE_APP_URL is missing', () => {
  assert.throws(() => buildBridgeEndpointUrl(''), /NODE_APP_URL is not configured/);
});

test('worker send endpoint calls Cloudflare Email Service binding', async () => {
  const sent = [];
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'secret',
    },
    body: JSON.stringify({
      to: ['dest@example.com'],
      from: 'sender@example.com',
      subject: 'Hi',
      text: 'Body',
    }),
  }), {
    WEBHOOK_SECRET: 'secret',
    EMAIL: {
      async send(payload) {
        sent.push(payload);
        return { messageId: 'cf-msg-1' };
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, messageId: 'cf-msg-1' });
  assert.deepEqual(sent, [{
    to: ['dest@example.com'],
    from: 'sender@example.com',
    subject: 'Hi',
    text: 'Body',
  }]);
});

test('worker send endpoint rejects invalid secret before sending', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'wrong',
    },
    body: JSON.stringify({
      to: 'dest@example.com',
      from: 'sender@example.com',
      subject: 'Hi',
      text: 'Body',
    }),
  }), {
    WEBHOOK_SECRET: 'secret',
    EMAIL: {
      async send() {
        throw new Error('should not send');
      },
    },
  });

  assert.equal(response.status, 403);
});

test('worker send endpoint prefers the dedicated outbound webhook secret', async () => {
  let sendCalls = 0;
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'outbound-secret'
    },
    body: JSON.stringify({ from: 'sender@example.com', to: ['dest@example.com'] })
  }), {
    WEBHOOK_SECRET: 'inbound-secret',
    CLOUDFLARE_SEND_WEBHOOK_SECRET: 'outbound-secret',
    EMAIL: {
      async send() {
        sendCalls += 1;
        return { messageId: 'message-2' };
      }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(sendCalls, 1);
});

function queueFixture() {
  const state = { deleted: 0, acked: 0, retried: 0 };
  const body = { objectKey: 'inbound/2026-10-21/fixture.bin', encryptionVersion: 'v1' };
  const encryptedPayload = { version: 'v1', algorithm: 'test', wrappedKey: 'key', iv: 'iv', ciphertext: 'cipher' };
  const object = { text: async () => JSON.stringify(encryptedPayload), customMetadata: { encryptionVersion: 'v1' } };
  const env = { WEBHOOK_SECRET: 'test-secret', NODE_APP_URL: 'https://bridge.example',
    MAIL_STORE: { get: async () => object, delete: async () => { state.deleted++; } } };
  const msg = { body, attempts: 1, ack: () => { state.acked++; }, retry: () => { state.retried++; } };
  return { state, body, env, msg };
}

test('Worker retries infrastructure failures and discards only explicit mail rejections', async t => {
  for (const status of [401, 403, 404, 408, 409, 429, 500, 503, 400, 406, 413, 422]) {
    const { state, env, msg } = queueFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Failure', { status }));
    await worker.queue({ messages: [msg] }, env);
    const permanent = [400, 406, 413, 422].includes(status);
    assert.deepEqual(state, { deleted: +permanent, acked: +permanent, retried: +!permanent }, `HTTP ${status}`);
    t.mock.restoreAll();
  }
});

test('R2 cleanup retries carry the same identity and cannot resend an accepted delivery', async t => {
  const { state, env, msg } = queueFixture();
  const receipts = createDeliveryReceiptStore({ dbPath: ':memory:' });
  await receipts.init();
  t.after(() => new Promise((resolve, reject) => receipts.db.close(error => error ? reject(error) : resolve())));
  let delivered = 0;
  const handler = createWebhookHandler({ webhookSecret: 'test-secret', receiptStore: receipts,
    processWebhook: async () => { delivered++; return { statusCode: 200, body: 'OK' }; } });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const headers = Object.fromEntries(new Headers(options.headers));
    assert.equal(headers['x-mailbridge-delivery-id'], msg.body.objectKey);
    assert.equal(options.redirect, 'error');
    let status;
    let body;
    const res = { type() { return this; }, set() { return this; }, status(value) { status = value; return this; }, send(value) { body = value; } };
    await handler({ headers, body: JSON.parse(options.body) }, res);
    return new Response(body, { status });
  });
  env.MAIL_STORE.delete = async () => { if (++state.deleted === 1) throw new Error('R2 unavailable'); };
  await worker.queue({ messages: [msg] }, env);
  await worker.queue({ messages: [msg] }, env);
  assert.equal(delivered, 1);
  assert.deepEqual(state, { deleted: 2, acked: 1, retried: 1 });
});

test('outbound failures do not expose provider exceptions and unknown failures are retryable', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST', headers: { 'X-Webhook-Secret': 'secret' }, body: '{}'
  }), { WEBHOOK_SECRET: 'secret', EMAIL: { async send() { throw new Error('private-stack-at /secret/file'); } } });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { success: false, error: 'Email provider temporarily unavailable' });
});

test('R2 recovery requires inbound authentication and only requeues encrypted objects', async () => {
  const { env, body } = queueFixture();
  let reads = 0;
  const sent = [];
  const originalGet = env.MAIL_STORE.get;
  env.MAIL_STORE.get = async () => { reads++; return originalGet(); };
  env.MAIL_QUEUE = { send: async value => sent.push(value) };
  env.CLOUDFLARE_SEND_WEBHOOK_SECRET = 'outbound-only';
  const request = secret => new Request('https://worker.example/api/replay/email', {
    method: 'POST', headers: { 'X-Webhook-Secret': secret }, body: JSON.stringify({ objectKey: body.objectKey })
  });
  assert.equal((await worker.fetch(request('outbound-only'), env)).status, 403);
  assert.equal(reads, 0);
  assert.equal((await worker.fetch(request('test-secret'), env)).status, 202);
  assert.deepEqual(sent, [body]);
  env.MAIL_STORE.get = async () => ({ customMetadata: {}, text: async () => 'plaintext mail' });
  assert.equal((await worker.fetch(request('test-secret'), env)).status, 422);
  assert.equal(sent.length, 1);
});
