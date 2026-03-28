const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sqlite3 = require('sqlite3').verbose();

const { createAuditLogStore } = require('../lib/audit-log-store');
const { createQueueCrypto } = require('../lib/queue-crypto');
const { createQueueManager, isPermanentDeliveryError } = require('../lib/queue-manager');
const { createQueueStore } = require('../lib/queue-store');
const { all, close, get, run } = require('../lib/sqlite-helpers');

function randomMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}

async function createHarness(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-queue-'));
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const dataDir = path.join(rootDir, 'data');
  const secretsDir = path.join(rootDir, 'secrets');
  fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });

  let currentTime = new Date(options.now || '2026-03-28T00:00:00.000Z');
  const queueCrypto = createQueueCrypto({
    masterKey: options.masterKey || randomMasterKey()
  });
  const auditStore = createAuditLogStore({
    dbPath: path.join(dataDir, 'mailbridge.db'),
    queueCrypto,
    env: {
      AUDIT_LOG_RETENTION_DAYS: options.retentionDays || '1'
    },
    now: () => currentTime
  });
  await auditStore.init();
  const secretsDbPath = path.join(secretsDir, 'secrets.db');
  const secretsDb = new sqlite3.Database(secretsDbPath);

  const queueStore = createQueueStore({
    db: secretsDb,
    dataDir,
    queueCrypto,
    auditStore,
    now: () => currentTime
  });
  await queueStore.init();

  let closed = false;
  async function cleanup() {
    if (closed) return;
    closed = true;
    await close(secretsDb);
    await close(auditStore.db);
  }

  t.after(async () => {
    await cleanup();
  });

  return {
    auditStore,
    close: cleanup,
    dataDir,
    dbPath: path.join(dataDir, 'mailbridge.db'),
    queueCrypto,
    queueStore,
    rootDir,
    secretsDb,
    secretsDbPath,
    setNow(value) {
      currentTime = new Date(value);
    }
  };
}

test('explicit permanent=false keeps 5xx sendgrid-style errors retryable', () => {
  assert.equal(
    isPermanentDeliveryError({ statusCode: 503, permanent: false }),
    false
  );
});

test('explicit permanent=true still wins regardless of status code', () => {
  assert.equal(
    isPermanentDeliveryError({ statusCode: 429, permanent: true }),
    true
  );
});

test('429 remains temporary when no explicit permanent flag is provided', () => {
  assert.equal(isPermanentDeliveryError({ statusCode: 429 }), false);
});

test('smtp 5xx remains permanent when no explicit permanent flag is provided', () => {
  assert.equal(isPermanentDeliveryError({ responseCode: 550 }), true);
});

test('queued messages are encrypted at rest and db does not store raw content', async (t) => {
  const harness = await createHarness(t);
  const rawEmail = 'Subject: Hello\r\n\r\nThis is sensitive mail';

  const queueId = await harness.queueStore.addToQueue(
    'alice@example.com',
    'bob@example.com',
    rawEmail,
    'local_mail',
    {
      direction: 'inbound',
      requestId: 'req-1',
      sourceIp: '203.0.113.10',
      senderDomain: 'example.com'
    }
  );

  const queueFile = path.join(harness.dataDir, 'queue', `${queueId}.eml`);
  const encryptedBytes = fs.readFileSync(queueFile);
  assert.equal(encryptedBytes.toString('utf8').includes('This is sensitive mail'), false);
  assert.equal(encryptedBytes.toString('utf8').includes('alice@example.com'), false);

  const queueItem = await get(harness.secretsDb, 'SELECT * FROM queue_items WHERE id = ?', [queueId]);
  assert.equal(typeof queueItem.per_message_secret, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(queueItem, 'raw_content'), false);

  const auditEvent = await get(harness.auditStore.db, 'SELECT * FROM audit_events WHERE queue_id = ?', [queueId]);
  assert.ok(auditEvent.sender_hash);
  assert.notEqual(auditEvent.sender_hash, 'alice@example.com');

  const columns = await all(harness.secretsDb, 'PRAGMA table_info(queue_items)');
  assert.equal(columns.some((column) => column.name === 'raw_content'), false);
  const auditQueueTable = await get(
    harness.auditStore.db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_items'"
  );
  assert.equal(auditQueueTable, null);
});

