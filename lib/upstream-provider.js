// Copyright (c) 2026 Ra's al Ghul

const DEFAULT_UPSTREAM_PROVIDER = 'cloudflare';
const SUPPORTED_UPSTREAM_PROVIDERS = [DEFAULT_UPSTREAM_PROVIDER, 'resend'];

function normalizeUpstreamProvider(value, fallback = DEFAULT_UPSTREAM_PROVIDER) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized || fallback;
}

function assertSupportedUpstreamProvider(provider) {
  const normalized = normalizeUpstreamProvider(provider);
  if (!SUPPORTED_UPSTREAM_PROVIDERS.includes(normalized)) {
    const error = new Error(`Unsupported RELAY_UPSTREAM_PROVIDER: ${provider}. Supported values: ${SUPPORTED_UPSTREAM_PROVIDERS.join(', ')}`);
    error.permanent = true;
    throw error;
  }
  return normalized;
}

function isOutboundTarget(target) {
  return Boolean(target) && target !== 'local_mail';
}

function formatUpstreamProviderLabel(provider) {
  switch (normalizeUpstreamProvider(provider)) {
    case 'cloudflare':
      return 'Cloudflare Email Service';
    case 'resend':
      return 'Resend';
    default:
      return String(provider || 'upstream');
  }
}

module.exports = {
  DEFAULT_UPSTREAM_PROVIDER,
  SUPPORTED_UPSTREAM_PROVIDERS,
  assertSupportedUpstreamProvider,
  formatUpstreamProviderLabel,
  isOutboundTarget,
  normalizeUpstreamProvider
};
