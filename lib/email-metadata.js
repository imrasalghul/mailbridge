// Copyright (c) 2026 Ra's al Ghul

const { domainToASCII } = require('url');
const { MailParser, simpleParser } = require('mailparser');

function toRawBuffer(rawInput) {
  if (Buffer.isBuffer(rawInput)) return rawInput;
  return Buffer.from(String(rawInput || ''));
}

function splitRawEmail(rawInput) {
  const normalizedRaw = toRawBuffer(rawInput).toString('utf8').replace(/\r?\n/g, '\r\n');
  const separatorIndex = normalizedRaw.indexOf('\r\n\r\n');
  if (separatorIndex === -1) {
    return {
      normalizedRaw,
      headerSection: normalizedRaw,
      bodySection: ''
    };
  }

  return {
    normalizedRaw,
    headerSection: normalizedRaw.slice(0, separatorIndex),
    bodySection: normalizedRaw.slice(separatorIndex + 4)
  };
}

function extractDomainFromAddress(addressLike) {
  if (!addressLike) return null;
  const value = String(addressLike).trim();
  const match = value.match(/<?([^<>\s]+@[^<>\s]+)>?/);
  if (!match) return null;
  const [, address] = match;
  const atIndex = address.lastIndexOf('@');
  if (atIndex < 1) return null;

  const rawDomain = address.slice(atIndex + 1).replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
  const asciiDomain = domainToASCII(rawDomain.toLowerCase());
  if (!asciiDomain || !asciiDomain.includes('.')) return null;
  return asciiDomain;
}

function toRegistrableDomain(domain, tlds) {
  if (!domain || !Array.isArray(tlds) || tlds.length === 0) return null;
  const asciiDomain = domainToASCII(String(domain).toLowerCase().replace(/\.+$/g, ''));
  if (!asciiDomain || !asciiDomain.includes('.')) return null;

  const matchingTld = tlds.find((candidate) => asciiDomain === candidate || asciiDomain.endsWith(`.${candidate}`));
  if (!matchingTld || asciiDomain === matchingTld) return null;

  const suffix = `.${matchingTld}`;
  const remainder = asciiDomain.slice(0, -suffix.length);
  const labels = remainder.split('.').filter(Boolean);
  if (labels.length === 0) return null;

  return `${labels[labels.length - 1]}.${matchingTld}`;
}

async function extractHeaderSenderAddress(rawInput) {
  const { headerSection } = splitRawEmail(rawInput);
  if (!headerSection) return null;
  const parsed = await simpleParser(`${headerSection}\r\n\r\n`);
  return parsed.from?.value?.[0]?.address || null;
}

async function deriveSenderDomain({ envelopeFrom, rawEmail, tlds }) {
  const envelopeDomain = extractDomainFromAddress(envelopeFrom);
  const normalizedEnvelopeDomain = toRegistrableDomain(envelopeDomain, tlds);
  if (normalizedEnvelopeDomain) return normalizedEnvelopeDomain;

  const headerSenderAddress = await extractHeaderSenderAddress(rawEmail);
  const headerDomain = extractDomainFromAddress(headerSenderAddress);
  return toRegistrableDomain(headerDomain, tlds);
}

async function extractAttachmentNames(rawInput) {
  return new Promise((resolve, reject) => {
    const attachmentNames = [];
    const parser = new MailParser();

    parser.on('data', (data) => {
      if (data.type !== 'attachment') return;
      attachmentNames.push(data.filename || '');
      if (typeof data.release === 'function') data.release();
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(attachmentNames));

    parser.end(toRawBuffer(rawInput));
  });
}

function sanitizeAttachmentNames(attachmentNames) {
  const seen = new Set();
  const result = [];

  for (const attachmentName of attachmentNames || []) {
    const normalized = String(attachmentName || '').trim().slice(0, 255);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 50) break;
  }

  return result;
}

module.exports = {
  deriveSenderDomain,
  extractAttachmentNames,
  extractDomainFromAddress,
  sanitizeAttachmentNames,
  splitRawEmail,
  toRawBuffer,
  toRegistrableDomain
};
