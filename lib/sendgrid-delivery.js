// Copyright (c) 2026 Ra's al Ghul

const axios = require('axios');

const { buildOutboundMessage } = require('./outbound-message-builder');

function createSendGridDelivery({
  apiKey,
  injectHeaders,
  relayHostname,
  fromFallback,
  timeoutMs = 15000,
  httpClient = axios,
  log = () => {}
}) {
  return async function sendViaSendGrid(from, to, rawInput) {
    if (!apiKey) {
      const error = new Error('RELAY_API_KEY is not configured for SendGrid');
      error.permanent = true;
      throw error;
    }

    const message = await buildOutboundMessage({
      from,
      to,
      rawInput,
      injectHeaders,
      relayHostname,
      relayProvider: 'sendgrid',
      fromFallback
    });

    const payload = {
      personalizations: to.map((recipient) => ({ to: [{ email: recipient }] })),
      from: {
        email: message.from
      },
      subject: message.subject,
      content: []
    };

    if (Object.keys(message.headers || {}).length) {
      payload.headers = message.headers;
    }

    if (message.text) payload.content.push({ type: 'text/plain', value: message.text });
    if (message.html) payload.content.push({ type: 'text/html', value: message.html });
    if (!payload.content.length) payload.content.push({ type: 'text/plain', value: '(empty message)' });

    if (message.attachments.length) {
      payload.attachments = message.attachments.map((attachment) => ({
        content: attachment.content.toString('base64'),
        filename: attachment.filename,
        type: attachment.type,
        disposition: attachment.disposition,
        content_id: attachment.contentId || undefined
      }));
    }

    log('[SendGrid]', 'Prepared outbound API payload', {
      from: payload.from.email,
      to,
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
