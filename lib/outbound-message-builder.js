// Copyright (c) 2026 Ra's al Ghul

const { simpleParser } = require('mailparser');

const { toRawBuffer } = require('./email-metadata');

function addresses(value) {
  return (value?.value || []).flatMap(entry => entry.group ? entry.group.map(member => member.address) : [entry.address]).filter(Boolean);
}

function splitRecipients(parsed, envelopeRecipients) {
  const remaining = new Map((Array.isArray(envelopeRecipients) ? envelopeRecipients : [envelopeRecipients])
    .filter(Boolean).map(address => [address.toLowerCase(), address]));
  const take = (header) => addresses(header).flatMap(address => {
    const key = address.toLowerCase();
    if (!remaining.has(key)) return [];
    const recipient = remaining.get(key);
    remaining.delete(key);
    return [recipient];
  });
  const to = take(parsed.to);
  const cc = take(parsed.cc);
  return { to, cc, bcc: [...remaining.values()] };
}

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
  const providerLabel = String(relayProvider || 'upstream').trim().toLowerCase();
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
  if (parsed.inReplyTo) headers['In-Reply-To'] = parsed.inReplyTo;
  if (parsed.references) headers.References = Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references;

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
    recipients: splitRecipients(parsed, to),
    replyTo: addresses(parsed.replyTo)[0],
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
