const test = require('node:test');
const assert = require('node:assert/strict');

const { envValue, generateArtifacts } = require('../scripts/setup');

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
  assert.match(artifacts.envText, /^MAILBRIDGE_PRIVATE_KEY_PATH=\/etc\/mailbridge\/keys\/mailbridge-r2-private\.pem$/m);
  assert.match(artifacts.wranglerText, /^main = "\/opt\/mailbridge\/app\/worker\.js"$/m);
});
