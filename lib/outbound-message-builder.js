// Copyright (c) 2026 Ra's al Ghul

const { simpleParser } = require('mailparser');

const { toRawBuffer } = require('./email-metadata');

async function buildOutboundMessage({
  from,
  to,
  rawInput,
  injectHeaders,
  relayHostname,
  relayProvider,
  fromFallback
}) {
  const raw = toRawBuffer(rawInput);
  const parsed = await simpleParser(raw);
  const providerLabel = String(relayProvider || 'sendgrid').trim().toLowerCase();
  const resolvedFrom = parsed.from?.value?.[0]?.address || from || fromFallback || 'postmaster@localhost';
  const headers = {};

  if (injectHeaders) {
    headers['X-Mailbridge-Relay'] = `smtp-to-${providerLabel}`;
    headers['X-Mailbridge-Timestamp'] = new Date().toISOString();
    headers['X-Mailbridge-Received-Hop'] = `by ${relayHostname} with smtp-to-${providerLabel}`;
  }

  for (const [headerName, headerValue] of parsed.headers || []) {
    if (!headerName?.toLowerCase()?.startsWith('x-')) continue;
    if (typeof headerValue === 'string' && headerValue.trim()) {
      headers[headerName] = headerValue.trim().slice(0, 998);
    }
  }

  const attachments = [];
  for (const attachment of parsed.attachments || []) {
    attachments.push({
      content: attachment.content,
      filename: attachment.filename || 'attachment.bin',
      type: attachment.contentType || 'application/octet-stream',
      disposition: attachment.contentDisposition || 'attachment',
      contentId: attachment.cid || null
    });
  }

  return {
    from: resolvedFrom,
    to,
    subject: parsed.subject || '(no subject)',
    text: parsed.text || '',
    html: parsed.html || '',
    headers,
    attachments,
    raw
  };
}

module.exports = {
  buildOutboundMessage
};
