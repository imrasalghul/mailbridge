const test = require('node:test');
const assert = require('node:assert/strict');

const { createCloudflareDelivery } = require('../lib/cloudflare-delivery');
const { createResendDelivery } = require('../lib/resend-delivery');
const { createUpstreamEmailDelivery } = require('../lib/upstream-email-delivery');
const { assertSupportedUpstreamProvider } = require('../lib/upstream-provider');

function buildMultipartRawEmail() {
  return [
    'From: header-sender@example.com',
    'Subject: Quarterly report',
    'X-Trace-Id: trace-123',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello text',
    '--mix',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello html</p>',
    '--mix',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    '',
    'SGVsbG8=',
    '--mix--',
    ''
  ].join('\r\n');
}

test('upstream delivery routes to the configured provider and allows explicit overrides', async () => {
  const calls = [];
  const sendViaUpstream = createUpstreamEmailDelivery({
    defaultProvider: 'cloudflare',
    resendDelivery: async () => {
      calls.push('resend');
      return { status: 200, messageId: 're-1' };
    },
    cloudflareDelivery: async () => {
      calls.push('cloudflare');
      return { status: 200, messageId: 'cf-1' };
    }
  });

  const defaultResult = await sendViaUpstream({
    from: 'envelope@example.com',
    to: ['dest@example.com'],
    rawInput: 'Subject: hi\r\n\r\nbody'
  });
  assert.equal(defaultResult.messageId, 'cf-1');

  const overrideResult = await sendViaUpstream({
    provider: 'resend',
    from: 'envelope@example.com',
    to: ['dest@example.com'],
    rawInput: 'Subject: hi\r\n\r\nbody'
  });
  assert.equal(overrideResult.messageId, 're-1');

  const cloudflareResult = await sendViaUpstream({
    provider: 'cloudflare',
    from: 'envelope@example.com',
    to: ['dest@example.com'],
    rawInput: 'Subject: hi\r\n\r\nbody'
  });
  assert.equal(cloudflareResult.messageId, 'cf-1');
  assert.deepEqual(calls, ['cloudflare', 'resend', 'cloudflare']);
});

test('unsupported legacy outbound providers are rejected', () => {
  for (const provider of ['sendgrid', 'mailgun']) {
    assert.throws(
      () => assertSupportedUpstreamProvider(provider),
      (error) => {
        assert.match(error.message, /Supported values: cloudflare, resend/);
        assert.equal(error.permanent, true);
        return true;
      }
    );
  }
});

test('resend delivery builds JSON payload with base64 attachments', async () => {
  let request = null;
  const sendViaResend = createResendDelivery({
    apiKey: 're-test',
    injectHeaders: true,
    relayHostname: 'mailbridge.example.com',
    fromFallback: 'fallback@example.com',
    httpClient: {
      async post(url, payload, options) {
        request = { url, payload, options };
        return {
          status: 200,
          data: {
            id: 're-msg-1'
          }
        };
      }
    }
  });

  const result = await sendViaResend('envelope@example.com', ['dest@example.com'], buildMultipartRawEmail());

  assert.equal(result.messageId, 're-msg-1');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers.Authorization, 'Bearer re-test');
  assert.equal(request.payload.from, 'header-sender@example.com');
  assert.equal(request.payload.attachments.length, 1);
  assert.equal(request.payload.attachments[0].filename, 'invoice.pdf');
  assert.equal(request.payload.headers['X-Mailbridge-Relay'], 'smtp-to-resend');
});

test('cloudflare delivery posts Email Service payload to Worker binding endpoint', async () => {
  let request = null;
  const sendViaCloudflare = createCloudflareDelivery({
    workerUrl: 'https://worker.example/api/send/email',
    webhookSecret: 'secret',
    injectHeaders: true,
    relayHostname: 'mailbridge.example.com',
    fromFallback: 'fallback@example.com',
    httpClient: {
      async post(url, payload, options) {
        request = { url, payload, options };
        return {
          status: 200,
          data: {
            success: true,
            messageId: 'cf-msg-1'
          }
        };
      }
    }
  });

  const result = await sendViaCloudflare('envelope@example.com', ['dest@example.com'], buildMultipartRawEmail());

  assert.equal(result.status, 200);
  assert.equal(result.messageId, 'cf-msg-1');
  assert.equal(request.url, 'https://worker.example/api/send/email');
  assert.equal(request.options.headers['X-Webhook-Secret'], 'secret');
  assert.equal(request.payload.from, 'header-sender@example.com');
  assert.deepEqual(request.payload.to, ['dest@example.com']);
  assert.equal(request.payload.attachments.length, 1);
  assert.equal(request.payload.attachments[0].filename, 'invoice.pdf');
  assert.equal(request.payload.headers['X-Mailbridge-Relay'], 'smtp-to-cloudflare');
  assert.equal(request.payload.headers['x-trace-id'], 'trace-123');
});
