const test = require('node:test');
const assert = require('node:assert/strict');

const { envValue, generateArtifacts, runSetup } = require('../scripts/setup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough, Writable } = require('node:stream');
const { parse } = require('dotenv');
const { createQueueCrypto } = require('../lib/queue-crypto');
const { spawnSync } = require('node:child_process');

function setupWithPluginFixture(t, { id, type }) {
  const pluginModule = require('../lib/plugin-manager');
  const makeManager = pluginModule.createPluginManager;
  t.mock.method(pluginModule, 'createPluginManager', options => {
    const manager = makeManager(options);
    const install = manager.install;
    manager.install = specifier => install(specifier, { npmRunner({ cwd }) {
      const name = specifier.slice(0, specifier.lastIndexOf('@'));
      const version = specifier.slice(specifier.lastIndexOf('@') + 1);
      const pluginPath = path.join(cwd, 'node_modules', name);
      fs.mkdirSync(pluginPath, { recursive: true });
      fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({ name, version }));
      fs.writeFileSync(path.join(pluginPath, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id, version, type, failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {}, capabilities: type === 'provider' ? ['send'] : ['reputation'] }));
      fs.writeFileSync(path.join(pluginPath, 'index.js'), 'process.exit(0);');
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [name]: version } }, [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/fixture.tgz`, integrity: 'sha512-Zml4dHVyZQ==' } } }));
    } });
    const enable = manager.enable;
    manager.enable = pluginId => {
      assert.ok(fs.existsSync(path.join(path.dirname(options.pluginDirectory), 'plugins.config.json')), 'configuration must exist before activation');
      return enable(pluginId);
    };
    return manager;
  });
  const modulePath = require.resolve('../scripts/setup');
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  return require(modulePath).runSetup;
}

async function answerSetup(cwd, answers = {}, options = {}) {
  const input = new PassThrough();
  let transcript = '';
  const output = new Writable({ write(chunk, encoding, callback) {
    const prompt = chunk.toString();
    transcript += prompt;
    if (prompt.endsWith(': ')) {
      const configured = Object.entries(answers).find(([label]) => prompt.startsWith(label));
      const answer = configured ? configured[1] : prompt.startsWith('Overwrite ') ? 'yes' : '';
      setImmediate(() => input.write(`${answer}\n`));
    }
    callback();
  } });
  const { setup = runSetup, ...setupOptions } = options;
  try { return { result: await setup({ cwd, input, output, ...setupOptions }), transcript }; }
  finally { input.end(); }
}

test('fresh setup without plugins creates every configuration parent directory', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result } = await answerSetup(root);
  assert.equal(result.written, true);
  assert.ok(fs.existsSync(path.join(root, 'data', 'plugins.config.json')));
  assert.ok(fs.existsSync(path.join(root, 'data', 'queue')));
  const env = parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(env.MAILBRIDGE_BEHAVIOR_PROFILE, 'modern');
  assert.equal(env.MAILBRIDGE_PLUGIN_DIR, '/app/data/plugins');
  assert.equal(env.MAILBRIDGE_PLUGIN_LOCKFILE, '/app/data/plugins.lock.json');
  assert.equal(env.MAILBRIDGE_PLUGIN_CONFIG_FILE, '/app/data/plugins.config.json');
});

test('rerunning setup preserves an unmarked legacy profile and existing complex secret text', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-legacy-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const file = path.join(root, '.env');
  const original = fs.readFileSync(file, 'utf8').replace(/^MAILBRIDGE_BEHAVIOR_PROFILE=.*\r?\n/gm, '') + '\nLEGACY_SETTING=`single \' and double " quotes`\n';
  fs.writeFileSync(file, original);
  const before = parse(original);
  await answerSetup(root);
  const after = parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.MAILBRIDGE_BEHAVIOR_PROFILE, 'legacy');
  assert.equal(after.LEGACY_SETTING, before.LEGACY_SETTING);
  assert.equal(after.QUEUE_MASTER_KEY, before.QUEUE_MASTER_KEY);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(original));
});

