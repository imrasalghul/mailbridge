const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudflareDelivery } = require('../lib/cloudflare-delivery');

const raw = [
  'From: Sender <sender@example.com>',
  'To: Visible <visible@example.com>',
  'Cc: Copy <copy@example.com>',
  'Reply-To: replies@example.com',
  'In-Reply-To: <parent@example.com>',
  'References: <root@example.com> <parent@example.com>',
  'Subject: Private recipients', '', 'body'
].join('\r\n');

async function captureDelivery(recipients) {
  let payload;
  const deliver = createCloudflareDelivery({
    workerUrl: 'https://example.invalid/api/send/email', webhookSecret: 'synthetic',
    httpClient: { async post(url, body) { payload = body; return { status: 200, data: { messageId: 'synthetic' } }; } }
  });
  await deliver('sender@example.com', recipients, raw);
  return payload;
}

test('Cloudflare delivery keeps envelope-only recipients in Bcc', async () => {
  const payload = await captureDelivery(['visible@example.com', 'copy@example.com', 'hidden@example.com']);
  assert.deepEqual(payload.to, ['visible@example.com']);
  assert.deepEqual(payload.cc, ['copy@example.com']);
  assert.deepEqual(payload.bcc, ['hidden@example.com']);
});

test('recipient-specific retries never reintroduce other visible recipients', async () => {
  const payload = await captureDelivery(['hidden@example.com']);
  assert.equal(payload.to, undefined);
  assert.equal(payload.cc, undefined);
  assert.deepEqual(payload.bcc, ['hidden@example.com']);
});

test('Cloudflare delivery retains reply routing and threading headers', async () => {
  const payload = await captureDelivery(['visible@example.com']);
  assert.equal(payload.replyTo, 'replies@example.com');
  assert.equal(payload.headers['In-Reply-To'], '<parent@example.com>');
  assert.equal(payload.headers.References, '<root@example.com> <parent@example.com>');
});

test('Cloudflare transport keeps infrastructure and authentication failures retryable', async () => {
  for (const status of [400, 401, 403, 404, 408, 413, 422, 429, 502]) {
    const deliver = createCloudflareDelivery({ workerUrl: 'https://example.invalid/api/send/email', webhookSecret: 'synthetic',
      httpClient: { async post() { throw Object.assign(new Error('Failure'), { response: { status } }); } } });
    await assert.rejects(deliver('sender@example.com', ['visible@example.com'], raw), error => {
      assert.equal(error.permanent, [400, 406, 413, 422].includes(status));
      return true;
    });
  }
});
