const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { createSmtpRelayServer } = require('../lib/smtp-relay-server');

function captureServerOptions() {
  let options;
  class FakeSmtpServer {
    constructor(value) {
      options = value;
    }
  }
  return { FakeSmtpServer, get options() { return options; } };
}

test('smtp relay discards oversized DATA and returns 552', async () => {
  const captured = captureServerOptions();
  let deliveryCalls = 0;
  createSmtpRelayServer({
    verboseAppLogging: false,
    socketTimeoutMs: 1000,
    maxMessageSizeBytes: 8,
    logSmtpRelay() {},
    async sendViaUpstream() { deliveryCalls += 1; },
    async addToQueue() {},
    relayFromFallback: 'postmaster@example.com',
    upstreamProvider: 'sendgrid',
    policy: {
      tlsEnabled: false,
      tlsOptions: null,
      assertSecureSession() {}
    },
    smtpServerClass: captured.FakeSmtpServer
  });

  assert.equal(captured.options.size, 8);
  const stream = new PassThrough();
  const result = new Promise((resolve) => {
    captured.options.onData(stream, {
      id: 'test-session',
      envelope: {
        mailFrom: { address: 'sender@example.com' },
        rcptTo: [{ address: 'dest@example.com' }]
      }
    }, resolve);
  });
  stream.end(Buffer.from('123456789'));

  const error = await result;
  assert.equal(error.responseCode, 552);
  assert.equal(deliveryCalls, 0);
});

test('smtp relay rejects an invalid maximum message size', () => {
  assert.throws(() => createSmtpRelayServer({
    maxMessageSizeBytes: 0,
    upstreamProvider: 'sendgrid'
  }), /positive integer/);
});

test('a delivered relay message is not queued again when auditing fails', async () => {
  const captured = captureServerOptions();
  let deliveries = 0;
  let queued = 0;
  createSmtpRelayServer({
    logSmtpRelay() {},
    async sendViaUpstream() { deliveries++; return { status: 200 }; },
    async addToQueue() { queued++; },
    upstreamProvider: 'cloudflare',
    policy: { tlsEnabled: false, assertSecureSession() {} },
    auditStore: { async logEvent() { throw new Error('synthetic audit failure'); } },
    smtpServerClass: captured.FakeSmtpServer
  });
  const stream = new PassThrough();
  const result = new Promise(resolve => captured.options.onData(stream, {
    id: 'audit-failure', envelope: { mailFrom: { address: 'sender@example.com' }, rcptTo: [{ address: 'dest@example.com' }] }
  }, resolve));
  stream.end('Subject: test\r\n\r\nbody');
  assert.equal(await result, undefined);
  assert.equal(deliveries, 1);
  assert.equal(queued, 0);
});
