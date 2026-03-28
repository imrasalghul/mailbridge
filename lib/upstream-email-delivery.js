// Copyright (c) 2026 Ra's al Ghul

const {
  assertSupportedUpstreamProvider,
  normalizeUpstreamProvider
} = require('./upstream-provider');

function createUpstreamEmailDelivery({
  defaultProvider = 'sendgrid',
  sendgridDelivery,
  resendDelivery,
  mailgunDelivery
}) {
  const resolvedDefaultProvider = assertSupportedUpstreamProvider(defaultProvider);

  return async function sendViaUpstream({ provider = resolvedDefaultProvider, from, to, rawInput }) {
    const resolvedProvider = assertSupportedUpstreamProvider(normalizeUpstreamProvider(provider, resolvedDefaultProvider));

    switch (resolvedProvider) {
      case 'sendgrid':
        return sendgridDelivery(from, to, rawInput);
      case 'resend':
        return resendDelivery(from, to, rawInput);
      case 'mailgun':
        return mailgunDelivery(from, to, rawInput);
      default:
        throw new Error(`Unsupported RELAY_UPSTREAM_PROVIDER: ${resolvedProvider}`);
    }
  };
}

module.exports = {
  createUpstreamEmailDelivery
};
