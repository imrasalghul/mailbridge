// Copyright (c) 2026 Ra's al Ghul

function normalizeUpstreamProvider(value, fallback = 'cloudflare') {
  return String(value || fallback).trim().toLowerCase() || fallback;
}

function isOutboundTarget(target) {
  return Boolean(target) && target !== 'local_mail';
}

function formatUpstreamProviderLabel(provider) {
  return normalizeUpstreamProvider(provider, 'upstream');
}

module.exports = { formatUpstreamProviderLabel, isOutboundTarget, normalizeUpstreamProvider };
