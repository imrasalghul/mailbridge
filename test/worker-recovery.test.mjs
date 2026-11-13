import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInboundMessageDecryptor } = require('../lib/inbound-message-crypto');

import worker, { bytesToBase64, sweepStoredMessages } from '../worker.js';

const HOUR = 60 * 60 * 1000;

function r2Store(objects = {}) {
  const calls = { put: [], deleted: [] };
  const store = {
    calls,
    objects,
    async get(key) {
      const object = objects[key];
      if (!object) return null;
      return {
        customMetadata: object.customMetadata,
        httpMetadata: object.httpMetadata,
        text: async () => Buffer.from(object.body).toString('utf8'),
        arrayBuffer: async () => Uint8Array.from(Buffer.from(object.body)).buffer,
      };
    },
    async put(key, body, options) {
      calls.put.push({ key, options });
      objects[key] = { body: Buffer.from(body), ...options, uploaded: new Date() };
    },
    async delete(key) {
      calls.deleted.push(key);
      delete objects[key];
    },
    async list({ prefix, cursor, limit }) {
      const keys = Object.keys(objects).filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const next = start + page.length;
      return {
        objects: page.map(key => ({ key, uploaded: objects[key].uploaded, customMetadata: objects[key].customMetadata })),
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
  };
  return store;
}

function storedObject(ageMs, metadata = { encryptionVersion: 'v1' }) {
  return { body: '{"version":"v1"}', customMetadata: metadata, uploaded: new Date(Date.now() - ageMs) };
}

function sweepEnv(objects, settings = {}) {
  const batches = [];
  return {
    batches,
    env: {
      NODE_APP_URL: 'https://bridge.example/api/webhook/email',
      MAIL_STORE: r2Store(objects),
      MAIL_QUEUE: { sendBatch: async messages => batches.push(messages) },
      ...settings,
    },
  };
}

test('sweep re-queues stored mail older than the minimum age once the backend is healthy', async t => {
  const { env, batches } = sweepEnv({
    'inbound/2026-11-09/old-1.bin': storedObject(2 * HOUR),
    'inbound/2026-11-09/old-2.bin': storedObject(3 * HOUR),
    'inbound/2026-11-09/recent.bin': storedObject(5 * 60 * 1000),
    'inbound/2026-11-09/legacy-plaintext.bin': storedObject(2 * HOUR, {}),
    'failed/2026-11-09/rejected.bin': storedObject(2 * HOUR),
  });
  const probed = [];
  t.mock.method(globalThis, 'fetch', async url => { probed.push(String(url)); return new Response('OK'); });
  assert.deepEqual(await sweepStoredMessages(env), { requeued: 2 });
  assert.deepEqual(probed, ['https://bridge.example/health']);
  assert.deepEqual(batches.flat().map(m => m.body), [
    { objectKey: 'inbound/2026-11-09/old-1.bin', encryptionVersion: 'v1' },
    { objectKey: 'inbound/2026-11-09/old-2.bin', encryptionVersion: 'v1' },
  ]);
});

test('sweep spends no queue operations while the backend is down', async t => {
  for (const failure of [async () => new Response('down', { status: 502 }), async () => { throw new Error('refused'); }]) {
    const { env, batches } = sweepEnv({ 'inbound/2026-11-09/old.bin': storedObject(2 * HOUR) });
    t.mock.method(globalThis, 'fetch', failure);
    assert.deepEqual(await sweepStoredMessages(env), { requeued: 0 });
    assert.equal(batches.length, 0);
    t.mock.restoreAll();
  }
});

test('sweep pages through R2, sends at most 100 per batch, and stops at the per-run limit', async t => {
  const objects = {};
  for (let i = 0; i < 1300; i++) objects[`inbound/2026-11-09/m-${String(i).padStart(4, '0')}.bin`] = storedObject(2 * HOUR);
  const { env, batches } = sweepEnv(objects, { MAILBRIDGE_SWEEP_MAX_MESSAGES: '1050' });
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  assert.deepEqual(await sweepStoredMessages(env), { requeued: 1050 });
  assert.ok(batches.every(batch => batch.length <= 100));
  assert.equal(batches.flat().length, 1050);
});

test('the cron handler only sweeps when MAILBRIDGE_SWEEP is on', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  for (const [setting, expected] of [[undefined, 0], ['false', 0], ['true', 1]]) {
    const { env, batches } = sweepEnv({ 'inbound/2026-11-09/old.bin': storedObject(2 * HOUR) },
      setting === undefined ? {} : { MAILBRIDGE_SWEEP: setting });
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    assert.equal(batches.flat().length, expected, `MAILBRIDGE_SWEEP=${setting}`);
  }
});

function queueMessage(objectKey) {
  const state = { acked: 0, retried: 0 };
  return { state, msg: { body: { objectKey, encryptionVersion: 'v1' }, attempts: 1, ack: () => { state.acked++; }, retry: () => { state.retried++; } } };
}

test('permanently rejected mail is kept under failed/ instead of deleted when MAILBRIDGE_KEEP_FAILED is on', async t => {
  for (const settings of [{ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' }, { MAILBRIDGE_KEEP_FAILED: 'true' }]) {
    const key = 'inbound/2026-11-09/rejected.bin';
    const store = r2Store({ [key]: storedObject(0) });
    const { state, msg } = queueMessage(key);
    t.mock.method(globalThis, 'fetch', async () => new Response('Permanently rejected', { status: 422 }));
    await worker.queue({ messages: [msg] }, { WEBHOOK_SECRET: 's', NODE_APP_URL: 'https://bridge.example', MAIL_STORE: store, ...settings });
    assert.deepEqual(state, { acked: 1, retried: 0 });
    assert.deepEqual(Object.keys(store.objects), ['failed/2026-11-09/rejected.bin']);
    const kept = store.objects['failed/2026-11-09/rejected.bin'];
    assert.equal(kept.customMetadata.encryptionVersion, 'v1');
    assert.equal(kept.customMetadata.failedStatus, '422');
    assert.match(kept.customMetadata.failedAt, /^\d{4}-\d{2}-\d{2}T/);
    t.mock.restoreAll();
  }
});

test('a replayed failed/ message that is rejected again stays where it is', async t => {
  const key = 'failed/2026-11-09/rejected.bin';
  const store = r2Store({ [key]: storedObject(0) });
  const { state, msg } = queueMessage(key);
  t.mock.method(globalThis, 'fetch', async () => new Response('Rejected', { status: 406 }));
  await worker.queue({ messages: [msg] }, { WEBHOOK_SECRET: 's', NODE_APP_URL: 'https://bridge.example', MAIL_STORE: store, MAILBRIDGE_KEEP_FAILED: 'true' });
  assert.deepEqual(state, { acked: 1, retried: 0 });
  assert.deepEqual(store.calls.deleted, []);
  assert.deepEqual(Object.keys(store.objects), [key]);
});

test('keeping failed mail retries instead of deleting when R2 is unavailable', async t => {
  const key = 'inbound/2026-11-09/rejected.bin';
  const store = r2Store({ [key]: storedObject(0) });
  store.put = async () => { throw new Error('R2 unavailable'); };
  const { state, msg } = queueMessage(key);
  t.mock.method(globalThis, 'fetch', async () => new Response('Rejected', { status: 422 }));
  await worker.queue({ messages: [msg] }, { WEBHOOK_SECRET: 's', NODE_APP_URL: 'https://bridge.example', MAIL_STORE: store, MAILBRIDGE_KEEP_FAILED: 'true' });
  assert.deepEqual(state, { acked: 0, retried: 1 });
  assert.ok(store.objects[key]);
});

test('replay accepts kept failed/ objects and still rejects other keys', async () => {
  const sent = [];
  const env = {
    WEBHOOK_SECRET: 's',
    MAIL_STORE: r2Store({ 'failed/2026-11-09/rejected.bin': storedObject(0), 'other/2026-11-09/x.bin': storedObject(0) }),
    MAIL_QUEUE: { send: async value => sent.push(value) },
  };
  const replay = objectKey => worker.fetch(new Request('https://worker.example/api/replay/email', {
    method: 'POST', headers: { 'X-Webhook-Secret': 's' }, body: JSON.stringify({ objectKey })
  }), env);
  assert.equal((await replay('failed/2026-11-09/rejected.bin')).status, 202);
  assert.equal((await replay('other/2026-11-09/x.bin')).status, 400);
  assert.equal((await replay('failed/../inbound/x.bin')).status, 400);
  assert.deepEqual(sent, [{ objectKey: 'failed/2026-11-09/rejected.bin', encryptionVersion: 'v1' }]);
});

test('invalid recovery settings fail without deleting queued mail', async t => {
  for (const settings of [{ MAILBRIDGE_KEEP_FAILED: 'maybe' }, { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_KEEP_FAILED: 'sometimes' }]) {
    const key = 'inbound/2026-11-09/rejected.bin';
    const store = r2Store({ [key]: storedObject(0) });
    const { state, msg } = queueMessage(key);
    t.mock.method(globalThis, 'fetch', async () => new Response('Rejected', { status: 422 }));
    await worker.queue({ messages: [msg] }, { WEBHOOK_SECRET: 's', NODE_APP_URL: 'https://bridge.example', MAIL_STORE: store, ...settings });
    assert.deepEqual(state, { acked: 0, retried: 1 });
    assert.ok(store.objects[key]);
    t.mock.restoreAll();
  }
});

// ISO-8859-9 (Turkish) 8bit body: bytes 0xFC, 0xFD and 0xFE aren't valid UTF-8 on their own.
const ISO_8859_9_MESSAGE = Buffer.concat([
  Buffer.from('From: a@example.com\r\nSubject: =?iso-8859-9?Q?G=FCnayd=FDn?=\r\nContent-Type: text/plain; charset=iso-8859-9\r\n'
    + 'Content-Transfer-Encoding: 8bit\r\n\r\n', 'latin1'),
  Buffer.from([0x47, 0xfc, 0x6e, 0x61, 0x79, 0x64, 0xfd, 0x6e, 0x20, 0xfe, 0x65, 0x6b, 0x65, 0x72, 0x0d, 0x0a]),
]);

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

async function receive(settings) {
  const store = r2Store();
  const queued = [];
  await worker.email({
    from: 'a@example.com', to: 'b@example.org', rawSize: ISO_8859_9_MESSAGE.length,
    raw: new Response(ISO_8859_9_MESSAGE).body, headers: new Headers(),
  }, {
    MAILBRIDGE_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    MAIL_STORE: store, MAIL_QUEUE: { send: async value => queued.push(value) }, ...settings,
  });
  const [key] = Object.keys(store.objects);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-worker-raw-'));
  const privateKeyPath = path.join(dir, 'private.pem');
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try {
    const encrypted = JSON.parse(store.objects[key].body.toString('utf8'));
    return createInboundMessageDecryptor({ privateKeyPath }).decryptPayload(encrypted);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the modern Worker stores the message bytes exactly, so 8-bit mail in any charset survives', async () => {
  for (const settings of [{ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' }, { MAILBRIDGE_RAW_ENCODING: 'base64' }]) {
    const payload = await receive(settings);
    assert.ok(Buffer.isBuffer(payload.raw));
    assert.equal(Buffer.compare(payload.raw, ISO_8859_9_MESSAGE), 0);
  }
});

test('the legacy Worker keeps sending UTF-8 text for backends that expect it', async () => {
  for (const settings of [{}, { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_RAW_ENCODING: 'text' }]) {
    const payload = await receive(settings);
    assert.equal(typeof payload.raw, 'string');
    assert.match(payload.raw, /�/);   // the documented loss this setting avoids
  }
});

test('base64 encoding matches Node for large inputs, with and without the native method', () => {
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 7);
  const expected = Buffer.from(bytes).toString('base64');
  const plain = new Uint8Array(bytes);
  Object.defineProperty(plain, 'toBase64', { value: undefined });
  assert.equal(bytesToBase64(plain), expected);
  assert.equal(bytesToBase64(new Uint8Array(bytes)), expected);
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
});
