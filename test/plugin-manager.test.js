const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  assertExactPackageSpecifier,
  createPluginManager,
  normalizeManifest,
  runPluginProcess
} = require('../lib/plugin-manager');

test('plugin package specifiers require exact semantic versions', () => {
  assert.equal(assertExactPackageSpecifier('mailbridge-plugin-spamhaus@1.2.3'), 'mailbridge-plugin-spamhaus@1.2.3');
  assert.equal(assertExactPackageSpecifier('@scope/plugin@0.0.1-beta.1'), '@scope/plugin@0.0.1-beta.1');
  for (const value of ['mailbridge-plugin-spamhaus', 'mailbridge-plugin-spamhaus@latest', 'mailbridge-plugin-spamhaus@^1.2.3', 'mailbridge-plugin-spamhaus@1.2']) {
    assert.throws(() => assertExactPackageSpecifier(value), /exact name@x\.y\.z/);
  }
});

test('plugin manifests validate the host contract', () => {
  const manifest = normalizeManifest({
    apiVersion: 1,
    id: 'codex',
    version: '1.0.0',
    type: 'scanner',
    failurePolicy: 'fail-open',
    entrypoint: 'src/index.js',
    config: ['model'],
    secrets: ['apiKey'],
    capabilities: ['headers']
  });
  assert.equal(manifest.id, 'codex');
  assert.throws(() => normalizeManifest({ ...manifest, apiVersion: 2 }), /unsupported plugin API/);
  assert.throws(() => normalizeManifest({ ...manifest, type: 'unknown' }), /invalid plugin type/);
  assert.throws(() => normalizeManifest({ ...manifest, entrypoint: '../escape.js' }), /inside the plugin directory/);
  const schemaManifest = normalizeManifest({ ...manifest, config: { enabled: { type: 'boolean', default: true } }, secrets: { token: { type: 'secret' } } });
  assert.equal(schemaManifest.config.enabled.default, true);
  assert.equal(schemaManifest.secrets.token.type, 'secret');
  assert.throws(() => normalizeManifest({ ...manifest, secrets: ['QUEUE_MASTER_KEY'] }), /protected secret/);
});

test('plugin manager discovers and invokes a child-process plugin with namespaced environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-plugin-test-'));
  const pluginDirectory = path.join(root, 'echo');
  fs.mkdirSync(path.join(pluginDirectory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({
    apiVersion: 1,
    id: 'echo',
    version: '1.0.0',
    type: 'middleware',
    failurePolicy: 'fail-closed',
    entrypoint: 'src/index.js',
    config: ['label'],
    secrets: ['token']
  }));
  fs.writeFileSync(path.join(pluginDirectory, 'src/index.js'), `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, label: JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON).label, secret: JSON.parse(process.env.MAILBRIDGE_PLUGIN_SECRETS_JSON).token }) + '\\n');
});
`);

  const manager = createPluginManager({ pluginDirectory: root });
  assert.deepEqual(manager.discover().map((entry) => entry.manifest.id), ['echo']);
  const response = await manager.invoke('echo', 'health', { requestId: 'request-1', payload: {} }, {
    config: { label: 'safe' },
    secrets: { token: 'scoped' }
  });
  assert.deepEqual(response, { requestId: 'request-1', ok: true, label: 'safe', secret: 'scoped' });
});

test('plugin process timeouts terminate hung plugins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-plugin-timeout-'));
  const pluginDirectory = path.join(root, 'hang');
  fs.mkdirSync(path.join(pluginDirectory, 'src'), { recursive: true });
  const manifest = { apiVersion: 1, id: 'hang', version: '1.0.0', type: 'scanner', failurePolicy: 'fail-open', entrypoint: 'src/index.js', config: [], secrets: [] };
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pluginDirectory, 'src/index.js'), 'setTimeout(() => {}, 10000);');
  await assert.rejects(() => runPluginProcess({ pluginDirectory, manifest, operation: 'scan', payload: { requestId: 'timeout' }, timeoutMs: 20 }), /timed out/);
});

test('middleware plugins can transform complete RFC822 messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-middleware-test-'));
  const pluginDirectory = path.join(root, 'headers');
  fs.mkdirSync(path.join(pluginDirectory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'headers', version: '1.0.0', type: 'middleware', failurePolicy: 'fail-closed', entrypoint: 'src/index.js', config: {}, secrets: {}, capabilities: ['raw_email'] }));
  fs.writeFileSync(path.join(pluginDirectory, 'src/index.js'), `const readline=require('node:readline').createInterface({input:process.stdin});readline.once('line',(line)=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:request.requestId,ok:true,result:{action:'continue',rawEmail:'X-Community: yes\\r\\n'+request.payload.rawEmail}})+'\\n')})`);
  const response = await createPluginManager({ pluginDirectory: root }).invoke('headers', 'transform', { requestId: 'middleware-1', payload: { rawEmail: 'Subject: test\r\n\r\nbody' } });
  assert.equal(response.result.rawEmail, 'X-Community: yes\r\nSubject: test\r\n\r\nbody');
});