test('setup keeps explicit modern adoption and individual overrides on rerun', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-modern-rerun-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  fs.appendFileSync(path.join(root, '.env'), '\nMAILBRIDGE_PLUGIN_STRICT=false\nMAILBRIDGE_DELIVERY_RECEIPTS=false\n');
  await answerSetup(root);
  const after = parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(after.MAILBRIDGE_BEHAVIOR_PROFILE, 'modern');
  assert.equal(after.MAILBRIDGE_PLUGIN_STRICT, 'false');
  assert.equal(after.MAILBRIDGE_DELIVERY_RECEIPTS, 'false');
});

test('legacy setup preserves its Worker date and does not require a new dead-letter queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-legacy-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'MAILBRIDGE_HTTP_ALLOW_REDIRECTS=false\nMAILBRIDGE_HTTP_TIMEOUT_MS=45000\n');
  fs.writeFileSync(path.join(root, 'wrangler.toml'), 'compatibility_date = "2026-05-19"\n');
  const { result, transcript } = await answerSetup(root);
  assert.match(result.wranglerText, /compatibility_date = "2026-05-19"/);
  assert.match(result.wranglerText, /MAILBRIDGE_BEHAVIOR_PROFILE = "legacy"/);
  assert.match(result.wranglerText, /MAILBRIDGE_HTTP_ALLOW_REDIRECTS = "false"/);
  assert.match(result.wranglerText, /MAILBRIDGE_HTTP_TIMEOUT_MS = "45000"/);
  assert.doesNotMatch(result.wranglerText, /dead_letter_queue/);
  assert.doesNotMatch(transcript, /queues create .*dead-letter/);
  fs.appendFileSync(path.join(root, '.env'), '\nMAILBRIDGE_DEAD_LETTER_QUEUE=true\n');
  const optedIn = await answerSetup(root);
  assert.match(optedIn.result.wranglerText, /dead_letter_queue = "mailbridge-inbound-dead-letter"/);
  assert.match(optedIn.transcript, /queues create mailbridge-inbound-dead-letter/);
});

test('setup maps container plugin paths to host storage and preserves a custom config file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-plugin-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginPath = path.join(root, 'data', 'custom', 'plugins', 'custom-provider');
  const configPath = path.join(root, 'data', 'custom', 'settings.json');
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(path.join(pluginPath, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'custom-provider', version: '1.2.3', type: 'provider', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
  fs.writeFileSync(configPath, JSON.stringify({ 'custom-provider': { region: 'preserved' } }));
  fs.writeFileSync(path.join(root, '.env'), 'MAILBRIDGE_PLUGIN_DIR=/app/data/custom/plugins\nMAILBRIDGE_PLUGIN_LOCKFILE=/app/data/custom/registry.json\nMAILBRIDGE_PLUGIN_CONFIG_FILE=/app/data/custom/settings.json\nRELAY_UPSTREAM_PROVIDER=custom-provider\n');
  await answerSetup(root);
  const env = parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(env.RELAY_UPSTREAM_PROVIDER, 'custom-provider');
  assert.equal(env.MAILBRIDGE_PLUGIN_DIR, '/app/data/custom/plugins');
  assert.equal(env.MAILBRIDGE_PLUGIN_LOCKFILE, '/app/data/custom/registry.json');
  assert.equal(env.MAILBRIDGE_PLUGIN_CONFIG_FILE, '/app/data/custom/settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { 'custom-provider': { region: 'preserved' } });
  assert.equal(fs.existsSync(path.join(root, 'data', 'plugins.config.json')), false);
});

test('setup maps custom container private-key paths into the host secrets directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-mapped-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, 'secrets', 'custom', 'active.pem');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(keyPath, privateKey);
  fs.writeFileSync(path.join(root, '.env'), 'MAILBRIDGE_PRIVATE_KEY_PATH=/app/secrets/custom/active.pem\n');
  const { result } = await answerSetup(root);
  const challenge = Buffer.from('synthetic mapped key');
  assert.deepEqual(crypto.privateDecrypt(privateKey, crypto.publicEncrypt(result.publicKey, challenge)), challenge);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), privateKey);
});

