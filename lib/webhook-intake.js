// Copyright (c) 2026 Ra's al Ghul

function getClientIp(req) {
  const headerIp = req.headers['cf-connecting-ip']
    || req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim()
    || req.body?.senderIp
    || req.body?.sourceIp
    || req.body?.ip;
  const normalized = (headerIp || req.ip || '').replace(/^::ffff:/, '');
  return normalized;
}

function validateWebhookRequest(req, webhookSecret) {
  if (!webhookSecret) {
    return { ok: false, statusCode: 500, error: 'Server misconfiguration' };
  }

  if (req.headers['x-webhook-secret'] !== webhookSecret) {
    return { ok: false, statusCode: 403, error: 'Invalid Secret' };
  }

  const { from, to, raw } = req.body || {};
  if (!from || !to || !raw) {
    return { ok: false, statusCode: 400, error: 'Missing payload' };
  }

  return {
    ok: true,
    payload: { from, to, raw },
    sourceIp: getClientIp(req)
  };
}

module.exports = {
  getClientIp,
  validateWebhookRequest
};