test('runtime discovery enforces an existing plugin lockfile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-lock-test-'));
  const pluginDirectory = path.join(root, 'unlocked');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'unlocked', version: '1.0.0', type: 'middleware', failurePolicy: 'fail-open', entrypoint: 'index.js', config: {}, secrets: {} }));
  fs.writeFileSync(path.join(root, 'plugins.lock.json'), JSON.stringify({ apiVersion: 1, plugins: {} }));
  assert.deepEqual(createPluginManager({ pluginDirectory: root, lockfilePath: path.join(root, 'plugins.lock.json') }).discover(), []);
});

test('legacy locked plugins retain existing directory names that differ from their IDs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-legacy-plugin-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'custom-folder');
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'legacy', version: '1.0.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: [], secrets: [] }));
  const lockfilePath = path.join(root, 'plugins.lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({ apiVersion: 1, plugins: { legacy: { version: '1.0.0' } } }));
  const manager = createPluginManager({ pluginDirectory: root, lockfilePath });
  assert.equal(manager.find('legacy').directory, installed);
  manager.disable('legacy');
  manager.enable('legacy');
  assert.equal(manager.find('legacy').directory, installed);
});

test('disabling one legacy loose plugin keeps other previously active plugins enabled', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-legacy-plugin-enable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ['first', 'second']) {
    const installed = path.join(root, id);
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id, version: '1.0.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: [], secrets: [] }));
  }
  const manager = createPluginManager({ pluginDirectory: root });
  manager.disable('first');
  assert.deepEqual(manager.discover().map(plugin => plugin.manifest.id), ['second']);
});

test('plugin removal keeps the non-secret lockfile readable by the runtime user', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-remove-test-'));
  const pluginDirectory = path.join(root, 'remove-me');
  const lockfilePath = path.join(root, 'plugins.lock.json');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'remove-me', version: '1.0.0', type: 'middleware', failurePolicy: 'fail-open', entrypoint: 'index.js', config: {}, secrets: {} }));
  fs.writeFileSync(lockfilePath, JSON.stringify({ apiVersion: 1, plugins: { 'remove-me': { package: 'remove-me', version: '1.0.0', integrity: 'sha512-test' } } }));
  const manager = createPluginManager({ pluginDirectory: root, lockfilePath });
  assert.deepEqual(manager.remove('remove-me'), { id: 'remove-me', removed: true });
  if (process.platform !== 'win32') assert.equal(fs.statSync(lockfilePath).mode & 0o777, 0o644);
  fs.accessSync(lockfilePath, fs.constants.R_OK);
  assert.equal(manager.loadLockfile().plugins['remove-me'], undefined);
});

test('plugin removal atomically replaces the lockfile without overwriting another hard link', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-remove-linked-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, 'remove-me');
  const lockfilePath = path.join(root, 'plugins.lock.json');
  const preservedPath = path.join(root, 'preserved.lock.json');
  fs.mkdirSync(pluginDirectory);
  fs.writeFileSync(path.join(pluginDirectory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'remove-me', version: '1.0.0', type: 'middleware', failurePolicy: 'fail-open', entrypoint: 'index.js', config: {}, secrets: {} }));
  const original = JSON.stringify({ apiVersion: 1, plugins: { 'remove-me': { version: '1.0.0' } } });
  fs.writeFileSync(lockfilePath, original);
  fs.linkSync(lockfilePath, preservedPath);
  const manager = createPluginManager({ pluginDirectory: root, lockfilePath });
  assert.deepEqual(manager.remove('remove-me'), { id: 'remove-me', removed: true });
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), original);
  assert.deepEqual(manager.loadLockfile().plugins, {});
});

test('a plugin exiting during a large stdin write rejects without crashing the host', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-plugin-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'exit.js'), 'process.exit(0);');
  const script = `
    const { runPluginProcess } = require(${JSON.stringify(require.resolve('../lib/plugin-manager'))});
    runPluginProcess({ pluginDirectory: ${JSON.stringify(root)}, manifest: { id: 'exit', entrypoint: 'exit.js' },
      operation: 'scan', payload: { requestId: 'early-exit', payload: { rawEmail: 'a'.repeat(8 * 1024 * 1024) } }
    }).then(() => { process.exitCode = 2; }, () => { process.stdout.write('safely rejected'); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'safely rejected');
});
