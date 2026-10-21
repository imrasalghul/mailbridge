const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDeliveryReceiptStore } = require('../lib/delivery-receipts');
const { close } = require('../lib/sqlite-helpers');

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-receipts-'));
  const stores = [];
  t.after(async () => { for (const store of stores) await close(store.db); fs.rmSync(root, { recursive: true, force: true }); });
  const open = async () => { const store = createDeliveryReceiptStore({ dbPath: path.join(root, 'receipts.db') }); stores.push(store); await store.init(); return store; };
  return { open, store: await open() };
}

test('successful delivery receipts suppress repeated and concurrent deliveries', async t => {
  const { store, open } = await harness(t);
  let calls = 0;
  const deliver = async () => { calls++; return { statusCode: 200, body: 'OK' }; };
  const key = { deliveryId: 'inbound/test', fingerprint: 'same-payload' };
  const results = await Promise.all([store.processOnce(key, deliver), store.processOnce(key, deliver)]);
  assert.deepEqual(results.map(result => result.statusCode), [200, 200]);
  const reopened = await open();
  assert.equal((await reopened.processOnce(key, deliver)).statusCode, 200);
  assert.equal(calls, 1);
});

test('receipt identities cannot be reused for different payloads', async t => {
  const { store } = await harness(t);
  await store.processOnce({ deliveryId: 'inbound/test', fingerprint: 'first' }, async () => ({ statusCode: 202, body: 'Queued' }));
  const result = await store.processOnce({ deliveryId: 'inbound/test', fingerprint: 'different' }, async () => assert.fail('Duplicate ID must not process another message'));
  assert.equal(result.statusCode, 409);
});

test('temporary processing errors are retried while permanent mail rejections are remembered', async t => {
  const { store } = await harness(t);
  const key = { deliveryId: 'inbound/test', fingerprint: 'same' };
  let calls = 0;
  const deliver = async () => ({ statusCode: ++calls === 1 ? 503 : 422, body: 'synthetic' });
  assert.equal((await store.processOnce(key, deliver)).statusCode, 503);
  assert.equal((await store.processOnce(key, deliver)).statusCode, 422);
  assert.equal((await store.processOnce(key, deliver)).statusCode, 422);
  assert.equal(calls, 2);
});

test('separate receipt connections cannot deliver the same message simultaneously', async t => {
  const { store, open } = await harness(t);
  const other = await open();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const key = { deliveryId: 'inbound/test', fingerprint: 'same' };
  const first = store.processOnce(key, async () => { started(); await gate; return { statusCode: 200, body: 'OK' }; });
  await ready;
  try {
    assert.equal((await other.processOnce(key, () => assert.fail('Lease must prevent another delivery'))).statusCode, 503);
  } finally { release(); await first; }
});