test('queued messages require both the db secret and QUEUE_MASTER_KEY to decrypt', async (t) => {
  const masterKey = randomMasterKey();
  const harness = await createHarness(t, { masterKey });

  const queueId = await harness.queueStore.addToQueue(
    'alice@example.com',
    'bob@example.com',
    'Subject: Hi\r\n\r\nEncrypted',
    'local_mail'
  );

  const row = await get(harness.secretsDb, 'SELECT * FROM queue_items WHERE id = ?', [queueId]);
  await harness.close();

  const wrongQueueCrypto = createQueueCrypto({ masterKey: randomMasterKey() });
  const wrongAuditStore = createAuditLogStore({
    dbPath: harness.dbPath,
    queueCrypto: wrongQueueCrypto,
    env: { AUDIT_LOG_RETENTION_DAYS: '1' }
  });
  await wrongAuditStore.init();
  const wrongSecretsDb = new sqlite3.Database(harness.secretsDbPath);
  const wrongQueueStore = createQueueStore({
    db: wrongSecretsDb,
    dataDir: harness.dataDir,
    queueCrypto: wrongQueueCrypto,
    auditStore: wrongAuditStore
  });
  await wrongQueueStore.init();

  await assert.rejects(
    wrongQueueStore.loadQueuedMessage(row),
    /unable to authenticate data|Unsupported state or unable to authenticate data/
  );

  await close(wrongSecretsDb);
  await close(wrongAuditStore.db);
});

test('queue manager retries temporary failures and removes delivered messages', async (t) => {
  const harness = await createHarness(t);
  const rawEmail = 'Subject: Retry\r\n\r\nHello';
  await harness.queueStore.addToQueue('alice@example.com', 'bob@example.com', rawEmail, 'local_mail');

  let attempts = 0;
  const queueManager = createQueueManager({
    store: harness.queueStore,
    auditStore: harness.auditStore,
    maxQueueAttempts: 3,
    async deliverQueuedMessage(message) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary network issue');
        error.statusCode = 429;
        throw error;
      }
      assert.equal(message.sender, 'alice@example.com');
      assert.equal(message.recipient, 'bob@example.com');
      assert.equal(message.raw_content, rawEmail);
    }
  });

  await queueManager.processQueue();
  let queueRows = await harness.queueStore.listQueueItems();
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].attempts, 1);

  await queueManager.processQueue();
  queueRows = await harness.queueStore.listQueueItems();
  assert.equal(queueRows.length, 0);

  const auditRows = await all(harness.auditStore.db, 'SELECT event_type, outcome FROM audit_events ORDER BY id');
  assert.deepEqual(
    auditRows.map((row) => `${row.event_type}:${row.outcome}`),
    [
      'queued:queued',
      'retry:attempt_started',
      'retry:temporary_failure',
      'retry:attempt_started',
      'delivered:delivered'
    ]
  );
});

test('queue manager drops permanently failed messages', async (t) => {
  const harness = await createHarness(t);
  await harness.queueStore.addToQueue('alice@example.com', 'bob@example.com', 'Subject: Fail\r\n\r\nNope', 'sendgrid');

  const queueManager = createQueueManager({
    store: harness.queueStore,
    auditStore: harness.auditStore,
    maxQueueAttempts: 3,
    async deliverQueuedMessage() {
      const error = new Error('mailbox unavailable');
      error.responseCode = 550;
      throw error;
    }
  });

  await queueManager.processQueue();

  const queueRows = await harness.queueStore.listQueueItems();
  assert.equal(queueRows.length, 0);

  const auditRow = await get(
    harness.auditStore.db,
    "SELECT event_type, outcome FROM audit_events WHERE event_type = 'delivery_failed' ORDER BY id DESC LIMIT 1"
  );
  assert.deepEqual(auditRow, {
    event_type: 'delivery_failed',
    outcome: 'permanent_failure'
  });
});

