const test = require('node:test');
const assert = require('node:assert/strict');

const { createMailgunDelivery } = require('../lib/mailgun-delivery');
const { createResendDelivery } = require('../lib/resend-delivery');
const { createSendGridDelivery } = require('../lib/sendgrid-delivery');
const { createUpstreamEmailDelivery } = require('../lib/upstream-email-delivery');

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
    defaultProvider: 'resend',
    sendgridDelivery: async () => {
      calls.push('sendgrid');
      return { status: 202, messageId: 'sg-1' };
    },
    resendDelivery: async () => {
      calls.push('resend');
      return { status: 200, messageId: 're-1' };
    },
    mailgunDelivery: async () => {
      calls.push('mailgun');
      return { status: 200, messageId: 'mg-1' };
    }
  });

  const defaultResult = await sendViaUpstream({
    from: 'envelope@example.com',
    to: ['dest@example.com'],
    rawInput: 'Subject: hi\r\n\r\nbody'
  });
  assert.equal(defaultResult.messageId, 're-1');

  const overrideResult = await sendViaUpstream({
    provider: 'mailgun',
    from: 'envelope@example.com',
    to: ['dest@example.com'],
    rawInput: 'Subject: hi\r\n\r\nbody'
  });
  assert.equal(overrideResult.messageId, 'mg-1');
  assert.deepEqual(calls, ['resend', 'mailgun']);
});

test('sendgrid delivery builds JSON payload with custom headers and attachments', async () => {
  let request = null;
  const sendViaSendGrid = createSendGridDelivery({
    apiKey: 'sg-test',
    injectHeaders: true,
    relayHostname: 'mailbridge.example.com',
    fromFallback: 'fallback@example.com',
    httpClient: {
      async post(url, payload, options) {
        request = { url, payload, options };
        return {
          status: 202,
          headers: {
            'x-message-id': 'sg-msg-1'
          }
        };
      }
    }
  });

  const result = await sendViaSendGrid('envelope@example.com', ['dest@example.com'], buildMultipartRawEmail());

  assert.equal(result.messageId, 'sg-msg-1');
  assert.equal(request.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(request.options.headers.Authorization, 'Bearer sg-test');
  assert.equal(request.payload.from.email, 'header-sender@example.com');
  assert.equal(request.payload.attachments.length, 1);
  assert.equal(request.payload.attachments[0].filename, 'invoice.pdf');
  assert.equal(request.payload.headers['x-trace-id'], 'trace-123');
  assert.equal(request.payload.headers['X-Mailbridge-Relay'], 'smtp-to-sendgrid');
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

test('mailgun delivery sends MIME payload with injected relay headers', async () => {
  let request = null;
  const sendViaMailgun = createMailgunDelivery({
    apiKey: 'mg-test',
    domain: 'mg.example.com',
    injectHeaders: true,
    relayHostname: 'mailbridge.example.com',
    fromFallback: 'fallback@example.com',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'mg-msg-1' };
        }
      };
    }
  });

  const result = await sendViaMailgun('', ['dest@example.com'], 'Subject: Hello\r\n\r\nBody');

  assert.equal(result.messageId, 'mg-msg-1');
  assert.equal(request.url, 'https://api.mailgun.net/v3/mg.example.com/messages.mime');
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.deepEqual(request.options.body.getAll('to'), ['dest@example.com']);
  const messageFile = request.options.body.get('message');
  const messageText = await messageFile.text();
  assert.match(messageText, /From: fallback@example\.com/);
  assert.match(messageText, /X-Mailbridge-Relay: smtp-to-mailgun/);
});
