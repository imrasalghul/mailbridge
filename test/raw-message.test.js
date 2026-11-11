const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createInboundMessageDecryptor, encryptPayloadWithPublicKey } = require('../lib/inbound-message-crypto');
const { applySpamSubjectTag, containsGtube, prependHeadersToRaw } = require('../lib/spam-pipeline');
const { createSpamAssassinClient } = require('../lib/spamassassin-client');
const { rawToText, splitHeaderBlock } = require('../lib/raw-message');

// 8bit body in ISO-8859-9 (Turkish): 0xFC, 0xFD and 0xFE aren't valid UTF-8 on their own.
const HEADER = 'From: a@example.com\r\nSubject: Merhaba\r\nContent-Type: text/plain; charset=iso-8859-9\r\n'
  + 'Content-Transfer-Encoding: 8bit';
const BODY = Buffer.from([0x47, 0xfc, 0x6e, 0x61, 0x79, 0x64, 0xfd, 0x6e, 0x0a, 0xfe, 0x65, 0x6b, 0x65, 0x72, 0x0a]);
const MESSAGE = Buffer.concat([Buffer.from(`${HEADER}\r\n\r\n`, 'latin1'), BODY]);

function bodyOf(buffer) {
  return splitHeaderBlock(buffer).body;
}

test('headers are added to a Buffer message without touching the body bytes or line endings', () => {
  const result = prependHeadersToRaw(MESSAGE, 'X-Mailbridge-Reason: not_spam\r\n');
  assert.ok(Buffer.isBuffer(result));
  assert.equal(splitHeaderBlock(result).header, `X-Mailbridge-Reason: not_spam\r\n${HEADER}`);
  assert.equal(Buffer.compare(bodyOf(result), BODY), 0);
});

test('LF-only headers are normalized to CRLF; the body after the first empty line is left alone', () => {
  const lfMessage = Buffer.concat([Buffer.from('Subject: x\nFrom: a@example.com\n\n', 'latin1'), BODY]);
  const result = prependHeadersToRaw(lfMessage, 'X-Test: 1\r\n');
  assert.equal(splitHeaderBlock(result).header, 'X-Test: 1\r\nSubject: x\r\nFrom: a@example.com');
  assert.equal(Buffer.compare(bodyOf(result), BODY), 0);
});

test('the spam subject tag changes only the Subject header of a Buffer message', () => {
  const tagged = applySpamSubjectTag(MESSAGE, true, '[SPAM]');
  assert.match(splitHeaderBlock(tagged).header, /^Subject: \[SPAM\] Merhaba$/m);
  assert.equal(Buffer.compare(bodyOf(tagged), BODY), 0);
  assert.equal(applySpamSubjectTag(tagged, true, '[SPAM]').toString('latin1'), tagged.toString('latin1'));
  assert.equal(applySpamSubjectTag(MESSAGE, false, '[SPAM]'), MESSAGE);
  const noSubject = Buffer.concat([Buffer.from('From: a@example.com\r\n\r\n', 'latin1'), BODY]);
  assert.match(splitHeaderBlock(applySpamSubjectTag(noSubject, true, '[SPAM]')).header, /\r\nSubject: \[SPAM\]$/);
  const utf8Tag = applySpamSubjectTag(MESSAGE, true, '[İSTENMEYEN]');
  assert.match(rawToText(utf8Tag), /^Subject: \[İSTENMEYEN\] Merhaba/m);
});

test('string messages from older Workers keep the earlier behavior', () => {
  assert.equal(prependHeadersToRaw('A: 1\nB: 2\n\nbody\nline', 'X: y\r\n'), 'X: y\r\nA: 1\r\nB: 2\r\n\r\nbody\r\nline');
  assert.equal(applySpamSubjectTag('Subject: hi\r\n\r\nbody', true, '[SPAM]'), 'Subject: [SPAM] hi\r\n\r\nbody');
});

test('GTUBE is found in Buffer messages too', () => {
  const gtube = Buffer.concat([MESSAGE, Buffer.from('XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X')]);
  assert.equal(containsGtube(gtube), true);
  assert.equal(containsGtube(MESSAGE), false);
});

test('rawBase64 payloads decrypt to the exact bytes; raw text payloads still work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-raw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = path.join(dir, 'private.pem');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const decryptor = createInboundMessageDecryptor({ privateKeyPath });

  const bytes = await encryptPayloadWithPublicKey({ publicKeyPem, payload: {
    from: 'a@example.com', to: 'b@example.org', rawBase64: MESSAGE.toString('base64') } });
  const fromBytes = decryptor.decryptPayload(bytes);
  assert.ok(Buffer.isBuffer(fromBytes.raw));
  assert.equal(Buffer.compare(fromBytes.raw, MESSAGE), 0);
  assert.equal('rawBase64' in fromBytes, false);

  const text = await encryptPayloadWithPublicKey({ publicKeyPem, payload: {
    from: 'a@example.com', to: 'b@example.org', raw: 'Subject: hi\r\n\r\nbody' } });
  assert.equal(decryptor.decryptPayload(text).raw, 'Subject: hi\r\n\r\nbody');

  const empty = await encryptPayloadWithPublicKey({ publicKeyPem, payload: {
    from: 'a@example.com', to: 'b@example.org', rawBase64: '' } });
  assert.throws(() => decryptor.decryptPayload(empty), /missing required mail fields/);
});

test('SpamAssassin receives the message bytes exactly, with a matching Content-length', async t => {
  const received = [];
  const server = net.createServer(socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      received.push(Buffer.concat(chunks));
      socket.end('SPAMD/1.5 0 EX_OK\r\nSpam: False ; 1.0 / 5.0\r\n\r\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = createSpamAssassinClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 5000 });

  const result = await client.checkMessage(MESSAGE, 'bytes');
  assert.equal(result.score, 1);
  const request = received[0];
  const separator = request.indexOf('\r\n\r\n');
  assert.equal(request.subarray(0, separator).toString('latin1'), `CHECK SPAMC/1.5\r\nContent-length: ${MESSAGE.length}`);
  assert.equal(Buffer.compare(request.subarray(separator + 4), MESSAGE), 0);

  await client.checkMessage('Subject: hé\r\n\r\nbody', 'text');
  assert.equal(received[1].toString('utf8'), `CHECK SPAMC/1.5\r\nContent-length: ${Buffer.byteLength('Subject: hé\r\n\r\nbody')}\r\n\r\nSubject: hé\r\n\r\nbody`);
});