test('legacy setup preserves enabled TLS when existing settings use numeric booleans', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-boolean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'LOCAL_MAIL_REQUIRE_TLS=1\n');
  await answerSetup(root);
  assert.equal(parse(fs.readFileSync(path.join(root, '.env'))).LOCAL_MAIL_REQUIRE_TLS, 'true');
});

test('native setup keeps host plugin locations in its runtime configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-native-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'state');
  const keyDirectory = path.join(root, 'keys');
  const pluginDirectory = path.join(dataDirectory, 'plugins');
  const pluginLockfile = path.join(root, 'plugins.lock.json');
  await answerSetup(root, {}, { systemMode: true, envFileName: 'mailbridge.env', dataDirectory, keyDirectory, pluginDirectory, pluginLockfile,
    runtimePaths: { dataDir: dataDirectory, secretsDbPath: path.join(dataDirectory, 'secrets.db'), privateKeyPath: path.join(keyDirectory, 'mailbridge-r2-private.pem') } });
  const env = parse(fs.readFileSync(path.join(root, 'mailbridge.env')));
  assert.equal(env.MAILBRIDGE_PLUGIN_DIR, pluginDirectory);
  assert.equal(env.MAILBRIDGE_PLUGIN_LOCKFILE, pluginLockfile);
  assert.equal(env.MAILBRIDGE_PLUGIN_CONFIG_FILE, path.join(root, 'plugins.config.json'));
  assert.ok(fs.existsSync(pluginLockfile));
});

test('setup activates a selected scanner by its manifest ID after saving configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-activate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const setup = setupWithPluginFixture(t, { id: 'reputation-scanner', type: 'scanner' });
  await answerSetup(root, { 'Enable Spamhaus plugin': 'yes', 'Exact npm package/version for Spamhaus': 'fixture-scanner@1.0.0' }, { setup });
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'data', 'plugins.lock.json')));
  assert.equal(registry.plugins['reputation-scanner'].enabled, true);
  const manager = require('../lib/plugin-manager').createPluginManager({ pluginDirectory: path.join(root, 'data', 'plugins'), lockfilePath: path.join(root, 'data', 'plugins.lock.json'), strict: true });
  assert.equal(manager.discover()[0].manifest.id, 'reputation-scanner');
});

test('setup rejects a package that does not declare the requested named provider', async t => {
  for (const manifest of [{ id: 'sendgrid', type: 'scanner' }, { id: 'different-provider', type: 'provider' }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-provider-contract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const setup = setupWithPluginFixture(t, manifest);
    await assert.rejects(answerSetup(root, { 'Outbound provider': 'sendgrid', 'Exact npm package/version for Sendgrid': 'fixture-provider@1.0.0' }, { setup }), /requested sendgrid provider/);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'data', 'plugins.lock.json')));
    assert.equal(registry.plugins[manifest.id].enabled, false);
    t.mock.restoreAll();
  }
});

test('legacy setup keeps linked configuration paths while updating their existing targets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-linked-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'saved.env');
  const link = path.join(root, '.env');
  fs.writeFileSync(target, 'MAILBRIDGE_HOSTNAME=old.example.com\n');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (error.code === 'EPERM') return t.skip('Host does not permit creating symbolic links');
    throw error;
  }
  await answerSetup(root, { 'Public Mailbridge hostname': 'updated.example.com' });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(parse(fs.readFileSync(target)).MAILBRIDGE_HOSTNAME, 'updated.example.com');
});

