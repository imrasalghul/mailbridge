const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSenderDomain,
  extractAttachmentNames
} = require('../lib/email-metadata');

test('deriveSenderDomain normalizes to the registrable domain', async () => {
  const domain = await deriveSenderDomain({
    envelopeFrom: 'alerts@www.example.co.uk',
    rawEmail: 'From: alerts@www.example.co.uk\r\n\r\nbody',
    tlds: ['co.uk', 'com']
  });

  assert.equal(domain, 'example.co.uk');
});

test('extractAttachmentNames returns filenames without decoding attachment bodies into the prompt path', async () => {
  const rawEmail = [
    'From: sender@example.com',
    'To: dest@example.com',
    'Subject: Testing',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="boundary42"',
    '',
    '--boundary42',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'hello world',
    '--boundary42',
    'Content-Type: application/pdf; name="Invoice.pdf"',
    'Content-Disposition: attachment; filename="Invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--boundary42--',
    ''
  ].join('\r\n');

  const attachmentNames = await extractAttachmentNames(rawEmail);
  assert.deepEqual(attachmentNames, ['Invoice.pdf']);
});
