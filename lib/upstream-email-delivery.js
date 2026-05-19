// Copyright (c) 2026 Ra's al Ghul

const {
  assertSupportedUpstreamProvider,
  DEFAULT_UPSTREAM_PROVIDER,
  normalizeUpstreamProvider
} = require('./upstream-provider');

function createUpstreamEmailDelivery({
  defaultProvider = DEFAULT_UPSTREAM_PROVIDER,
  resendDelivery,
  cloudflareDelivery
}) {
  const resolvedDefaultProvider = assertSupportedUpstreamProvider(defaultProvider);

  return async function sendViaUpstream({ provider = resolvedDefaultProvider, from, to, rawInput }) {
    const resolvedProvider = assertSupportedUpstreamProvider(normalizeUpstreamProvider(provider, resolvedDefaultProvider));

    switch (resolvedProvider) {
      case 'cloudflare':
        return cloudflareDelivery(from, to, rawInput);
      case 'resend':
        return resendDelivery(from, to, rawInput);
      default:
        throw new Error(`Unsupported RELAY_UPSTREAM_PROVIDER: ${resolvedProvider}`);
    }
  };
}

module.exports = {
  createUpstreamEmailDelivery
};