test('overwriting setup preserves mail encryption and webhook secrets without printing them', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-existing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  await answerSetup(root);
  const before = parse(fs.readFileSync(path.join(root, '.env')));
  const originalCrypto = createQueueCrypto({ masterKey: before.QUEUE_MASTER_KEY });
  const perMessageSecret = originalCrypto.generatePerMessageSecret();
  const encryptedPayload = originalCrypto.encryptQueuePayload({ queueId: 'test', perMessageSecret, payload: { raw: 'synthetic mail' } });
  const { transcript } = await answerSetup(root);
  const after = parse(fs.readFileSync(path.join(root, '.env')));
  for (const name of ['QUEUE_MASTER_KEY', 'WEBHOOK_SECRET', 'CLOUDFLARE_SEND_WEBHOOK_SECRET']) {
    assert.ok(after[name] === before[name], `${name} must be preserved`);
    assert.equal(transcript.includes(after[name]), false, `${name} must not be printed`);
  }
  assert.deepEqual(createQueueCrypto({ masterKey: after.QUEUE_MASTER_KEY }).decryptQueuePayload({ queueId: 'test', perMessageSecret, encryptedPayload }), { raw: 'synthetic mail' });
});

test('setup refuses to replace a missing master key while encrypted queued mail exists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-queue-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data', 'queue'), { recursive: true });
  const queueFile = path.join(root, 'data', 'queue', 'pending.eml');
  fs.writeFileSync(queueFile, 'synthetic encrypted queue fixture');
  await assert.rejects(answerSetup(root), /original QUEUE_MASTER_KEY/);
  assert.equal(fs.readFileSync(queueFile, 'utf8'), 'synthetic encrypted queue fixture');
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
  assert.equal(fs.existsSync(path.join(root, 'secrets')), false);
});

test('setup checks the preserved custom data directory before replacing a missing queue key', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-custom-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const customDataDirectory = path.join(root, 'custom data');
  fs.mkdirSync(path.join(customDataDirectory, 'queue'), { recursive: true });
  const queueFile = path.join(customDataDirectory, 'queue', 'pending.eml');
  fs.writeFileSync(queueFile, 'synthetic encrypted queue fixture');
  const originalEnv = `DATA_DIR=${envValue(customDataDirectory)}\n`;
  fs.writeFileSync(path.join(root, '.env'), originalEnv);
  await assert.rejects(answerSetup(root), /original QUEUE_MASTER_KEY/);
  assert.equal(fs.readFileSync(queueFile, 'utf8'), 'synthetic encrypted queue fixture');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), originalEnv);
  assert.equal(fs.existsSync(path.join(root, 'secrets')), false);
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
  assert.equal(fs.existsSync(path.join(root, 'wrangler.toml')), false);
});

test('setup replaces configuration atomically without changing other hard links', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-linked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const envPath = path.join(root, '.env');
  const preservedPath = path.join(root, 'preserved.env');
  fs.linkSync(envPath, preservedPath);
  const original = fs.readFileSync(preservedPath, 'utf8');
  await answerSetup(root, { 'Public Mailbridge hostname': 'changed.example.com' });
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), original);
  assert.equal(parse(fs.readFileSync(envPath)).MAILBRIDGE_HOSTNAME, 'changed.example.com');
});

