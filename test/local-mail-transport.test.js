const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildLocalMailTransportConfig } = require('../lib/local-mail-transport');

test('local mail transport defaults require verified TLS', () => {
  const config = buildLocalMailTransportConfig({
    env: {
      LOCAL_MAIL_HOST: 'mail.internal.example',
      LOCAL_MAIL_PORT: '25'
    }
  });

  assert.equal(config.host, 'mail.internal.example');
  assert.equal(config.port, 25);
  assert.equal(config.secure, false);
  assert.equal(config.requireTLS, true);
  assert.equal(config.tls.rejectUnauthorized, true);
  assert.equal(config.tls.servername, 'mail.internal.example');
});

test('local mail transport loads custom CA bundle', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-ca-'));
  const caPath = path.join(tempDir, 'ca.pem');
  fs.writeFileSync(caPath, 'FAKE CERTIFICATE DATA\n');

  const config = buildLocalMailTransportConfig({
    env: {
      LOCAL_MAIL_HOST: 'mail.internal.example',
      LOCAL_MAIL_TLS_CA_FILE: caPath
    }
  });

  assert.equal(config.tls.ca, 'FAKE CERTIFICATE DATA\n');
});

test('local mail transport supports explicit insecure compatibility mode', () => {
  const config = buildLocalMailTransportConfig({
    env: {
      LOCAL_MAIL_REQUIRE_TLS: 'false',
      LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED: 'false'
    }
  });

  assert.equal(config.requireTLS, false);
  assert.equal(config.tls.rejectUnauthorized, false);
});

test('local mail transport ignores legacy EXCHANGE_* environment variables', () => {
  const config = buildLocalMailTransportConfig({
    env: {
      EXCHANGE_HOST: 'legacy.example',
      EXCHANGE_PORT: '2526'
    }
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 25);
});
