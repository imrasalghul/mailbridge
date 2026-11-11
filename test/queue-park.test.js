const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sqlite3 = require('sqlite3').verbose();

const { createAuditLogStore } = require('../lib/audit-log-store');
const { getCompatibility } = require('../lib/compatibility');
const { createQueueCrypto } = require('../lib/queue-crypto');
const { createQueueManager } = require('../lib/queue-manager');
const { createQueueStore } = require('../lib/queue-store');
const { all, close, run } = require('../lib/sqlite-helpers');
const queueCli = require('../scripts/queue');

async function harness(t, { keepFailed = true, maxQueueAttempts = 2, deliver } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-park-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let current = new Date('2026-11-09T00:00:00.000Z');
  const now = () => current;
  const queueCrypto = createQueueCrypto({ masterKey: crypto.randomBytes(32).toString('base64') });
  const auditStore = createAuditLogStore({ dbPath: path.join(dataDir, 'mailbridge.db'), queueCrypto, env: {}, now });
  await auditStore.init();
  const secretsDbPath = path.join(root, 'secrets.db');
  const db = new sqlite3.Database(secretsDbPath);
  const store = createQueueStore({ db, dataDir, queueCrypto, auditStore, now });
  await store.init();
  const attempts = [];
  const manager = createQueueManager({
    store, auditStore, maxQueueAttempts, keepFailed, parkedRetryIntervalMs: 60 * 60 * 1000, now,
    deliverQueuedMessage: async row => { attempts.push(row.id); return deliver ? deliver(row) : undefined; }
  });
  t.after(async () => {
    await close(db);
    await close(auditStore.db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store, manager, attempts, db, dataDir, secretsDbPath, auditStore,
    advance(ms) { current = new Date(current.getTime() + ms); },
    async rows() { return all(db, 'SELECT id, attempts, parked_at, park_reason FROM queue_items ORDER BY created_at'); },
    async events(type) { return all(auditStore.db, 'SELECT event_type, outcome FROM audit_events WHERE event_type = ?', [type]); }
  };
}

const temporary = () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); };
const permanent = () => { throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }); };
const HOUR = 60 * 60 * 1000;

test('MAILBRIDGE_KEEP_FAILED defaults on with the modern profile and off with legacy', () => {
  assert.equal(getCompatibility({}).keepFailed, false);
  assert.equal(getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' }).keepFailed, true);
  assert.equal(getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_KEEP_FAILED: 'false' }).keepFailed, false);
  assert.throws(() => getCompatibility({ MAILBRIDGE_KEEP_FAILED: 'maybe' }), /MAILBRIDGE_KEEP_FAILED/);
});

test('mail that reaches the attempt limit is parked, retried hourly, and delivered when the server is back', async t => {
  let down = true;
  const h = await harness(t, { deliver: () => { if (down) temporary(); } });
  const id = await h.store.addToQueue('a@example.com', 'b@example.org', Buffer.from('Subject: x\r\n\r\nbody'));

  await h.manager.processQueue();
  await h.manager.processQueue();                    // 2 failed attempts
  await h.manager.processQueue();                    // limit reached: parked, not attempted
  assert.deepEqual((await h.rows()).map(r => [r.attempts, r.park_reason]), [[2, 'max_attempts']]);
  assert.equal(h.attempts.length, 2);
  assert.deepEqual(await h.events('parked'), [{ event_type: 'parked', outcome: 'max_attempts' }]);
  assert.deepEqual(await h.events('dropped'), []);

  await h.manager.processQueue();                    // not due yet
  assert.equal(h.attempts.length, 2);
  h.advance(HOUR);
  await h.manager.processQueue();                    // due: attempted, fails, stays parked
  assert.equal(h.attempts.length, 3);
  assert.equal((await h.rows())[0].park_reason, 'max_attempts');

  down = false;
  h.advance(HOUR);
  await h.manager.processQueue();
  assert.deepEqual(h.attempts, [id, id, id, id]);
  assert.deepEqual(await h.rows(), []);
});

test('permanent failures are parked for the operator and never retried automatically', async t => {
  const h = await harness(t, { deliver: permanent });
  await h.store.addToQueue('a@example.com', 'b@example.org', 'Subject: x\r\n\r\nbody');
  await h.manager.processQueue();
  assert.deepEqual((await h.rows()).map(r => r.park_reason), ['permanent_failure']);
  for (let i = 0; i < 3; i++) {
    h.advance(24 * HOUR);
    await h.manager.processQueue();
  }
  assert.equal(h.attempts.length, 1);
  assert.equal((await h.rows()).length, 1);
});

