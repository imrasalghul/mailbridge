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

async function answerSetup(cwd, answers = {}) {
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
  try { return { result: await runSetup({ cwd, input, output }), transcript }; }
  finally { input.end(); }
}

test('fresh setup without plugins creates every configuration parent directory', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-setup-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result } = await answerSetup(root);
  assert.equal(result.written, true);
  assert.ok(fs.existsSync(path.join(root, 'data', 'plugins.config.json')));
  assert.ok(fs.existsSync(path.join(root, 'data', 'queue')));
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
  const env = fs.readFileSync(envPath, 'utf8').replace('RELAY_UPSTREAM_PROVIDER=cloudflare', 'RELAY_UPSTREAM_PROVIDER=custom-provider');
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
  const originalEnv = 'PLUGIN_SECRET=`single \' and double " quotes`\n';
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
  assert.match(artifacts.envText, /^MAILBRIDGE_PLUGIN_DIR=\/app\/plugins$/m);
  assert.match(artifacts.envText, /^MAILBRIDGE_PLUGIN_CONFIG_FILE=\/app\/data\/plugins.config.json$/m);
  assert.match(artifacts.envText, /^MAILBRIDGE_PRIVATE_KEY_PATH=\/etc\/mailbridge\/keys\/mailbridge-r2-private\.pem$/m);
  assert.match(artifacts.wranglerText, /^main = "\/opt\/mailbridge\/app\/worker\.js"$/m);
});
