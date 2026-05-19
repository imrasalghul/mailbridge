import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { buildBridgeEndpointUrl } from '../worker.js';

test('worker accepts NODE_APP_URL as a bare origin and appends webhook path', () => {
  assert.equal(
    buildBridgeEndpointUrl('https://mailbridge.example.com'),
    'https://mailbridge.example.com/api/webhook/email'
  );
});

test('worker preserves an explicit webhook path in NODE_APP_URL', () => {
  assert.equal(
    buildBridgeEndpointUrl('https://mailbridge.example.com/custom/inbound'),
    'https://mailbridge.example.com/custom/inbound'
  );
});

test('worker fails clearly when NODE_APP_URL is missing', () => {
  assert.throws(() => buildBridgeEndpointUrl(''), /NODE_APP_URL is not configured/);
});

test('worker send endpoint calls Cloudflare Email Service binding', async () => {
  const sent = [];
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'secret',
    },
    body: JSON.stringify({
      to: ['dest@example.com'],
      from: 'sender@example.com',
      subject: 'Hi',
      text: 'Body',
    }),
  }), {
    WEBHOOK_SECRET: 'secret',
    EMAIL: {
      async send(payload) {
        sent.push(payload);
        return { messageId: 'cf-msg-1' };
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, messageId: 'cf-msg-1' });
  assert.deepEqual(sent, [{
    to: ['dest@example.com'],
    from: 'sender@example.com',
    subject: 'Hi',
    text: 'Body',
  }]);
});

test('worker send endpoint rejects invalid secret before sending', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/send/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'wrong',
    },
    body: JSON.stringify({
      to: 'dest@example.com',
      from: 'sender@example.com',
      subject: 'Hi',
      text: 'Body',
    }),
  }), {
    WEBHOOK_SECRET: 'secret',
    EMAIL: {
      async send() {
        throw new Error('should not send');
      },
    },
  });

  assert.equal(response.status, 403);
});
