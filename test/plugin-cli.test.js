const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('plugin CLI lists, disables, and enables an existing legacy plugin without exposing configuration', async t => {
  const { run } = require('../scripts/plugins');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, 'plugins');
  const installed = path.join(pluginDirectory, 'fixture');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'fixture', version: '1.0.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: ['token'] }));
  fs.writeFileSync(path.join(installed, 'index.js'), "const r=require('node:readline').createInterface({input:process.stdin});r.once('line',l=>{const q=JSON.parse(l);process.stdout.write(JSON.stringify({requestId:q.requestId,ok:true,result:{token:'synthetic-secret'}})+'\\n');r.close()})");
  const env = { MAILBRIDGE_PLUGIN_DIR: pluginDirectory, MAILBRIDGE_PLUGIN_LOCKFILE: path.join(root, 'plugins.lock.json'), MAILBRIDGE_PLUGIN_FIXTURE_token: 'synthetic-secret' };
  let output = '';
  const options = { cwd: root, env, output: { write(text) { output += text; } } };
  await run(['list'], options);
  assert.match(output, /fixture/);
  await run(['disable', 'fixture'], options);
  assert.equal(JSON.parse(fs.readFileSync(env.MAILBRIDGE_PLUGIN_LOCKFILE)).plugins.fixture.enabled, false);
  await run(['enable', 'fixture'], options);
  await run(['test', 'fixture'], options);
  assert.match(output, /health check passed/i);
  assert.doesNotMatch(output, /synthetic-secret/);
  fs.writeFileSync(path.join(installed, 'index.js'), "process.stderr.write('synthetic-secret');process.exit(1)");
  await assert.rejects(run(['test', 'fixture'], options), error => !error.message.includes('synthetic-secret') && /health check failed/i.test(error.message));
  await assert.rejects(run(['test', 'fixture', 'extra'], options), /usage/i);
});

test('plugin CLI resolves default container data paths to the host workspace', async t => {
  const { run } = require('../scripts/plugins');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-cli-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, 'data', 'plugins', 'fixture');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'fixture', version: '1.0.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
  const rows = await run(['list'], { cwd: root, env: { DATA_DIR: '/app/data', MAILBRIDGE_PLUGIN_DIR: '/app/data/plugins', MAILBRIDGE_PLUGIN_LOCKFILE: '/app/data/plugins.lock.json' }, output: { write() {} } });
  assert.equal(rows[0].id, 'fixture');
});

test('plugin CLI rejects unsupported operations before mutating files', async () => {
  const { run } = require('../scripts/plugins');
  await assert.rejects(run(['deliver', 'scanner'], { env: {}, output: { write() {} } }), /usage/i);
});
