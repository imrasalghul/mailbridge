const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSmtpRelayPolicy } = require('../lib/smtp-relay-policy');

function createTempPemFiles() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-relay-'));
  const certPath = path.join(tempDir, 'relay.crt');
  const keyPath = path.join(tempDir, 'relay.key');
  fs.writeFileSync(certPath, 'CERT');
  fs.writeFileSync(keyPath, 'KEY');
  return { certPath, keyPath };
}

test('smtp relay policy enforces CIDR allowlisting and TLS submission', () => {
  const { certPath, keyPath } = createTempPemFiles();
  const policy = buildSmtpRelayPolicy({
    env: {
      SMTP_RELAY_ALLOWED_CIDRS: '10.0.0.0/8,203.0.113.10',
      SMTP_RELAY_REQUIRE_TLS: 'true',
      SMTP_RELAY_TLS_CERT_FILE: certPath,
      SMTP_RELAY_TLS_KEY_FILE: keyPath
    }
  });

  assert.equal(policy.isRemoteAllowed('10.1.2.3'), true);
  assert.equal(policy.isRemoteAllowed('203.0.113.10'), true);
  assert.equal(policy.isRemoteAllowed('198.51.100.5'), false);
  assert.doesNotThrow(() => policy.assertSecureSession({ secure: true }));
  assert.throws(() => policy.assertSecureSession({ secure: false }), /STARTTLS/);
});

test('smtp relay policy supports explicit insecure override without certs', () => {
  const policy = buildSmtpRelayPolicy({
    env: {
      SMTP_RELAY_REQUIRE_TLS: 'true',
      SMTP_RELAY_ALLOW_INSECURE: 'true'
    }
  });

  assert.equal(policy.tlsEnabled, false);
  assert.doesNotThrow(() => policy.assertSecureSession({ secure: false }));
});

test('smtp relay policy fails closed when TLS is required but certs are missing', () => {
  assert.throws(() => buildSmtpRelayPolicy({
    env: {
      SMTP_RELAY_REQUIRE_TLS: 'true',
      SMTP_RELAY_ALLOW_INSECURE: 'false'
    }
  }), /SMTP_RELAY_TLS_CERT_FILE/);
});
