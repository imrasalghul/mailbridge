const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  createSpamAssassinClient,
  parseSpamAssassinCheckResponse,
  normalizeScore
} = require('../lib/spamassassin-client');

test('spamassassin client constructs spamc with positional host port and timeout', async () => {
  const calls = [];

  function SpamcStub(host, port, timeoutSeconds) {
    calls.push({ host, port, timeoutSeconds });
    this.check = (raw, callback) => callback(null, { spamScore: '6.5' });
  }

  const client = createSpamAssassinClient({
    host: '127.0.0.1',
    port: 783,
    timeoutMs: 10000,
    spamcImpl: SpamcStub,
  });

  const result = await client.checkMessage('Subject: hi\r\n\r\nbody', 'req1');

  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 783, timeoutSeconds: 10 }]);
  assert.equal(result.score, 6.5);
});

test('spamassassin client still accepts test stubs returning score', async () => {
  function SpamcStub() {
    this.check = (raw, callback) => callback(null, { score: '1.2' });
  }

  const client = createSpamAssassinClient({
    host: '127.0.0.1',
    port: 783,
    timeoutMs: 10000,
    spamcImpl: SpamcStub,
  });

  const result = await client.checkMessage('Subject: hi\r\n\r\nbody', 'req2');

  assert.equal(result.score, 1.2);
});

test('spamassassin response parser accepts negative ham scores', () => {
  const result = parseSpamAssassinCheckResponse([
    'SPAMD/1.5 0 EX_OK',
    'Spam: False ; -0.1 / 5.0'
  ]);

  assert.equal(result.score, -0.1);
  assert.equal(result.spamScore, -0.1);
  assert.equal(result.baseSpamScore, 5);
  assert.equal(result.isSpam, false);
});

test('spamassassin response parser follows CHECK protocol and accepts signed real scores', () => {
  const result = parseSpamAssassinCheckResponse([
    'SPAMD/1.5 0 EX_OK',
    'Content-length: 0',
    'Spam: Yes ; +15.25 / 5.0',
    'X-Extra: ignored'
  ]);

  assert.equal(result.score, 15.25);
  assert.equal(result.isSpam, true);
  assert.equal(result.responseMessage, 'EX_OK');
});

test('spamassassin response parser rejects non-zero spamd status codes', () => {
  assert.throws(
    () => parseSpamAssassinCheckResponse(['SPAMD/1.5 65 EX_DATAERR']),
    /SpamAssassin returned 65 EX_DATAERR/
  );
});

test('spamassassin client parses signed scores from spamd CHECK responses', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.end('SPAMD/1.5 0 EX_OK\r\nSpam: False ; -0.4 / 5.0\r\n\r\n');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const client = createSpamAssassinClient({
      host: '127.0.0.1',
      port: server.address().port,
      timeoutMs: 10000
    });

    const result = await client.checkMessage('Subject: hi\r\n\r\nbody', 'req3');

    assert.equal(result.score, -0.4);
    assert.equal(result.isSpam, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('spamassassin client can use Postmark SpamCheck mode', async () => {
  const calls = [];
  const axiosImpl = {
    async post(url, body, options) {
      calls.push({ url, body, options });
      return {
        status: 200,
        data: {
          success: true,
          score: '-0.2',
          rules: []
        }
      };
    }
  };

  const client = createSpamAssassinClient({
    host: '127.0.0.1',
    port: 783,
    timeoutMs: 1234,
    mode: 'postmark',
    postmarkUrl: 'https://spamcheck.example.test/filter',
    axiosImpl
  });

  const result = await client.checkMessage('Subject: hi\r\n\r\nbody', 'req4');

  assert.equal(result.score, -0.2);
  assert.equal(result.backend, 'postmark');
  assert.equal(calls[0].url, 'https://spamcheck.example.test/filter');
  assert.deepEqual(calls[0].body, {
    email: 'Subject: hi\r\n\r\nbody',
    options: 'short'
  });
  assert.equal(calls[0].options.timeout, 1234);
});

test('spamassassin client surfaces Postmark SpamCheck application errors', async () => {
  const client = createSpamAssassinClient({
    host: '127.0.0.1',
    port: 783,
    timeoutMs: 10000,
    mode: 'postmark',
    axiosImpl: {
      async post() {
        return {
          status: 200,
          data: { success: false, message: 'bad email' }
        };
      }
    }
  });

  await assert.rejects(
    () => client.checkMessage('bad', 'req5'),
    /Postmark SpamCheck error: bad email/
  );
});

test('normalizeScore rejects absent and non-numeric scores', () => {
  assert.throws(() => normalizeScore(undefined), /invalid score/);
  assert.throws(() => normalizeScore('nope'), /invalid score/);
});
