// Copyright (c) 2026 Ra's al Ghul

const net = require('net');
const fs = require('fs');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseAllowedCidrs(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRemoteAddress(address) {
  return String(address || '').replace(/^::ffff:/i, '').trim();
}

function readOptionalPem(filePath, fsImpl = fs) {
  if (!filePath) return undefined;
  return fsImpl.readFileSync(filePath, 'utf8');
}

function createRelayPolicyError(message, responseCode = 550) {
  const error = new Error(message);
  error.responseCode = responseCode;
  return error;
}

function addCidrToBlockList(blockList, cidr) {
  if (cidr.includes('/')) {
    const [address, prefixLengthValue] = cidr.split('/');
    const normalizedAddress = normalizeRemoteAddress(address);
    const family = net.isIP(normalizedAddress);
    const prefixLength = Number.parseInt(prefixLengthValue, 10);

    if (!family || Number.isNaN(prefixLength)) {
      throw new Error(`Invalid SMTP relay CIDR: ${cidr}`);
    }

    blockList.addSubnet(normalizedAddress, prefixLength, family === 6 ? 'ipv6' : 'ipv4');
    return;
  }

  const normalizedAddress = normalizeRemoteAddress(cidr);
  const family = net.isIP(normalizedAddress);
  if (!family) {
    throw new Error(`Invalid SMTP relay address: ${cidr}`);
  }

  blockList.addAddress(normalizedAddress, family === 6 ? 'ipv6' : 'ipv4');
}

function buildSmtpRelayPolicy({ env = process.env, fsImpl = fs } = {}) {
  const requireTls = parseBoolean(env.SMTP_RELAY_REQUIRE_TLS, true);
  const allowInsecure = parseBoolean(env.SMTP_RELAY_ALLOW_INSECURE, false);
  const allowedCidrs = parseAllowedCidrs(env.SMTP_RELAY_ALLOWED_CIDRS || '127.0.0.1/32,::1/128');
  const cert = readOptionalPem(env.SMTP_RELAY_TLS_CERT_FILE, fsImpl);
  const key = readOptionalPem(env.SMTP_RELAY_TLS_KEY_FILE, fsImpl);
  const ca = readOptionalPem(env.SMTP_RELAY_TLS_CA_FILE, fsImpl);
  const tlsEnabled = Boolean(cert && key);
  const blockList = new net.BlockList();

  for (const cidr of allowedCidrs) {
    addCidrToBlockList(blockList, cidr);
  }

  if (requireTls && !allowInsecure && !tlsEnabled) {
    throw new Error('SMTP relay TLS is required but SMTP_RELAY_TLS_CERT_FILE and SMTP_RELAY_TLS_KEY_FILE are not configured');
  }

  const tlsOptions = tlsEnabled
    ? {
        cert,
        key,
        ...(ca ? { ca } : {})
      }
    : null;

  return {
    requireTls,
    allowInsecure,
    allowedCidrs,
    tlsEnabled,
    tlsOptions,
    isRemoteAllowed(remoteAddress) {
      const normalizedAddress = normalizeRemoteAddress(remoteAddress);
      const family = net.isIP(normalizedAddress);
      if (!family) return false;
      return blockList.check(normalizedAddress, family === 6 ? 'ipv6' : 'ipv4');
    },
    assertRemoteAllowed(remoteAddress) {
      const normalizedAddress = normalizeRemoteAddress(remoteAddress) || 'unknown';
      if (this.isRemoteAllowed(normalizedAddress)) return;
      throw createRelayPolicyError(`SMTP relay connection from ${normalizedAddress} is not allowed`, 554);
    },
    assertSecureSession(session) {
      if (!requireTls || allowInsecure || session?.secure) return;
      throw createRelayPolicyError('SMTP relay requires STARTTLS before message submission', 530);
    }
  };
}

module.exports = {
  buildSmtpRelayPolicy,
  createRelayPolicyError,
  normalizeRemoteAddress,
  parseAllowedCidrs
};
