const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
