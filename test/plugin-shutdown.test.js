const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerPluginShutdown } = require('../lib/plugin-shutdown');

test('shutdown waits for plugin cleanup and repeated signals do not interrupt it', async () => {
  const runtime = new EventEmitter();
  const exits = [];
  runtime.exit = code => exits.push(code);
  let finish;
  let calls = 0;
  registerPluginShutdown({ close() { calls++; return new Promise(resolve => { finish = resolve; }); } }, { runtime });
  runtime.emit('SIGTERM');
  runtime.emit('SIGINT');
  assert.equal(calls, 1);
  assert.deepEqual(exits, []);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
});

test('shutdown reports cleanup failure without exposing plugin error contents', async () => {
  const runtime = new EventEmitter();
  const exits = [];
  const logs = [];
  runtime.exit = code => exits.push(code);
  registerPluginShutdown({ async close() { throw new Error('private-plugin-content'); } }, { runtime, log: message => logs.push(message) });
  runtime.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(logs, ['[Plugin] Shutdown cleanup failed']);
});