test('setup preserves an installed provider and its configuration on rerun', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const pluginPath = path.join(root, 'data', 'plugins', 'custom-provider');
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(path.join(pluginPath, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'custom-provider', version: '1.2.3', type: 'provider', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: { region: { default: 'wrong-region' } }, secrets: ['API_KEY'] }));
  const envPath = path.join(root, '.env');
  const env = fs.readFileSync(envPath, 'utf8').replace('RELAY_UPSTREAM_PROVIDER=cloudflare', 'RELAY_UPSTREAM_PROVIDER=custom-provider').replace('MAILBRIDGE_BEHAVIOR_PROFILE=modern', 'MAILBRIDGE_BEHAVIOR_PROFILE=legacy');
  fs.rmSync(path.join(root, 'data', 'plugins.lock.json'), { force: true });
  fs.writeFileSync(envPath, `${env}\nMAILBRIDGE_PLUGIN_CUSTOM_PROVIDER_API_KEY=synthetic-secret\nCUSTOM_OPERATOR_SETTING=preserve-me\n`);
  fs.writeFileSync(path.join(root, 'data', 'plugins.config.json'), JSON.stringify({ 'custom-provider': { region: 'chosen-region' }, scanner: { threshold: 4 } }));
  const { transcript } = await answerSetup(root);
  const updated = parse(fs.readFileSync(envPath));
  assert.equal(updated.RELAY_UPSTREAM_PROVIDER, 'custom-provider');
  assert.equal(updated.MAILBRIDGE_PLUGIN_CUSTOM_PROVIDER_API_KEY, 'synthetic-secret');
  assert.equal(updated.CUSTOM_OPERATOR_SETTING, 'preserve-me');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'plugins.config.json'))), { 'custom-provider': { region: 'chosen-region' }, scanner: { threshold: 4 } });
  assert.equal(transcript.includes('synthetic-secret'), false);
});

test('setup keeps existing key files unchanged and refuses incomplete pairs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-key-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const privatePath = path.join(root, 'secrets', 'mailbridge-r2-private.pem');
  const publicPath = path.join(root, 'secrets', 'mailbridge-r2-public.pem');
  const privateBefore = fs.readFileSync(privatePath);
  const publicBefore = fs.readFileSync(publicPath);
  await answerSetup(root);
  assert.deepEqual(fs.readFileSync(privatePath), privateBefore);
  assert.deepEqual(fs.readFileSync(publicPath), publicBefore);
  fs.unlinkSync(privatePath);
  await assert.rejects(answerSetup(root), /restore the pair/);
  assert.equal(fs.existsSync(privatePath), false);
  assert.deepEqual(fs.readFileSync(publicPath), publicBefore);
});

test('setup derives its upload key from the preserved custom private-key path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-custom-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const customPrivatePath = path.join(root, 'custom-private.pem');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(customPrivatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.env'), `MAILBRIDGE_PRIVATE_KEY_PATH=${envValue(customPrivatePath)}\n`);
  const { result, transcript } = await answerSetup(root);
  const after = parse(fs.readFileSync(path.join(root, '.env')));
  assert.equal(after.MAILBRIDGE_PRIVATE_KEY_PATH, customPrivatePath);
  assert.equal(fs.readFileSync(customPrivatePath, 'utf8'), privateKey);
  const challenge = Buffer.from('synthetic key consistency challenge');
  assert.deepEqual(crypto.privateDecrypt(privateKey, crypto.publicEncrypt(result.publicKey, challenge)), challenge);
  const manualPublicPath = transcript.match(/secret put MAILBRIDGE_PUBLIC_KEY_PEM < (.+)\n/)[1];
  assert.deepEqual(crypto.privateDecrypt(privateKey, crypto.publicEncrypt(fs.readFileSync(manualPublicPath), challenge)), challenge);
  assert.equal(fs.existsSync(path.join(root, 'secrets', 'mailbridge-r2-private.pem')), false);
  assert.equal(transcript.includes(privateKey), false);
});

