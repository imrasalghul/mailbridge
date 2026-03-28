const test = require('node:test');
const assert = require('node:assert/strict');

const { createSpamhausClient } = require('../lib/spamhaus-client');

function createHttpClient({ postHandlers = [], getHandlers = [] }) {
  const calls = [];

  return {
    calls,
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      const handler = postHandlers.shift();
      if (!handler) throw new Error(`Unexpected POST ${url}`);
      return handler(url, body);
    },
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      const handler = getHandlers.shift();
      if (!handler) throw new Error(`Unexpected GET ${url}`);
      return handler(url, options);
    }
  };
}

test('spamhaus client skips lookups when disabled', async () => {
  const httpClient = createHttpClient({});
  const client = createSpamhausClient({
    env: {
      SPAMHAUS_ENABLED: 'false'
    },
    httpClient
  });

  const result = await client.checkMessage({
    senderIp: '203.0.113.7',
    envelopeFrom: 'sender@example.com',
    rawEmail: 'From: sender@example.com\r\n\r\nbody',
    requestId: 'req1'
  });

  assert.deepEqual(result, {
    checked: false,
    blocked: false,
    reason: 'disabled'
  });
  assert.equal(httpClient.calls.length, 0);
});

test('spamhaus client caches auth tokens and TLD data and normalizes domains', async () => {
  const httpClient = createHttpClient({
    postHandlers: [
      async () => ({
        status: 200,
        data: {
          code: 200,
          token: 'token-1',
          expires: Math.floor(Date.now() / 1000) + 3600
        }
      })
    ],
    getHandlers: [
      async () => ({ status: 404, data: { code: 404 } }),
      async () => ({ status: 200, data: ['co.uk', 'com'] }),
      async (url) => {
        assert.equal(url, '/api/intel/v2/byobject/domain/example.co.uk/listing');
        return { status: 404, data: { code: 404 } };
      },
      async () => ({ status: 404, data: { code: 404 } }),
      async () => ({ status: 404, data: { code: 404 } })
    ]
  });

  const client = createSpamhausClient({
    env: {
      SPAMHAUS_ENABLED: 'true',
      SPAMHAUS_USERNAME: 'user@example.com',
      SPAMHAUS_PASSWORD: 'secret'
    },
    httpClient
  });

  await client.checkMessage({
    senderIp: '203.0.113.7',
    envelopeFrom: 'alerts@www.example.co.uk',
    rawEmail: 'From: alerts@www.example.co.uk\r\n\r\nbody',
    requestId: 'req1'
  });

  await client.checkMessage({
    senderIp: '203.0.113.8',
    envelopeFrom: 'alerts@www.example.co.uk',
    rawEmail: 'From: alerts@www.example.co.uk\r\n\r\nbody',
    requestId: 'req2'
  });

  assert.equal(httpClient.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(httpClient.calls.filter((call) => call.url === '/api/intel/v2/domains/tld').length, 1);
});

test('spamhaus client refreshes token once on 401 and retries the failed request', async () => {
  const httpClient = createHttpClient({
    postHandlers: [
      async () => ({ status: 200, data: { code: 200, token: 'token-1', expires: Math.floor(Date.now() / 1000) + 3600 } }),
      async () => ({ status: 200, data: { code: 200, token: 'token-2', expires: Math.floor(Date.now() / 1000) + 3600 } })
    ],
    getHandlers: [
      async () => ({ status: 401, data: { code: 401 } }),
      async () => ({ status: 404, data: { code: 404 } }),
      async () => ({ status: 200, data: ['com'] })
    ]
  });

  const client = createSpamhausClient({
    env: {
      SPAMHAUS_ENABLED: 'true',
      SPAMHAUS_USERNAME: 'user@example.com',
      SPAMHAUS_PASSWORD: 'secret'
    },
    httpClient
  });

  const result = await client.checkMessage({
    senderIp: '203.0.113.9',
    envelopeFrom: 'bounce',
    rawEmail: 'Subject: hi\r\n\r\nbody',
    requestId: 'req401'
  });

  assert.equal(result.blocked, false);
  assert.equal(httpClient.calls.filter((call) => call.method === 'POST').length, 2);
});

test('spamhaus client fails open on rate limits by default', async () => {
  const httpClient = createHttpClient({
    postHandlers: [
      async () => ({ status: 200, data: { code: 200, token: 'token-1', expires: Math.floor(Date.now() / 1000) + 3600 } })
    ],
    getHandlers: [
      async () => ({ status: 429, data: { code: 429 } }),
      async () => ({ status: 429, data: { code: 429 } })
    ]
  });

  const client = createSpamhausClient({
    env: {
      SPAMHAUS_ENABLED: 'true',
      SPAMHAUS_USERNAME: 'user@example.com',
      SPAMHAUS_PASSWORD: 'secret',
      SPAMHAUS_FAIL_OPEN: 'true'
    },
    httpClient
  });

  const result = await client.checkMessage({
    senderIp: '203.0.113.7',
    envelopeFrom: 'sender@example.com',
    rawEmail: 'From: sender@example.com\r\n\r\nbody',
    requestId: 'req429'
  });

  assert.equal(result.blocked, false);
  assert.equal(result.checked, false);
});

test('spamhaus client skips private IP lookups', async () => {
  const httpClient = createHttpClient({
    postHandlers: [
      async () => ({ status: 200, data: { code: 200, token: 'token-1', expires: Math.floor(Date.now() / 1000) + 3600 } })
    ],
    getHandlers: [
      async () => ({ status: 200, data: ['com'] }),
      async () => ({ status: 404, data: { code: 404 } })
    ]
  });

  const client = createSpamhausClient({
    env: {
      SPAMHAUS_ENABLED: 'true',
      SPAMHAUS_USERNAME: 'user@example.com',
      SPAMHAUS_PASSWORD: 'secret'
    },
    httpClient
  });

  await client.checkMessage({
    senderIp: '10.0.0.5',
    envelopeFrom: 'sender@example.com',
    rawEmail: 'From: sender@example.com\r\n\r\nbody',
    requestId: 'req-private'
  });

  assert.equal(httpClient.calls.some((call) => call.url.includes('/api/intel/v1/byobject/cidr/ALL/listed/live/10.0.0.5')), false);
});
