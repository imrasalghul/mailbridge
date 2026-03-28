// Copyright (c) 2026 Ra's al Ghul

const { prependHeadersToRaw } = require('./spam-pipeline');
const { toRawBuffer } = require('./email-metadata');

function ensureMimeHeaders(rawInput, { from, injectHeaders, relayHostname }) {
  const raw = toRawBuffer(rawInput).toString('utf8').replace(/\r?\n/g, '\r\n');
  let injectedHeaders = '';

  if (!/^From:/mi.test(raw) && from) {
    injectedHeaders += `From: ${from}\r\n`;
  }

  if (injectHeaders) {
    injectedHeaders += `X-Mailbridge-Relay: smtp-to-mailgun\r\n`;
    injectedHeaders += `X-Mailbridge-Timestamp: ${new Date().toISOString()}\r\n`;
    injectedHeaders += `X-Mailbridge-Received-Hop: by ${relayHostname} with smtp-to-mailgun\r\n`;
  }

  if (!injectedHeaders) {
    return Buffer.from(raw, 'utf8');
  }

  return Buffer.from(prependHeadersToRaw(raw, injectedHeaders), 'utf8');
}

function createMailgunDelivery({
  apiKey,
  domain,
  baseUrl = 'https://api.mailgun.net',
  injectHeaders,
  relayHostname,
  fromFallback,
  timeoutMs = 15000,
  fetchImpl = fetch,
  log = () => {}
}) {
  return async function sendViaMailgun(from, to, rawInput) {
    if (!apiKey) {
      const error = new Error('RELAY_API_KEY is not configured for Mailgun');
      error.permanent = true;
      throw error;
    }
    if (!domain) {
      const error = new Error('MAILGUN_DOMAIN is not configured');
      error.permanent = true;
      throw error;
    }

    const resolvedFrom = from || fromFallback || 'postmaster@localhost';
    const messageBuffer = ensureMimeHeaders(rawInput, {
      from: resolvedFrom,
      injectHeaders,
      relayHostname
    });

    const form = new FormData();
    for (const recipient of to) {
      form.append('to', recipient);
    }
    form.append('message', new Blob([messageBuffer], { type: 'message/rfc822' }), 'message.eml');

    log('[Mailgun]', 'Prepared outbound MIME payload', {
      from: resolvedFrom,
      to,
      rawSizeBytes: messageBuffer.length
    });

    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v3/${encodeURIComponent(domain)}/messages.mime`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const mailgunError = new Error(`Mailgun API error (timeout): ${error.message}`);
      mailgunError.statusCode = null;
      mailgunError.permanent = false;
      throw mailgunError;
    }

    let responseData = null;
    try {
      responseData = await response.json();
    } catch {
      responseData = null;
    }

    if (!response.ok) {
      const responseMessage = responseData?.message || `HTTP ${response.status}`;
      log('[Mailgun]', 'API request failed', {
        status: response.status,
        error: responseMessage
      });
      const mailgunError = new Error(`Mailgun API error (${response.status}): ${responseMessage}`);
      mailgunError.statusCode = response.status;
      mailgunError.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw mailgunError;
    }

    log('[Mailgun]', 'API request accepted', {
      status: response.status,
      messageId: responseData?.id || null
    });

    return {
      status: response.status,
      messageId: responseData?.id || null
    };
  };
}

module.exports = {
  createMailgunDelivery,
  ensureMimeHeaders
};
