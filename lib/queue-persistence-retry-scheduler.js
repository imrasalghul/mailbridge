// Copyright (c) 2026 Ra's al Ghul

function serializeRaw(raw) {
  if (Buffer.isBuffer(raw)) {
    return `b64:${raw.toString('base64')}`;
  }
  return raw || '';
}

function deserializeRaw(raw) {
  if (typeof raw === 'string' && raw.startsWith('b64:')) {
    return Buffer.from(raw.slice(4), 'base64');
  }
  return raw || '';
}

function isPermanentDeliveryError(error) {
  const statusCode = error.responseCode || error.statusCode;
  if (typeof error.permanent === 'boolean') return error.permanent;
  if (!statusCode) return false;
  return (statusCode >= 400 && statusCode < 500 && statusCode !== 429) || statusCode >= 500;
}

function createQueueManager({ dbPath, maxQueueAttempts, deliverQueuedMessage, onLog }) {
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(dbPath);

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT,
      recipient TEXT,
      raw_content TEXT,
      target TEXT DEFAULT 'exchange',
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run("ALTER TABLE queue ADD COLUMN target TEXT DEFAULT 'exchange'", (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        onLog('error', `[DB] Failed to add target column: ${err.message}`);
      }
    });
  });

  function addToQueue(from, to, raw, target = 'exchange') {
    const normalizedRaw = serializeRaw(raw);
    return new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO queue (sender, recipient, raw_content, target) VALUES (?, ?, ?, ?)');
      stmt.run(from, to, normalizedRaw, target, function onRun(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
      stmt.finalize();
    });
  }

  async function processQueue() {
    db.all('SELECT * FROM queue ORDER BY created_at ASC LIMIT 50', async (err, rows) => {
      if (err || !rows || rows.length === 0) return;

      onLog('info', `[Queue] Attempting to process ${rows.length} queued messages...`);

      for (const row of rows) {
        try {
          if (row.attempts >= maxQueueAttempts) {
            onLog('error', `[Queue] Msg ${row.id} reached max attempts (${maxQueueAttempts}). Removing from queue.`);
            db.run('DELETE FROM queue WHERE id = ?', row.id);
            continue;
          }

          await deliverQueuedMessage({ ...row, raw_content: deserializeRaw(row.raw_content) });
          db.run('DELETE FROM queue WHERE id = ?', row.id);
          onLog('info', `[Queue] Successfully delivered queued msg ${row.id} (${row.target}) to ${row.recipient}`);
        } catch (error) {
          const isPermanent = isPermanentDeliveryError(error);

          if (isPermanent) {
            onLog('error', `[Queue] Permanent failure for msg ${row.id}: ${error.message}. Removing from queue.`);
            db.run('DELETE FROM queue WHERE id = ?', row.id);
          } else {
            onLog('error', `[Queue] Temporary failure for msg ${row.id}: ${error.message}. Will retry.`);
            db.run('UPDATE queue SET attempts = attempts + 1, last_attempt = CURRENT_TIMESTAMP WHERE id = ?', row.id);
            break;
          }
        }
      }
    });
  }

  return {
    db,
    addToQueue,
    processQueue,
    start(intervalMs = 5 * 60 * 1000) {
      return setInterval(processQueue, intervalMs);
    },
    serializeRaw,
    deserializeRaw,
    isPermanentDeliveryError
  };
}

module.exports = {
  createQueueManager,
  serializeRaw,
  deserializeRaw,
  isPermanentDeliveryError
};