test('setup refuses missing, invalid, or non-file configured private keys before writing configuration', async t => {
  for (const scenario of ['missing', 'invalid', 'directory']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `mailbridge-setup-key-${scenario}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const customPrivatePath = path.join(root, 'custom-private.pem').replaceAll('\\', '/');
    if (scenario === 'invalid') fs.writeFileSync(customPrivatePath, 'not a private key');
    if (scenario === 'directory') fs.mkdirSync(customPrivatePath);
    const originalEnv = `MAILBRIDGE_PRIVATE_KEY_PATH=${envValue(customPrivatePath)}\n`;
    fs.writeFileSync(path.join(root, '.env'), originalEnv);
    await assert.rejects(answerSetup(root), /configured.*private key/i, scenario);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), originalEnv);
    assert.equal(fs.existsSync(path.join(root, 'wrangler.toml')), false);
    assert.equal(fs.existsSync(path.join(root, 'secrets')), false);
    assert.equal(fs.existsSync(path.join(root, 'data')), false);
  }
});

test('setup never generates replacement keys when its configured default key pair is missing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-missing-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const privatePath = path.join(root, 'secrets', 'mailbridge-r2-private.pem');
  const publicPath = path.join(root, 'secrets', 'mailbridge-r2-public.pem');
  fs.unlinkSync(privatePath);
  fs.unlinkSync(publicPath);
  const originalEnv = fs.readFileSync(path.join(root, '.env'));
  await assert.rejects(answerSetup(root), /restore the pair/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.env')), originalEnv);
  assert.equal(fs.existsSync(privatePath), false);
  assert.equal(fs.existsSync(publicPath), false);
});

test('setup rejects linked key files without overwriting their target', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await answerSetup(root);
  const publicPath = path.join(root, 'secrets', 'mailbridge-r2-public.pem');
  const targetPath = path.join(root, 'saved-public.pem');
  fs.renameSync(publicPath, targetPath);
  try { fs.symlinkSync(targetPath, publicPath, 'file'); }
  catch (error) {
    if (error.code === 'EPERM') return t.skip('Host does not permit creating symbolic links');
    throw error;
  }
  const before = fs.readFileSync(targetPath);
  await assert.rejects(answerSetup(root), /symbolic link|ELOOP|regular file/);
  assert.deepEqual(fs.readFileSync(targetPath), before);
});

test('setup manual deployment creates the dead-letter queue with pinned Wrangler before deployment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-dlq-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, transcript } = await answerSetup(root, { 'Cloudflare Queue name': 'incoming-mail' });
  assert.match(result.wranglerText, /compatibility_date = "2026-10-21"/);
  assert.match(result.wranglerText, /\[\[queues.consumers\]\][\s\S]*dead_letter_queue = "incoming-mail-dead-letter"/);
  assert.match(result.wranglerText, /max_retries = 3/);
  assert.match(transcript, /npx --yes wrangler@4\.151\.3 queues create incoming-mail-dead-letter/);
  assert.ok(transcript.indexOf('queues create incoming-mail-dead-letter') < transcript.indexOf('wrangler@4.151.3 deploy'));
  assert.doesNotMatch(transcript, /--yes wrangler /);
});

function baseConfig(overrides = {}) {
  return {
    hostname: 'mailbridge.example.com',
    workerName: 'mailbridge-worker',
    localMailHost: 'mail.internal.example',
    localMailPort: 25,
    localMailRequireTls: true,
    localMailTlsServername: '',
    localMailTlsCaFile: '',
    spamAssassinMode: 'local',
    upstreamProvider: 'sendgrid',
    relayFrom: 'postmaster@example.com',
    mailgunDomain: '',
    workerSendUrl: '',
    smtpRelayEnabled: false,
    allowedCidrs: '127.0.0.1/32,::1/128',
    smtpRelayRequireTls: true,
    smtpRelayAllowInsecure: false,
    smtpRelayTlsCertFile: '',
    smtpRelayTlsKeyFile: '',
    smtpRelayTlsCaFile: '',
    cloudflaredEnabled: false,
    cloudflareTunnelToken: '',
    r2BucketName: 'mailbridge-inbound',
    queueName: 'mailbridge-inbound',
    ...overrides
  };
}

test('interactive setup artifacts contain valid runtime and Worker configuration', () => {
  const artifacts = generateArtifacts(baseConfig(), {
    queueMasterKey: 'queue-key',
    webhookSecret: 'webhook-secret',
    cloudflareSendSecret: 'send-secret'
  });

  assert.match(artifacts.envText, /^PORT=3090/m);
  assert.match(artifacts.envText, /^QUEUE_MASTER_KEY=queue-key/m);
  assert.match(artifacts.envText, /^WEBHOOK_SECRET=webhook-secret/m);
  assert.match(artifacts.envText, /^SMTP_RELAY_ENABLED=false/m);
  assert.match(artifacts.wranglerText, /^name = "mailbridge-worker"/m);
  assert.match(artifacts.wranglerText, /^NODE_APP_URL = "https:\/\/mailbridge\.example\.com\/api\/webhook\/email"/m);
  assert.match(artifacts.wranglerText, /\[\[send_email\]\]\nname = "EMAIL"/);
  assert.doesNotMatch(artifacts.wranglerText, /webhook-secret|send-secret|queue-key/);
  assert.equal(artifacts.publicKey, '');
  assert.equal(artifacts.r2BucketName, 'mailbridge-inbound');
  assert.equal(artifacts.queueName, 'mailbridge-inbound');
});

test('dotenv values with whitespace or comment characters are quoted', () => {
  assert.equal(envValue('simple.example'), 'simple.example');
  assert.equal(envValue('value with spaces # comment'), '"value with spaces # comment"');
});

test('dotenv serialization preserves Windows paths, quotes, newlines, and secret values without adding assignments', () => {
  const cases = [
    [null, ''], [undefined, ''], ['', ''],
    [String.raw`C:\Users\Ras\keys\private.pem`, String.raw`C:\Users\Ras\keys\private.pem`],
    [String.raw`C:\Users\A Person\new\private.pem`, String.raw`C:\Users\A Person\new\private.pem`],
    ['a "quoted" secret # value', 'a "quoted" secret # value'],
    ["single ' quoted secret", "single ' quoted secret"],
    ['first\nINJECTED=yes\nlast', 'first\nINJECTED=yes\nlast'],
    ['$DO_NOT_EXPAND ${SECRET}', '$DO_NOT_EXPAND ${SECRET}'],
    [String.raw`literal\nsecret`, String.raw`literal\nsecret`],
    [String.raw`literal\n` + '\nINJECTED=yes', String.raw`literal\n` + '\nINJECTED=yes']
  ];
  for (const [value, expected] of cases) {
    const encoded = `VALUE=${envValue(value)}\nBOUNDARY=unchanged\n`;
    for (const fast of [false, true]) {
      assert.deepEqual(parse(encoded, { fast }), { VALUE: expected, BOUNDARY: 'unchanged' });
    }
  }
  assert.equal(envValue('first\nINJECTED=yes\nlast'), "'first\nINJECTED=yes\nlast'");
  assert.equal(envValue('$DO_NOT_EXPAND ${SECRET}'), "'$DO_NOT_EXPAND ${SECRET}'");
  assert.throws(() => envValue("single ' and double \" quotes"), /represented safely/);
  assert.throws(() => envValue('first\r\nlast'), /represented safely/);
  assert.throws(() => envValue('all three quotes: \' " `\nINJECTED=yes #'), /represented safely/);
});

test('setup refuses nonportable environment values before creating keys or writing configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-nonportable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEnv = 'MAILBRIDGE_BEHAVIOR_PROFILE=modern\nPLUGIN_SECRET=`single \' and double " quotes`\n';
  fs.writeFileSync(path.join(root, '.env'), originalEnv);
  await assert.rejects(answerSetup(root), /represented safely/);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), originalEnv);
  assert.equal(fs.existsSync(path.join(root, 'secrets')), false);
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
  assert.equal(fs.existsSync(path.join(root, 'wrangler.toml')), false);
});