test('parked mail does not hold up newer mail', async t => {
  const h = await harness(t, { deliver: row => { if (row.recipient === 'stuck@example.org') temporary(); } });
  const stuck = await h.store.addToQueue('a@example.com', 'stuck@example.org', 'Subject: x\r\n\r\nbody');
  await h.manager.processQueue();
  await h.manager.processQueue();
  await h.manager.processQueue();                    // parked
  h.advance(1000);
  const fresh = await h.store.addToQueue('a@example.com', 'fresh@example.org', 'Subject: y\r\n\r\nbody');
  h.advance(HOUR);
  await h.manager.processQueue();                    // fresh first, then the due parked item
  assert.deepEqual(h.attempts.slice(-2), [fresh, stuck]);
  assert.deepEqual((await h.rows()).map(r => r.id), [stuck]);
});

test('without MAILBRIDGE_KEEP_FAILED the earlier behavior is unchanged: dropped at the limit', async t => {
  const h = await harness(t, { keepFailed: false, deliver: temporary });
  await h.store.addToQueue('a@example.com', 'b@example.org', 'Subject: x\r\n\r\nbody');
  for (let i = 0; i < 3; i++) await h.manager.processQueue();
  assert.deepEqual(await h.rows(), []);
  assert.deepEqual(await h.events('dropped'), [{ event_type: 'dropped', outcome: 'max_attempts_exceeded' }]);
});

test('an existing queue database gains the parking columns and keeps its rows', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-park-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new sqlite3.Database(path.join(root, 'secrets.db'));
  t.after(() => close(db));
  await run(db, `CREATE TABLE queue_items (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, per_message_secret TEXT NOT NULL,
    target TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_attempt_at TEXT,
    sender_hash TEXT, recipient_hash TEXT, source_ip_hash TEXT, sender_domain TEXT, request_id TEXT)`);
  await run(db, `INSERT INTO queue_items (id, file_name, per_message_secret, target, attempts, created_at)
    VALUES ('old', 'old.eml', 'secret', 'local_mail', 3, '2026-11-01T00:00:00.000Z')`);
  const store = createQueueStore({ db, dataDir: path.join(root, 'data'), queueCrypto: null, auditStore: null });
  await store.init();
  await store.init();                                // idempotent
  const columns = (await all(db, 'PRAGMA table_info(queue_items)')).map(c => c.name);
  assert.ok(columns.includes('parked_at') && columns.includes('park_reason'));
  assert.deepEqual((await store.listQueueItems(50)).map(r => r.id), ['old']);
});

test('npm run queue lists, retries and deletes queue items', async t => {
  const h = await harness(t, { deliver: permanent });
  const parked = await h.store.addToQueue('a@example.com', 'b@example.org', 'Subject: x\r\n\r\nbody');
  await h.manager.processQueue();
  const env = { DATA_DIR: h.dataDir, SECRETS_DB_PATH: h.secretsDbPath };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-park-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cli = async argv => {
    let text = '';
    await queueCli.run(argv, { cwd, env, output: { write: chunk => { text += chunk; } } });
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };

  const [listed] = await cli(['list']);
  assert.equal(listed.id, parked);
  assert.equal(listed.status, 'parked (waiting for you)');
  assert.equal(JSON.stringify(listed).includes('b@example.org'), false);   // metadata only

  assert.deepEqual(await cli(['retry', parked]), [{ id: parked, status: 'queued', note: 'retried on the next queue run (every 5 minutes)' }]);
  assert.deepEqual((await h.rows()).map(r => [r.attempts, r.park_reason]), [[0, null]]);
  await assert.rejects(cli(['retry', parked]), /No parked queue item/);

  await assert.rejects(cli(['delete', parked]), /Usage/);                  // needs --yes
  assert.deepEqual(await cli(['delete', parked, '--yes']), [{ id: parked, status: 'deleted' }]);
  assert.deepEqual(await h.rows(), []);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'queue')), []);
  await assert.rejects(cli(['delete', 'missing', '--yes']), /No queue item/);
  for (const argv of [[], ['list', 'x'], ['retry'], ['retry', 'x', '--all'], ['remove', 'x']]) {
    assert.throws(() => queueCli.parseArgs(argv), /Usage/);
  }
});
