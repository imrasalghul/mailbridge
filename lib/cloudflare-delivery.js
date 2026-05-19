// Copyright (c) 2026 Ra's al Ghul

const axios = require('axios');

const { buildOutboundMessage } = require('./outbound-message-builder');

function createCloudflareDelivery({
  workerUrl,
  webhookSecret,
  injectHeaders,
  relayHostname,
  fromFallback,
  timeoutMs = 15000,
  httpClient = axios,
  log = () => {}
}) {
  return async function sendViaCloudflare(from, to, rawInput) {
    if (!workerUrl) {
      const error = new Error('CLOUDFLARE_SEND_WORKER_URL is not configured for Cloudflare Email Service');
      error.permanent = true;
      throw error;
    }
    if (!webhookSecret) {
      const error = new Error('CLOUDFLARE_SEND_WEBHOOK_SECRET or WEBHOOK_SECRET is not configured for Cloudflare Email Service');
      error.permanent = true;
      throw error;
    }

    const message = await buildOutboundMessage({
      from,
      to,
      rawInput,
      injectHeaders,
      relayHostname,
      relayProvider: 'cloudflare',
      fromFallback
    });

    const payload = {
      to,
      from: message.from,
      subject: message.subject
    };

    if (message.html) payload.html = message.html;
    if (message.text || !message.html) payload.text = message.text || '(empty message)';
    if (Object.keys(message.headers || {}).length) payload.headers = message.headers;
    if (message.attachments.length) {
      payload.attachments = message.attachments.map((attachment) => ({
        content: attachment.content.toString('base64'),
        filename: attachment.filename,
        type: attachment.type,
        disposition: attachment.disposition || 'attachment',
        contentId: attachment.contentId || undefined
      }));
    }

    log('[Cloudflare]', 'Prepared Worker Email Service payload', {
      from: payload.from,
      to,
      hasHtml: Boolean(payload.html),
      hasText: Boolean(payload.text),
      attachmentCount: payload.attachments?.length || 0,
      customHeaderCount: Object.keys(payload.headers || {}).length
    });

    try {
      const response = await httpClient.post(workerUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': webhookSecret
        },
        timeout: timeoutMs
      });

      log('[Cloudflare]', 'Worker Email Service request accepted', {
        status: response.status,
        messageId: response.data?.messageId || null
      });

      return {
        status: response.status,
        messageId: response.data?.messageId || null
      };
    } catch (error) {
      const status = error.response?.status;
      const responseMessage = error.response?.data?.error || error.response?.data?.message || error.message;
      log('[Cloudflare]', 'Worker Email Service request failed', {
        status: status || 'timeout',
        error: responseMessage
      });
      const cloudflareError = new Error('Cloudflare Email Service Worker error (' + (status || 'timeout') + '): ' + responseMessage);
      cloudflareError.statusCode = status;
      cloudflareError.permanent = status >= 400 && status < 500 && status !== 429;
      throw cloudflareError;
    }
  };
}

module.exports = {
  createCloudflareDelivery
};
