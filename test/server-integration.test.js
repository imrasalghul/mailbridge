const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SMTPServer } = require('smtp-server');
const { encryptPayloadWithPublicKey } = require('../lib/inbound-message-crypto');

for (const profile of ['legacy', 'modern']) test(`running ${profile} backend preserves delivery and authentication contracts`, { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-integration-'));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = path.join(root, 'fixture.pem');
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  // Run the real sources with an isolated cwd and legacy-db location; never load a developer's .env or queue.
  fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(root, 'server.js'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'plugins.lock.json'), JSON.stringify({ apiVersion: 1, plugins: {} }));
  let smtpCode = 0;
  const messages = [];
  const smtp = new SMTPServer({ disabledCommands: ['AUTH', 'STARTTLS'],
    onRcptTo(address, session, callback) {
      callback(smtpCode ? Object.assign(new Error('Synthetic refusal'), { responseCode: smtpCode }) : undefined);
    },
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', chunk => { raw += chunk; });
      stream.on('end', () => { messages.push({ from: session.envelope.mailFrom, raw }); callback(); });
    }
  });
  await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
  const spamd = net.createServer(socket => { socket.resume(); socket.on('end', () => socket.end('SPAMD/1.5 0 EX_OK\r\nSpam: False ; -1.0 / 5.0\r\n\r\n')); });
  spamd.listen(0, '127.0.0.1');
  await once(spamd, 'listening');
  const child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      PORT: '0', WEBHOOK_SECRET: 'synthetic-webhook', QUEUE_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
      DATA_DIR: path.join(root, 'data'), SECRETS_DB_PATH: path.join(root, 'secrets.db'), MAILBRIDGE_PRIVATE_KEY_PATH: privateKeyPath,
      LOCAL_MAIL_HOST: '127.0.0.1', LOCAL_MAIL_PORT: String(smtp.server.address().port), LOCAL_MAIL_REQUIRE_TLS: 'false',
      SPAMD_HOST: '127.0.0.1', SPAMD_PORT: String(spamd.address().port), SMTP_RELAY_ENABLED: 'false',
      MAILBRIDGE_VERBOSE_LOGGING: 'true', ...(profile === 'modern' ? { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' } : {}) }
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await Promise.all([new Promise(resolve => smtp.close(resolve)), new Promise(resolve => spamd.close(resolve))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const httpPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic backend did not become ready')), 8000);
    child.on('exit', () => { clearTimeout(timer); reject(new Error('Synthetic backend exited before readiness')); });
    child.stdout.on('data', () => {
      const match = logs.match(/HTTP listener running on port (\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const url = `http://127.0.0.1:${httpPort}/api/webhook/email`;
  const payload = { from: '', to: 'recipient@example.com', raw: 'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: synthetic\r\n\r\nSynthetic test body' };
  const encryptedPayload = await encryptPayloadWithPublicKey({ publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), payload });
  const post = (body, id = 'fixture-1', secret = 'synthetic-webhook') => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret, 'X-Mailbridge-Delivery-Id': id }, body: JSON.stringify(body) });
  assert.equal((await post({ encryptedPayload }, 'fixture-1', 'wrong')).status, 403);
  assert.equal((await post({ encryptedPayload })).status, 200);
  assert.equal((await post({ encryptedPayload })).status, 200);
  assert.equal(messages.length, profile === 'modern' ? 1 : 2);
  assert.equal(fs.existsSync(path.join(root, 'data', 'delivery-receipts.db')), profile === 'modern');
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/api/plugins/status`)).status, 403);
  const statusResponse = await fetch(`http://127.0.0.1:${httpPort}/api/plugins/status`, { headers: { 'X-Webhook-Secret': 'synthetic-webhook' } });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.profile, profile);
  assert.equal(status.execution.active, 0);
  assert.deepEqual(status.plugins, []);
  assert.equal(messages[0].from.address, '');
  assert.match(messages[0].raw, /Synthetic test body/);
  smtpCode = 550;
  assert.equal((await post(payload, 'fixture-550')).status, 422);
  smtpCode = 451;
  assert.equal((await post(payload, 'fixture-451')).status, 202);
  const marker = '<script>private</script>\r\nFORGED-LOG';
  const bad = await post({ encryptedPayload: { ...encryptedPayload, version: marker } }, 'bad-crypto');
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /^text\/plain/);
  assert.equal(await bad.text(), 'Invalid encrypted payload');
  assert.ok(!logs.includes(marker));
  const invalidJson = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private":' });
  assert.equal(invalidJson.status, 400);
  assert.equal(await invalidJson.text(), 'Invalid JSON');
  assert.equal(messages.length, profile === 'modern' ? 1 : 2);
  if (profile === 'modern') {
    fs.writeFileSync(path.join(root, 'data', 'plugins.lock.json'), JSON.stringify({ apiVersion: 1, plugins: { missing: { version: '1.0.0', enabled: true, type: 'middleware', failurePolicy: 'fail-closed' } } }));
    const health = await fetch(`http://127.0.0.1:${httpPort}/health`);
    assert.equal(health.status, 503);
    assert.equal((await post({ ...payload, raw: payload.raw + 'missing required plugin' }, 'plugin-unavailable')).status, 503);
    assert.equal(messages.length, 1);
  }
});
