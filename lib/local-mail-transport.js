// Copyright (c) 2026 Ra's al Ghul

const fs = require('fs');
const nodemailer = require('nodemailer');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readOptionalPem(filePath, fsImpl = fs) {
  if (!filePath) return undefined;
  return fsImpl.readFileSync(filePath, 'utf8');
}

function buildLocalMailTransportConfig({ env = process.env, fsImpl = fs } = {}) {
  const host = env.LOCAL_MAIL_HOST || '127.0.0.1';
  const port = Number.parseInt(env.LOCAL_MAIL_PORT || '25', 10);
  const secure = parseBoolean(env.LOCAL_MAIL_SECURE, false);
  const requireTLS = parseBoolean(env.LOCAL_MAIL_REQUIRE_TLS, true);
  const rejectUnauthorized = parseBoolean(env.LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED, true);
  const servername = env.LOCAL_MAIL_TLS_SERVERNAME || host;
  const ca = readOptionalPem(env.LOCAL_MAIL_TLS_CA_FILE, fsImpl);

  const tls = { rejectUnauthorized };
  if (servername) tls.servername = servername;
  if (ca) tls.ca = ca;

  return {
    pool: true,
    maxConnections: 10,
    host,
    port,
    secure,
    requireTLS,
    tls,
    connectionTimeout: 5000,
    greetingTimeout: 5000
  };
}

function createLocalMailTransport({ env = process.env, fsImpl = fs, nodemailerImpl = nodemailer } = {}) {
  return nodemailerImpl.createTransport(buildLocalMailTransportConfig({ env, fsImpl }));
}

module.exports = {
  buildLocalMailTransportConfig,
  createLocalMailTransport,
  parseBoolean,
  readOptionalPem
};
