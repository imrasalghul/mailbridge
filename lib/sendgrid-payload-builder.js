// Copyright (c) 2026 Ra's al Ghul

const { simpleParser } = require('mailparser');

function toRawBuffer(rawInput) {
  if (typeof rawInput === 'string' && rawInput.startsWith('b64:')) {
    return Buffer.from(rawInput.slice(4), 'base64');
  }
  if (Buffer.isBuffer(rawInput)) return rawInput;
  return Buffer.from(String(rawInput || ''));
}

async function buildSendGridPayload({ from, to, rawInput, injectHeaders, relayHostname, sendgridFromFallback }) {
  const raw = toRawBuffer(rawInput);
  const parsed = await simpleParser(raw);
  const personalizations = to.map((recipient) => ({ to: [{ email: recipient }] }));

  const payload = {
    personalizations,
    from: {
      email: parsed.from?.value?.[0]?.address || from || sendgridFromFallback || 'postmaster@localhost'
    },
    subject: parsed.subject || '(no subject)',
    content: []
  };

  const sendGridHeaders = {};
  if (injectHeaders) {
    sendGridHeaders['X-Mailbridge-Relay'] = 'smtp-to-sendgrid';
    sendGridHeaders['X-Mailbridge-Timestamp'] = new Date().toISOString();
    sendGridHeaders['X-Mailbridge-Received-Hop'] = `by ${relayHostname} with smtp-to-sendgrid`;
  }

  for (const [headerName, headerValue] of parsed.headers || []) {
    if (!headerName?.toLowerCase()?.startsWith('x-')) continue;
    if (typeof headerValue === 'string' && headerValue.trim()) {
      sendGridHeaders[headerName] = headerValue.trim().slice(0, 998);
    }
  }

  if (Object.keys(sendGridHeaders).length) {
    payload.headers = sendGridHeaders;
  }

  if (parsed.text) payload.content.push({ type: 'text/plain', value: parsed.text });
  if (parsed.html) payload.content.push({ type: 'text/html', value: parsed.html });
  if (!payload.content.length) payload.content.push({ type: 'text/plain', value: '(empty message)' });

  const attachments = [];
  for (const attachment of parsed.attachments || []) {
    attachments.push({
      content: attachment.content.toString('base64'),
      filename: attachment.filename || 'attachment.bin',
      type: attachment.contentType || 'application/octet-stream',
      disposition: attachment.contentDisposition || 'attachment'
    });
  }
  if (attachments.length) {
    payload.attachments = attachments;
  }

  return payload;
}

module.exports = {
  buildSendGridPayload,
  toRawBuffer
};
