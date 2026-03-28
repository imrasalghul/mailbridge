// Copyright (c) 2026 Ra's al Ghul

const SUPPORTED_UPSTREAM_PROVIDERS = ['sendgrid', 'resend', 'mailgun'];

function normalizeUpstreamProvider(value, fallback = 'sendgrid') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized || fallback;
}

function assertSupportedUpstreamProvider(provider) {
  const normalized = normalizeUpstreamProvider(provider);
  if (!SUPPORTED_UPSTREAM_PROVIDERS.includes(normalized)) {
    throw new Error(`Unsupported RELAY_UPSTREAM_PROVIDER: ${provider}. Supported values: ${SUPPORTED_UPSTREAM_PROVIDERS.join(', ')}`);
  }
  return normalized;
}

function isOutboundTarget(target) {
  return Boolean(target) && target !== 'local_mail';
}

function formatUpstreamProviderLabel(provider) {
  switch (normalizeUpstreamProvider(provider)) {
    case 'sendgrid':
      return 'SendGrid';
    case 'resend':
      return 'Resend';
    case 'mailgun':
      return 'Mailgun';
    default:
      return String(provider || 'upstream');
  }
}

module.exports = {
  SUPPORTED_UPSTREAM_PROVIDERS,
  assertSupportedUpstreamProvider,
  formatUpstreamProviderLabel,
  isOutboundTarget,
  normalizeUpstreamProvider
};
