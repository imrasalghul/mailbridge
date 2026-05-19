const test = require('node:test');
const assert = require('node:assert/strict');

const { createSpamAssassinClient } = require('../lib/spamassassin-client');

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
