// Copyright (c) 2026 Ra's al Ghul

const axios = require('axios');

const { buildSendGridPayload } = require('./sendgrid-payload-builder');

function createSendGridDelivery({
  apiKey,
  injectHeaders,
  relayHostname,
  sendgridFromFallback,
  timeoutMs = 15000,
  httpClient = axios,
  log = () => {}
}) {
  return async function sendViaSendGrid(from, to, rawInput) {
    if (!apiKey) {
      const error = new Error('SENDGRID_API_KEY is not configured');
      error.permanent = true;
      throw error;
    }

    const payload = await buildSendGridPayload({
      from,
      to,
      rawInput,
      injectHeaders,
      relayHostname,
      sendgridFromFallback
    });

    log('[SendGrid]', 'Prepared outbound API payload', {
      from: payload.from.email,
      to,
      subject: payload.subject,
      contentTypes: payload.content.map((part) => part.type),
      attachmentCount: (payload.attachments || []).length,
      customHeaderCount: Object.keys(payload.headers || {}).length
    });

    try {
      const response = await httpClient.post('https://api.sendgrid.com/v3/mail/send', payload, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      });

      log('[SendGrid]', 'API request accepted', {
        status: response.status,
        messageId: response.headers?.['x-message-id'] || null
      });

      return {
        status: response.status,
        messageId: response.headers?.['x-message-id'] || null
      };
    } catch (error) {
      const status = error.response?.status;
      log('[SendGrid]', 'API request failed', {
        status: status || 'timeout',
        error: error.response?.data?.errors?.[0]?.message || error.message
      });
      const sendgridError = new Error(`SendGrid API error (${status || 'timeout'}): ${error.response?.data?.errors?.[0]?.message || error.message}`);
      sendgridError.statusCode = status;
      sendgridError.permanent = status >= 400 && status < 500 && status !== 429;
      throw sendgridError;
    }
  };
}

module.exports = {
  createSendGridDelivery
};
