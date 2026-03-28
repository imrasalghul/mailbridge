// Copyright (c) 2026 Ra's al Ghul

const axios = require('axios');

const { buildOutboundMessage } = require('./outbound-message-builder');

function createResendDelivery({
  apiKey,
  baseUrl = 'https://api.resend.com',
  injectHeaders,
  relayHostname,
  fromFallback,
  timeoutMs = 15000,
  httpClient = axios,
  log = () => {}
}) {
  return async function sendViaResend(from, to, rawInput) {
    if (!apiKey) {
      const error = new Error('RELAY_API_KEY is not configured for Resend');
      error.permanent = true;
      throw error;
    }

    const message = await buildOutboundMessage({
      from,
      to,
      rawInput,
      injectHeaders,
      relayHostname,
      relayProvider: 'resend',
      fromFallback
    });

    const payload = {
      from: message.from,
      to,
      subject: message.subject
    };

    if (message.html) payload.html = message.html;
    if (message.text || !message.html) payload.text = message.text || '(empty message)';
    if (Object.keys(message.headers || {}).length) payload.headers = message.headers;
    if (message.attachments.length) {
      payload.attachments = message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content.toString('base64'),
        contentType: attachment.type,
        contentId: attachment.contentId || undefined
      }));
    }

    log('[Resend]', 'Prepared outbound API payload', {
      from: payload.from,
      to,
      contentTypes: [payload.text ? 'text/plain' : null, payload.html ? 'text/html' : null].filter(Boolean),
      attachmentCount: payload.attachments?.length || 0,
      customHeaderCount: Object.keys(payload.headers || {}).length
    });

    try {
      const response = await httpClient.post(`${baseUrl.replace(/\/$/, '')}/emails`, payload, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      });

      log('[Resend]', 'API request accepted', {
        status: response.status,
        messageId: response.data?.id || null
      });

      return {
        status: response.status,
        messageId: response.data?.id || null
      };
    } catch (error) {
      const status = error.response?.status;
      const responseMessage = error.response?.data?.message || error.response?.data?.error || error.message;
      log('[Resend]', 'API request failed', {
        status: status || 'timeout',
        error: responseMessage
      });
      const resendError = new Error(`Resend API error (${status || 'timeout'}): ${responseMessage}`);
      resendError.statusCode = status;
      resendError.permanent = status >= 400 && status < 500 && status !== 429;
      throw resendError;
    }
  };
}

module.exports = {
  createResendDelivery
};