test('setup artifacts support native Debian paths and packaged Worker entrypoint', () => {
  const artifacts = generateArtifacts(baseConfig({
    dataDir: '/var/lib/mailbridge',
    secretsDbPath: '/var/lib/mailbridge/secrets.db',
    privateKeyPath: '/etc/mailbridge/keys/mailbridge-r2-private.pem',
    workerMain: '/opt/mailbridge/app/worker.js'
  }), {
    queueMasterKey: 'queue-key',
    webhookSecret: 'webhook-secret',
    cloudflareSendSecret: 'send-secret'
  });

  assert.match(artifacts.envText, /^DATA_DIR=\/var\/lib\/mailbridge$/m);
  assert.match(artifacts.envText, /^SECRETS_DB_PATH=\/var\/lib\/mailbridge\/secrets\.db$/m);
  assert.match(artifacts.envText, /^MAILBRIDGE_PLUGIN_DIR=\/app\/data\/plugins$/m);
  assert.match(artifacts.envText, /^MAILBRIDGE_PLUGIN_CONFIG_FILE=\/app\/data\/plugins.config.json$/m);
  assert.match(artifacts.envText, /^MAILBRIDGE_PRIVATE_KEY_PATH=\/etc\/mailbridge\/keys\/mailbridge-r2-private\.pem$/m);
  assert.match(artifacts.wranglerText, /^main = "\/opt\/mailbridge\/app\/worker\.js"$/m);
});

