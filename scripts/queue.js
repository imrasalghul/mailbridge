#!/usr/bin/env node
// Copyright (c) 2026 Ra's al Ghul

// Operator view of the local delivery queue: list items, put parked items back in the queue,
// or delete one. Parked items (MAILBRIDGE_KEEP_FAILED) are never deleted automatically.
// Message contents stay encrypted: this reads only queue metadata.

const path = require('node:path');
const { parse } = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const { readOptionalFile } = require('../lib/atomic-files');
const { getCompatibility } = require('../lib/compatibility');
const { createQueueStore } = require('../lib/queue-store');
const { close, run: runSql } = require('../lib/sqlite-helpers');

const USAGE = 'Usage: npm run queue -- [--system] list | retry ID|--all | delete ID --yes';
const APP_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')));
  const [command, target] = argv.filter(arg => !arg.startsWith('--'));
  const valid = (command === 'list' && !target)
    || (command === 'retry' && (Boolean(target) !== flags.has('--all')))
    || (command === 'delete' && target && flags.has('--yes'));
  if (!valid) throw new Error(USAGE);
  return { command, target, all: flags.has('--all'), system: flags.has('--system') };
}

function resolvePaths({ system, cwd, env }) {
  const envPath = system ? '/etc/mailbridge/mailbridge.env' : path.join(cwd, '.env');
  // Read through operator-owned links only in the compatibility profile, as scripts/plugins.js does.
  const contents = readOptionalFile(envPath, 'utf8', { allowSymlinks: !getCompatibility(env).strictFileReads });
  const activeEnv = { ...(contents === undefined ? {} : parse(contents)), ...env };
  if (getCompatibility(activeEnv).strictFileReads && contents !== undefined) readOptionalFile(envPath);
  return {
    dataDir: path.resolve(activeEnv.DATA_DIR || path.join(APP_DIR, 'data')),
    secretsDbPath: path.resolve(activeEnv.SECRETS_DB_PATH || path.join(APP_DIR, 'secrets', 'secrets.db'))
  };
}

function status(row) {
  if (!row.parked_at) return 'queued';
  return row.park_reason === 'max_attempts' ? 'parked (retried automatically)' : 'parked (waiting for you)';
}

async function run(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, output = process.stdout } = {}) {
  const args = parseArgs(argv);
  const { dataDir, secretsDbPath } = resolvePaths({ system: args.system, cwd, env });
  const db = new sqlite3.Database(secretsDbPath);
  const print = value => output.write(`${JSON.stringify(value)}\n`);
  try {
    await runSql(db, 'PRAGMA busy_timeout = 5000');   // the running server may hold the database
    // Metadata only: no queue key is needed, and nothing is decrypted.
    const store = createQueueStore({ db, dataDir, queueCrypto: null, auditStore: null });
    await store.init();

    if (args.command === 'list') {
      for (const row of await store.listAllQueueItems()) {
        print({
          id: row.id, status: status(row), target: row.target, attempts: row.attempts,
          createdAt: row.created_at, lastAttemptAt: row.last_attempt_at, parkedAt: row.parked_at,
          parkReason: row.park_reason, senderDomain: row.sender_domain
        });
      }
      return;
    }

    if (args.command === 'retry') {
      const ids = args.all
        ? (await store.listAllQueueItems()).filter(row => row.parked_at).map(row => row.id)
        : [args.target];
      for (const id of ids) {
        if (!(await store.unparkQueueItem(id))) throw new Error(`No parked queue item ${id}`);
        print({ id, status: 'queued', note: 'retried on the next queue run (every 5 minutes)' });
      }
      return;
    }

    const known = (await store.listAllQueueItems()).some(row => row.id === args.target);
    if (!known) throw new Error(`No queue item ${args.target}`);
    await store.deleteQueueItem(args.target);
    print({ id: args.target, status: 'deleted' });
  } finally {
    await close(db);
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { run, parseArgs, USAGE };
