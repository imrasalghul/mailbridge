const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverInboundMessage } = require('../lib/inbound-delivery');

test('inbound acceptance survives a post-delivery audit failure', async () => {
  let queued = 0;
  const result = await deliverInboundMessage({
    from: '', to: 'dest@example.com', raw: 'Subject: DSN\r\n\r\nbody',
    transport: { async sendMail(message) { assert.equal(message.envelope.from, ''); } },
    queueManager: { async addToQueue() { queued++; } },
    auditStore: { async logEvent() { throw new Error('synthetic audit failure'); } }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(queued, 0);
});

test('permanent SMTP failures return a permanent HTTP mail rejection', async () => {
  const result = await deliverInboundMessage({
    from: 'sender@example.com', to: 'dest@example.com', raw: 'Subject: test\r\n\r\nbody',
    transport: { async sendMail() { throw Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }); } },
    queueManager: { async addToQueue() { assert.fail('Permanent failure must not queue'); } },
    auditStore: { async logEvent() {} }
  });
  assert.equal(result.statusCode, 422);
});

test('temporary SMTP failures are accepted only after durable queue storage', async () => {
  let queued = 0;
  const options = {
    from: '', to: 'dest@example.com', raw: 'Subject: DSN\r\n\r\nbody',
    transport: { async sendMail() { throw Object.assign(new Error('Try later'), { responseCode: 451 }); } },
    queueManager: { async addToQueue(from) { assert.equal(from, ''); queued++; } },
    auditStore: { async logEvent() {} }
  };
  assert.equal((await deliverInboundMessage(options)).statusCode, 202);
  assert.equal(queued, 1);
  options.queueManager.addToQueue = async () => { throw new Error('disk full'); };
  await assert.rejects(deliverInboundMessage(options), /disk full/);
});
