// Copyright (c) 2026 Ra's al Ghul

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { deserializeRaw, serializeRaw } = require('./queue-crypto');
const { all, close, get, run } = require('./sqlite-helpers');
const { isOutboundTarget } = require('./upstream-provider');

function timestamp(now) {
  return now().toISOString();
}

function isMissingFileError(error) {
  return error && error.code === 'ENOENT';
}

async function unlinkIfExists(fsImpl, filePath) {
  try {
    await fsImpl.promises.unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function createQueueStore({
  db,
  dataDir,
  queueCrypto,
  auditStore,
  now = () => new Date(),
  fsImpl = fs,
  log = () => {}
}) {
  const queueDir = path.join(dataDir, 'queue');

  async function tableExists(candidateDb, tableName) {
    const row = await get(candidateDb, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
    return Boolean(row?.name);
  }

  async function init() {
    await fsImpl.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
    await run(db, `CREATE TABLE IF NOT EXISTS queue_items (
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
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_queue_items_created_at ON queue_items(created_at)');
  }

  function buildQueueFilePath(queueId) {
    return path.join(queueDir, `${queueId}.eml`);
  }

  async function writeEncryptedPayload(queueId, perMessageSecret, payload) {
    const encryptedPayload = queueCrypto.encryptQueuePayload({
      queueId,
      perMessageSecret,
      payload
    });
    const filePath = buildQueueFilePath(queueId);
    await fsImpl.promises.writeFile(filePath, encryptedPayload, { mode: 0o600 });
    return filePath;
  }

  async function insertQueueRow({
    queueId,
    fileName,
    perMessageSecret,
    target,
    attempts = 0,
    createdAt,
    lastAttemptAt = null,
    senderHash = null,
    recipientHash = null,
    sourceIpHash = null,
    senderDomain = null,
    requestId = null
  }) {
    await run(db, `INSERT OR REPLACE INTO queue_items (
      id,
      file_name,
      per_message_secret,
      target,
      attempts,
      created_at,
      last_attempt_at,
      sender_hash,
      recipient_hash,
      source_ip_hash,
      sender_domain,
      request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      queueId,
      fileName,
      perMessageSecret,
      target,
      attempts,
      createdAt,
      lastAttemptAt,
      senderHash,
      recipientHash,
      sourceIpHash,
      senderDomain,
      requestId
    ]);
  }

  async function addToQueue(from, to, raw, target = 'local_mail', context = {}) {
    const queueId = context.queueId || crypto.randomUUID();
    const perMessageSecret = queueCrypto.generatePerMessageSecret();
    const createdAt = context.createdAt || timestamp(now);
    const payload = {
      envelopeFrom: from,
      envelopeTo: to,
      raw: serializeRaw(raw),
      target
    };
    const filePath = await writeEncryptedPayload(queueId, perMessageSecret, payload);

    const senderHash = context.senderHash || auditStore.hashEmail(from);
    const recipientHash = context.recipientHash || auditStore.hashRecipient(to);
    const sourceIpHash = context.sourceIpHash || auditStore.hashIp(context.sourceIp);

    try {
      await insertQueueRow({
        queueId,
        fileName: path.basename(filePath),
        perMessageSecret,
        target,
        attempts: context.attempts || 0,
        createdAt,
        lastAttemptAt: context.lastAttemptAt || null,
        senderHash,
        recipientHash,
        sourceIpHash,
        senderDomain: context.senderDomain || null,
        requestId: context.requestId || null
      });
    } catch (error) {
      await unlinkIfExists(fsImpl, filePath);
      throw error;
    }

    await auditStore.logEvent({
      queueId,
      requestId: context.requestId || null,
      eventType: 'queued',
      direction: context.direction || (isOutboundTarget(target) ? 'outbound' : 'inbound'),
      target,
      outcome: context.migratedFromLegacy ? 'migrated' : 'queued',
      senderHash,
      recipientHash,
      sourceIpHash,
      senderDomain: context.senderDomain || null,
      details: context.details || null
    });

    return queueId;
  }

  async function listQueueItems(limit = 50) {
    return all(db, 'SELECT * FROM queue_items ORDER BY created_at ASC LIMIT ?', [limit]);
  }

  async function countQueueItems() {
    const row = await get(db, 'SELECT COUNT(*) AS count FROM queue_items');
    return Number(row?.count || 0);
  }

  async function loadQueuedMessage(row) {
    const encryptedPayload = await fsImpl.promises.readFile(path.join(queueDir, row.file_name));
    const payload = queueCrypto.decryptQueuePayload({
      queueId: row.id,
      perMessageSecret: row.per_message_secret,
      encryptedPayload
    });

    return {
      id: row.id,
      target: row.target,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      createdAt: row.created_at,
      senderHash: row.sender_hash,
      recipientHash: row.recipient_hash,
      sourceIpHash: row.source_ip_hash,
      senderDomain: row.sender_domain,
      requestId: row.request_id,
      sender: payload.envelopeFrom,
      recipient: payload.envelopeTo,
      rawContent: deserializeRaw(payload.raw)
    };
  }

  async function deleteQueueItem(queueId) {
    const row = await get(db, 'SELECT file_name FROM queue_items WHERE id = ?', [queueId]);
    await run(db, 'DELETE FROM queue_items WHERE id = ?', [queueId]);
    if (row?.file_name) {
      await unlinkIfExists(fsImpl, path.join(queueDir, row.file_name));
    }
  }

  async function markAttemptFailed(queueId) {
    await run(db, `UPDATE queue_items
      SET attempts = attempts + 1, last_attempt_at = ?
      WHERE id = ?`, [timestamp(now), queueId]);
  }

  async function migrateQueueItemsFromDatabase(sourceDb, sourceDescription = 'external-db') {
    if (!sourceDb || sourceDb === db) return 0;
    const hasQueueItems = await tableExists(sourceDb, 'queue_items');
    if (!hasQueueItems) return 0;

    const rows = await all(sourceDb, 'SELECT * FROM queue_items ORDER BY created_at ASC');
    for (const row of rows) {
      await insertQueueRow({
        queueId: row.id,
        fileName: row.file_name,
        perMessageSecret: row.per_message_secret,
        target: row.target,
        attempts: Number(row.attempts || 0),
        createdAt: row.created_at || timestamp(now),
        lastAttemptAt: row.last_attempt_at || null,
        senderHash: row.sender_hash || null,
        recipientHash: row.recipient_hash || null,
        sourceIpHash: row.source_ip_hash || null,
        senderDomain: row.sender_domain || null,
        requestId: row.request_id || null
      });
    }

    await run(sourceDb, 'DROP TABLE IF EXISTS queue_items');
    log('[Queue]', 'Migrated queue metadata to secrets database', {
      migratedCount: rows.length,
      source: sourceDescription
    });
    return rows.length;
  }

  async function migrateLegacyQueueRows(legacyDb, sourceDescription) {
    if (!(await tableExists(legacyDb, 'queue'))) return 0;

    const rows = await all(legacyDb, 'SELECT * FROM queue ORDER BY created_at ASC');
    let migratedCount = 0;

    for (const row of rows) {
      const legacyRaw = deserializeRaw({
        encoding: typeof row.raw_content === 'string' && row.raw_content.startsWith('b64:') ? 'base64' : 'utf8',
        value: typeof row.raw_content === 'string' && row.raw_content.startsWith('b64:')
          ? row.raw_content.slice(4)
          : row.raw_content
      });

      await addToQueue(row.sender, row.recipient, legacyRaw, row.target || 'local_mail', {
        queueId: `legacy-${sourceDescription}-${row.id}`,
        attempts: Number(row.attempts || 0),
        createdAt: row.created_at || timestamp(now),
        lastAttemptAt: row.last_attempt || null,
        migratedFromLegacy: true,
        direction: isOutboundTarget(row.target || 'local_mail') ? 'outbound' : 'inbound',
        details: {
          legacyQueueId: row.id,
          source: sourceDescription
        }
      });
      migratedCount += 1;
    }

    await run(legacyDb, 'DROP TABLE IF EXISTS queue');
    return migratedCount;
  }

  async function migrateLegacyQueueFromDatabase(sourceDb, sourceDescription = 'external-db') {
    if (!sourceDb) return 0;
    return migrateLegacyQueueRows(sourceDb, sourceDescription);
  }

  async function migrateLegacyQueue(legacyDbPath) {
    let migratedCount = 0;
    if (!legacyDbPath) return migratedCount;
    const normalizedLegacyPath = path.resolve(legacyDbPath);
    const normalizedDataPath = path.resolve(dataDir, 'mailbridge.db');
    if (normalizedLegacyPath === normalizedDataPath) return migratedCount;

    try {
      await fsImpl.promises.access(normalizedLegacyPath);
    } catch {
      return migratedCount;
    }

    const legacyDb = new sqlite3.Database(normalizedLegacyPath);
    try {
      migratedCount += await migrateLegacyQueueRows(legacyDb, 'legacy-db');
    } finally {
      await close(legacyDb);
    }

    await unlinkIfExists(fsImpl, normalizedLegacyPath);
    log('[Queue]', 'Legacy queue migration completed', {
      migratedCount,
      legacyDbPath: normalizedLegacyPath
    });
    return migratedCount;
  }

  return {
    addToQueue,
    countQueueItems,
    deleteQueueItem,
    init,
    listQueueItems,
    loadQueuedMessage,
    migrateLegacyQueueFromDatabase,
    migrateQueueItemsFromDatabase,
    markAttemptFailed,
    migrateLegacyQueue,
    queueDir
  };
}

module.exports = {
  createQueueStore
};
