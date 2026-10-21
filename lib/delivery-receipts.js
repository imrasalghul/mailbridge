const { randomUUID } = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { get, run } = require('./sqlite-helpers');

function isTerminalResult(statusCode) {
  return (statusCode >= 200 && statusCode < 300) || [400, 406, 413, 422].includes(statusCode);
}

function createDeliveryReceiptStore({ dbPath, now = Date.now, leaseMs = 5 * 60 * 1000 }) {
  const db = new sqlite3.Database(dbPath);
  const inFlight = new Map();

  async function init() {
    await run(db, 'PRAGMA busy_timeout = 5000');
    await run(db, 'PRAGMA journal_mode = WAL');
    await run(db, `CREATE TABLE IF NOT EXISTS delivery_receipts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      lease_owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
      status_code INTEGER, response_body TEXT
    )`);
  }

  async function processDelivery({ deliveryId, fingerprint }, deliver) {
    const owner = randomUUID();
    const claimed = await run(db, `INSERT INTO delivery_receipts (id, fingerprint, lease_owner, lease_until)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lease_owner = excluded.lease_owner, lease_until = excluded.lease_until
      WHERE delivery_receipts.fingerprint = excluded.fingerprint AND delivery_receipts.status_code IS NULL AND delivery_receipts.lease_until <= ?`,
    [deliveryId, fingerprint, owner, now() + leaseMs, now()]);
    if (!claimed.changes) {
      const receipt = await get(db, 'SELECT * FROM delivery_receipts WHERE id = ?', [deliveryId]);
      if (receipt?.fingerprint !== fingerprint) return { statusCode: 409, body: 'Delivery identity does not match payload' };
      if (receipt.status_code !== null) return { statusCode: receipt.status_code, body: receipt.response_body };
      return { statusCode: 503, body: 'Delivery is already in progress' };
    }

    const heartbeat = setInterval(() => {
      run(db, 'UPDATE delivery_receipts SET lease_until = ? WHERE id = ? AND lease_owner = ? AND status_code IS NULL',
        [now() + leaseMs, deliveryId, owner]).catch(error => console.error(`[Delivery] Receipt lease renewal failed: ${error.code || 'unavailable'}`));
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    let completedDelivery = false;
    try {
      const result = await deliver();
      if (isTerminalResult(result.statusCode)) {
        completedDelivery = true;
        const saved = await run(db, 'UPDATE delivery_receipts SET status_code = ?, response_body = ? WHERE id = ? AND lease_owner = ?',
          [result.statusCode, result.body, deliveryId, owner]);
        if (!saved.changes) throw new Error('Delivery receipt lease was lost');
      } else {
        await run(db, 'DELETE FROM delivery_receipts WHERE id = ? AND lease_owner = ?', [deliveryId, owner]);
      }
      return result;
    } catch (error) {
      // An uncertain post-SMTP outcome retains its lease instead of immediately redelivering.
      if (!completedDelivery) await run(db, 'DELETE FROM delivery_receipts WHERE id = ? AND lease_owner = ?', [deliveryId, owner]).catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  function processOnce(identity, deliver) {
    const existing = inFlight.get(identity.deliveryId);
    if (existing) {
      if (existing.fingerprint !== identity.fingerprint) return Promise.resolve({ statusCode: 409, body: 'Delivery identity does not match payload' });
      return existing.promise;
    }
    const promise = processDelivery(identity, deliver).finally(() => inFlight.delete(identity.deliveryId));
    inFlight.set(identity.deliveryId, { fingerprint: identity.fingerprint, promise });
    return promise;
  }

  return { db, init, processOnce };
}

module.exports = { createDeliveryReceiptStore, isTerminalResult };
