const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pluginEnvironment, loadPluginConfig } = require('../lib/plugin-environment');

const manifest = { id: 'sample', config: { enabled: { type: 'boolean', default: true }, threshold: { type: 'number', required: true } }, secrets: { API_KEY: { required: true } } };

test('legacy plugin configuration preserves global secrets and untyped values', () => {
  const result = pluginEnvironment(manifest, { env: { API_KEY: 'synthetic-global' }, config: { sample: { threshold: '5', extra: 'kept' } } });
  assert.equal(result.secrets.API_KEY, 'synthetic-global');
  assert.deepEqual(result.config, { threshold: '5', extra: 'kept' });
});

test('strict plugin settings only expose declared namespaced secrets and validate types', () => {
  const result = pluginEnvironment(manifest, { strict: true, env: { API_KEY: 'synthetic-global', MAILBRIDGE_PLUGIN_SAMPLE_API_KEY: 'synthetic-scoped', MAILBRIDGE_PLUGIN_SAMPLE_enabled: 'false' }, config: { sample: { threshold: '5', extra: 'private-unused' } } });
  assert.deepEqual(result.config, { enabled: false, threshold: 5 });
  assert.deepEqual(result.secrets, { API_KEY: 'synthetic-scoped' });
  assert.throws(() => pluginEnvironment(manifest, { strict: true, env: { API_KEY: 'synthetic-global' }, config: { sample: { threshold: 5 } } }), /required secret.*API_KEY/i);
  assert.throws(() => pluginEnvironment(manifest, { strict: true, env: { MAILBRIDGE_PLUGIN_SAMPLE_API_KEY: 'synthetic' }, config: { sample: { threshold: 'not-a-number' } } }), /threshold/);
});

test('strict configuration rejects invalid documents without disclosing their contents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-plugin-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{ synthetic-private-data');
  assert.deepEqual(loadPluginConfig(file, { strict: false }), {});
  assert.throws(() => loadPluginConfig(file, { strict: true }), error => /Invalid plugin configuration/.test(error.message) && !error.message.includes('synthetic-private-data'));
  fs.writeFileSync(file, '[]');
  assert.throws(() => loadPluginConfig(file, { strict: true }), /Invalid plugin configuration/);
});
