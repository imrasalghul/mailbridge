// Copyright (c) 2026 Ra's al Ghul

const sqlite3 = require('sqlite3').verbose();

const { get, run } = require('./sqlite-helpers');

function parseRetentionDays(rawValue) {
  const parsed = Number.parseInt(rawValue || '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIp(value) {
  return String(value || '').trim().replace(/^::ffff:/i, '');
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeErrorMessage(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 300);
}

function sanitizeCode(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().slice(0, 64);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return null;
  return JSON.stringify(value);
}

function createAuditLogStore({
  dbPath,
  queueCrypto,
  env = process.env,
  now = () => new Date(),
  log = () => {}
}) {
  const retentionDays = parseRetentionDays(env.AUDIT_LOG_RETENTION_DAYS);
  const db = new sqlite3.Database(dbPath);
  let lastPruneAtMs = 0;

  async function init() {
    await run(db, 'PRAGMA journal_mode = WAL');
    await run(db, `CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_timestamp TEXT NOT NULL,
      queue_id TEXT,
      request_id TEXT,
      event_type TEXT NOT NULL,
      direction TEXT,
      target TEXT,
      outcome TEXT,
      attempt_number INTEGER,
      sender_hash TEXT,
      recipient_hash TEXT,
      source_ip_hash TEXT,
      sender_domain TEXT,
      status_code TEXT,
      error_code TEXT,
      error_message TEXT,
      details_json TEXT,
      previous_event_hmac TEXT,
      event_hmac TEXT NOT NULL
    )`);
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(event_timestamp)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_audit_events_queue_id ON audit_events(queue_id)');
    await pruneExpiredEvents();
  }

  function hashEmail(value) {
    return queueCrypto.hashAuditValue('email', normalizeEmail(value));
  }

  function hashIp(value) {
    return queueCrypto.hashAuditValue('ip', normalizeIp(value));
  }

  function hashRecipient(value) {
    return queueCrypto.hashAuditValue('recipient', normalizeEmail(value));
  }

  async function pruneExpiredEvents() {
    const cutoff = new Date(now().getTime() - (retentionDays * 24 * 60 * 60 * 1000)).toISOString();
    await run(db, 'DELETE FROM audit_events WHERE event_timestamp < ?', [cutoff]);
    lastPruneAtMs = now().getTime();
  }

  async function maybePruneExpiredEvents() {
    const pruneIntervalMs = 60 * 60 * 1000;
    if ((now().getTime() - lastPruneAtMs) < pruneIntervalMs) return;
    try {
      await pruneExpiredEvents();
    } catch (error) {
      log('[Audit]', 'Retention pruning failed', { error: error.message });
    }
  }

  async function logEvent({
    queueId = null,
    requestId = null,
    eventType,
    direction = null,
    target = null,
    outcome = null,
    attemptNumber = null,
    sender = null,
    recipient = null,
    sourceIp = null,
    senderDomain = null,
    senderHash = null,
    recipientHash = null,
    sourceIpHash = null,
    statusCode = null,
    errorCode = null,
    errorMessage = null,
    details = null
  }) {
    await maybePruneExpiredEvents();

    const eventTimestamp = now().toISOString();
    const previousEvent = await get(db, 'SELECT event_hmac FROM audit_events ORDER BY id DESC LIMIT 1');
    const normalizedSenderHash = senderHash || hashEmail(sender);
    const normalizedRecipientHash = recipientHash || hashRecipient(recipient);
    const normalizedSourceIpHash = sourceIpHash || hashIp(sourceIp);
    const normalizedSenderDomain = normalizeDomain(senderDomain) || null;
    const detailsJson = safeJson(details);
    const previousEventHmac = previousEvent?.event_hmac || null;

    const eventPayload = {
      eventTimestamp,
      queueId,
      requestId,
      eventType,
      direction,
      target,
      outcome,
      attemptNumber,
      senderHash: normalizedSenderHash,
      recipientHash: normalizedRecipientHash,
      sourceIpHash: normalizedSourceIpHash,
      senderDomain: normalizedSenderDomain,
      statusCode: sanitizeCode(statusCode),
      errorCode: sanitizeCode(errorCode),
      errorMessage: sanitizeErrorMessage(errorMessage),
      detailsJson,
      previousEventHmac
    };

    const eventHmac = queueCrypto.signAuditEvent(eventPayload);

    await run(db, `INSERT INTO audit_events (
      event_timestamp,
      queue_id,
      request_id,
      event_type,
      direction,
      target,
      outcome,
      attempt_number,
      sender_hash,
      recipient_hash,
      source_ip_hash,
      sender_domain,
      status_code,
      error_code,
      error_message,
      details_json,
      previous_event_hmac,
      event_hmac
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      eventPayload.eventTimestamp,
      eventPayload.queueId,
      eventPayload.requestId,
      eventPayload.eventType,
      eventPayload.direction,
      eventPayload.target,
      eventPayload.outcome,
      eventPayload.attemptNumber,
      eventPayload.senderHash,
      eventPayload.recipientHash,
      eventPayload.sourceIpHash,
      eventPayload.senderDomain,
      eventPayload.statusCode,
      eventPayload.errorCode,
      eventPayload.errorMessage,
      eventPayload.detailsJson,
      eventPayload.previousEventHmac,
      eventHmac
    ]);
  }

  return {
    db,
    hashEmail,
    hashIp,
    hashRecipient,
    init,
    logEvent,
    pruneExpiredEvents,
    retentionDays
  };
}

module.exports = {
  createAuditLogStore,
  normalizeDomain,
  normalizeEmail,
  normalizeIp,
  sanitizeErrorMessage
};
