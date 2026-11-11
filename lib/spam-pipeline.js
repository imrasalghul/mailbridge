// Copyright (c) 2026 Ra's al Ghul

const { joinHeaderBlock, splitHeaderBlock, textForLatin1Header } = require('./raw-message');

function containsGtube(rawEmailContent) {
  if (!rawEmailContent) return false;
  return rawEmailContent.includes('XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X')
    || rawEmailContent.includes('XJS*C4JDBQOVP6L3KBFR01.G5WUM8GPRP_45LPHDW863F_GW9E_2BAX_G.761D-103');
}

function prependHeadersToRaw(raw, injectedHeaders) {
  if (Buffer.isBuffer(raw)) {
    // Only the header block changes; the body keeps its exact bytes and line endings.
    const { header, body } = splitHeaderBlock(raw);
    return joinHeaderBlock(`${textForLatin1Header(injectedHeaders)}${header}`, body);
  }
  const normalizedRaw = String(raw || '');
  const normalized = normalizedRaw.replace(/\r?\n/g, '\r\n');
  const separator = '\r\n\r\n';
  const separatorIndex = normalized.indexOf(separator);

  if (separatorIndex === -1) {
    return `${injectedHeaders}${normalized}`;
  }

  const originalHeaders = normalized.slice(0, separatorIndex);
  const body = normalized.slice(separatorIndex + separator.length);
  return `${injectedHeaders}${originalHeaders}\r\n\r\n${body}`;
}

function applySpamSubjectTag(raw, isSpam, spamSubjectTag) {
  if (!isSpam || !spamSubjectTag) return raw;
  if (Buffer.isBuffer(raw)) {
    const { header, body } = splitHeaderBlock(raw);
    return joinHeaderBlock(tagSubjectHeader(header, textForLatin1Header(spamSubjectTag)), body);
  }
  const normalizedRaw = String(raw || '');
  const escapedTag = spamSubjectTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^Subject:\\s*${escapedTag}\\b`, 'mi').test(normalizedRaw)) {
    return normalizedRaw;
  }
  if (/^Subject:/mi.test(normalizedRaw)) {
    return normalizedRaw.replace(/^Subject:\s*(.*)$/mi, `Subject: ${spamSubjectTag} $1`);
  }

  const normalized = normalizedRaw.replace(/\r?\n/g, '\r\n');
  const separator = '\r\n\r\n';
  const separatorIndex = normalized.indexOf(separator);
  if (separatorIndex === -1) {
    return `Subject: ${spamSubjectTag}\r\n${normalized}`;
  }
  const headerSection = normalized.slice(0, separatorIndex);
  const bodySection = normalized.slice(separatorIndex + separator.length);
  return `${headerSection}\r\nSubject: ${spamSubjectTag}\r\n\r\n${bodySection}`;
}

// Subject tagging inside a header block only (Buffer messages).
function tagSubjectHeader(header, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^Subject:\\s*${escapedTag}(?=\\s|$)`, 'mi').test(header)) return header;
  if (/^Subject:/mi.test(header)) return header.replace(/^Subject:[ \t]*/mi, `Subject: ${tag} `);
  return `${header}\r\nSubject: ${tag}`;
}

function sanitizeHeaderReason(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('_');

  return normalized || fallback;
}

function buildInboundHeaders({
  mailbridgeHostname,
  sourceIp,
  spamSource,
  spamReason,
  mailbridgeReason,
  mailbridgeProbabilityScore,
  spamScore,
  finalSpamVerdict,
  spamSclScore,
  pluginConfirmedSpam,
  aiConfirmedSpam
}) {
  const timestamp = new Date().toUTCString();
  const sourceIpForHeader = sourceIp || 'unknown';
  const fromHost = sourceIp ? `[${sourceIpForHeader}]` : 'unknown';
  let headers = `Received: from ${fromHost}\r\n`
    + `        by ${mailbridgeHostname} with ESMTP (Node.js Bridge);\r\n`
    + `        ${timestamp}\r\n`;
  headers += `X-Mailbridge-Reason: ${sanitizeHeaderReason(mailbridgeReason, finalSpamVerdict ? 'spam' : 'not_spam')}\r\n`;
  if (typeof mailbridgeProbabilityScore === 'number') {
    headers += `X-Mailbridge-PS: ${mailbridgeProbabilityScore}\r\n`;
  }
  if (typeof spamScore === 'number') {
    headers += `X-Mailbridge-SpamAssassin-Score: ${spamScore}\r\n`;
  }

  if (finalSpamVerdict) {
    headers += `X-Spam-Flag: YES\r\nX-Spam-Status: Yes\r\nX-MS-Exchange-Organization-SCL: ${spamSclScore}\r\n`;
    headers += `X-Forefront-Antispam-Report: SCL:${spamSclScore};\r\n`;
    headers += `X-Microsoft-Antispam: BCL:9;PCL:8;SCL:${spamSclScore};\r\n`;
    headers += 'X-MS-Exchange-Organization-BypassSpamFiltering: 0\r\n';
    if (pluginConfirmedSpam || aiConfirmedSpam) headers += 'X-AI-Confirmed-Spam: YES\r\n';
  } else {
    headers += 'X-Spam-Flag: NO\r\nX-Spam-Status: No\r\nX-MS-Exchange-Organization-SCL: 1\r\n';
  }

  return headers;
}

module.exports = {
  containsGtube,
  prependHeadersToRaw,
  applySpamSubjectTag,
  buildInboundHeaders,
  sanitizeHeaderReason
};
