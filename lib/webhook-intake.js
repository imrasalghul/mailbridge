// Copyright (c) 2026 Ra's al Ghul

const { isEncryptedPayload } = require('./inbound-message-crypto');

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/i, '').trim();
}

function getWebhookRequestIp(req) {
  const headerIp = req.headers['cf-connecting-ip']
    || req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim()
    || req.ip;
  return normalizeIp(headerIp);
}

function getMessageSourceIp(req) {
  const messageIp = req.body?.senderIp
    || req.body?.sourceIp;
  return normalizeIp(messageIp);
}

function validateWebhookRequest(req, webhookSecret) {
  if (!webhookSecret) {
    return { ok: false, statusCode: 500, error: 'Server misconfiguration' };
  }

  if (req.headers['x-webhook-secret'] !== webhookSecret) {
    return { ok: false, statusCode: 403, error: 'Invalid Secret' };
  }

  const encryptedPayload = req.body?.encryptedPayload;
  if (isEncryptedPayload(encryptedPayload)) {
    return {
      ok: true,
      payload: { encryptedPayload },
      messageSourceIp: null,
      requestIp: getWebhookRequestIp(req)
    };
  }

  const { from, to, raw } = req.body || {};
  if (!from || !to || !raw) {
    return { ok: false, statusCode: 400, error: 'Missing payload' };
  }

  return {
    ok: true,
    payload: { from, to, raw },
    messageSourceIp: getMessageSourceIp(req),
    requestIp: getWebhookRequestIp(req)
  };
}

module.exports = {
  getMessageSourceIp,
  getWebhookRequestIp,
  normalizeIp,
  validateWebhookRequest
};