test('legacy sqlite queue rows are migrated into encrypted queue files', async (t) => {
  const harness = await createHarness(t);
  const legacyDbPath = path.join(harness.rootDir, 'mail_queue.sqlite');
  const legacyDb = new sqlite3.Database(legacyDbPath);

  await run(legacyDb, `CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    recipient TEXT,
    raw_content TEXT,
    target TEXT DEFAULT 'local_mail',
    attempts INTEGER DEFAULT 0,
    last_attempt DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(
    legacyDb,
    'INSERT INTO queue (sender, recipient, raw_content, target, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['legacy@example.com', 'dest@example.com', 'Subject: Legacy\r\n\r\nQueued', 'local_mail', 2, '2026-03-27T00:00:00.000Z']
  );
  await close(legacyDb);

  const migratedCount = await harness.queueStore.migrateLegacyQueue(legacyDbPath);
  assert.equal(migratedCount, 1);
  assert.equal(fs.existsSync(legacyDbPath), false);

  const queueRows = await harness.queueStore.listQueueItems();
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].attempts, 2);

  const queuedMessage = await harness.queueStore.loadQueuedMessage(queueRows[0]);
  assert.equal(queuedMessage.sender, 'legacy@example.com');
  assert.equal(queuedMessage.recipient, 'dest@example.com');
  assert.equal(queuedMessage.rawContent, 'Subject: Legacy\r\n\r\nQueued');
});

test('current queue_items are migrated out of mailbridge.db into secrets.db', async (t) => {
  const harness = await createHarness(t);
  const queueFile = path.join(harness.dataDir, 'queue', 'migrated.eml');
  fs.writeFileSync(queueFile, Buffer.from('ciphertext'));
  await run(harness.auditStore.db, `CREATE TABLE queue_items (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    per_message_secret TEXT NOT NULL,
    target TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT,
    sender_hash TEXT,
    recipient_hash TEXT,
    source_ip_hash TEXT,
    sender_domain TEXT,
    request_id TEXT
  )`);
  await run(
    harness.auditStore.db,
    `INSERT INTO queue_items (
      id, file_name, per_message_secret, target, attempts, created_at, sender_hash, recipient_hash, source_ip_hash, sender_domain, request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['migrated-1', 'migrated.eml', 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2U=', 'local_mail', 1, '2026-03-27T00:00:00.000Z', 'sender-h', 'recipient-h', 'ip-h', 'example.com', 'req-1']
  );

  const migratedCount = await harness.queueStore.migrateQueueItemsFromDatabase(harness.auditStore.db, 'audit-db');
  assert.equal(migratedCount, 1);

  const migratedRow = await get(harness.secretsDb, 'SELECT * FROM queue_items WHERE id = ?', ['migrated-1']);
  assert.equal(migratedRow.file_name, 'migrated.eml');

  const oldTable = await get(
    harness.auditStore.db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_items'"
  );
  assert.equal(oldTable, null);
});

test('audit log pruning honors AUDIT_LOG_RETENTION_DAYS and event chain is linked', async (t) => {
  const harness = await createHarness(t, { now: '2026-03-25T00:00:00.000Z', retentionDays: '1' });

  await harness.auditStore.logEvent({
    requestId: 'req-old',
    eventType: 'delivered',
    direction: 'inbound',
    target: 'local_mail',
    outcome: 'delivered',
    sender: 'first@example.com',
    recipient: 'one@example.com',
    sourceIp: '198.51.100.7'
  });

  harness.setNow('2026-03-25T00:10:00.000Z');
  await harness.auditStore.logEvent({
    requestId: 'req-new',
    eventType: 'ai_result',
    direction: 'inbound',
    target: 'local_mail',
    outcome: 'not_spam',
    sender: 'second@example.com',
    recipient: 'two@example.com',
    sourceIp: '198.51.100.8'
  });

  let rows = await all(harness.auditStore.db, 'SELECT previous_event_hmac, event_hmac, sender_hash FROM audit_events ORDER BY id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].previous_event_hmac, null);
  assert.equal(rows[1].previous_event_hmac, rows[0].event_hmac);
  assert.ok(rows[0].sender_hash);

  harness.setNow('2026-03-27T00:10:00.000Z');
  await harness.auditStore.pruneExpiredEvents();
  rows = await all(harness.auditStore.db, 'SELECT id FROM audit_events ORDER BY id');
  assert.equal(rows.length, 0);
});