test('Debian setup leaves plugin ownership with root and accepts absent default key files', t => {
  const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
  if (!fs.existsSync(shell)) return t.skip('A POSIX shell is unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-debian-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shellRoot = root.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const location of ['etc/mailbridge/keys', 'var/lib/mailbridge/queue', 'var/lib/mailbridge/plugins']) fs.mkdirSync(path.join(root, location), { recursive: true });
  for (const name of ['mailbridge.env', 'wrangler.toml']) fs.writeFileSync(path.join(root, 'etc/mailbridge', name), 'synthetic');
  const commandLog = path.join(root, 'commands.log');
  const commands = {
    id: '#!/bin/sh\nprintf "0\\n"\n',
    node: '#!/bin/sh\nexit 0\n',
    systemctl: '#!/bin/sh\nexit 0\n',
    chown: '#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$COMMAND_LOG"\n',
    chmod: '#!/bin/sh\nprintf "chmod %s\\n" "$*" >> "$COMMAND_LOG"\nfor argument do\n case "$argument" in */*) [ -e "$argument" ] || exit 1 ;; esac\ndone\n'
  };
  for (const [name, script] of Object.entries(commands)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  const wrapper = fs.readFileSync(path.join(__dirname, '..', 'packaging/debian/mailbridge-setup'), 'utf8').replaceAll('\r\n', '\n')
    .replaceAll('/opt/mailbridge/node/bin/node', `${shellRoot}/bin/node`)
    .replaceAll('/etc/mailbridge', `${shellRoot}/etc/mailbridge`)
    .replaceAll('/var/lib/mailbridge', `${shellRoot}/var/lib/mailbridge`);
  const executable = path.join(root, 'setup.sh');
  fs.writeFileSync(executable, `PATH="${shellRoot}/bin:$PATH"\n${wrapper}`);
  const result = spawnSync(shell, [executable], { encoding: 'utf8', env: { ...process.env, COMMAND_LOG: commandLog.replaceAll('\\', '/'), MSYS_NO_PATHCONV: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(commandLog, 'utf8').split('\n');
  assert.ok(!lines.some(line => line.startsWith('chown -R mailbridge:mailbridge ') && line.endsWith(`${shellRoot}/var/lib/mailbridge`)), 'runtime ownership must not recurse into plugins');
  assert.ok(lines.some(line => line === `chown -R root:mailbridge ${shellRoot}/var/lib/mailbridge/plugins`));
  assert.ok(!lines.some(line => line.startsWith('chmod ') && line.includes('mailbridge-r2-private.pem')));
});
