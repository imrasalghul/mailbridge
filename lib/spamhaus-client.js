// Copyright (c) 2026 Ra's al Ghul

const axios = require('axios');
const net = require('net');

const { deriveSenderDomain } = require('./email-metadata');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function isPrivateOrReservedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    return false;
  }

  return true;
}

function createSpamhausClient({
  env = process.env,
  httpClient = axios.create({
    baseURL: 'https://api.spamhaus.org',
    timeout: 10000,
    validateStatus: () => true
  }),
  now = () => Date.now(),
  log = () => {}
} = {}) {
  const enabled = parseBoolean(env.SPAMHAUS_ENABLED, false);
  const username = env.SPAMHAUS_USERNAME || '';
  const password = env.SPAMHAUS_PASSWORD || '';
  const failOpen = parseBoolean(env.SPAMHAUS_FAIL_OPEN, true);

  let tokenCache = null;
  let tokenPromise = null;
  let tldCache = null;
  let tldPromise = null;

  async function login() {
    if (tokenPromise) return tokenPromise;
    if (!username || !password) {
      throw new Error('Spamhaus is enabled but SPAMHAUS_USERNAME/SPAMHAUS_PASSWORD are not configured');
    }

    tokenPromise = (async () => {
      const response = await httpClient.post('/api/v1/login', {
        username,
        password,
        realm: 'intel'
      });

      if (response.status !== 200 || response.data?.code !== 200 || !response.data?.token || !response.data?.expires) {
        throw new Error(`Spamhaus login failed (${response.status || 'unknown'}): ${response.data?.message || 'Unexpected response'}`);
      }

      tokenCache = {
        token: response.data.token,
        expiresAtMs: Number(response.data.expires) * 1000
      };
      return tokenCache.token;
    })();

    try {
      return await tokenPromise;
    } finally {
      tokenPromise = null;
    }
  }

  async function getAuthToken() {
    if (!enabled) return null;
    const refreshWindowMs = 5 * 60 * 1000;
    if (tokenCache && tokenCache.expiresAtMs - refreshWindowMs > now()) {
      return tokenCache.token;
    }
    return login();
  }

  async function authenticatedGet(pathname, allowRetry = true) {
    const token = await getAuthToken();
    const response = await httpClient.get(pathname, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401 && allowRetry) {
      tokenCache = null;
      await login();
      return authenticatedGet(pathname, false);
    }

    return response;
  }

  async function getTlds() {
    if (tldCache) return tldCache;
    if (tldPromise) return tldPromise;

    tldPromise = (async () => {
      const response = await authenticatedGet('/api/intel/v2/domains/tld');
      if (response.status === 429) {
        throw new Error('Spamhaus TLD list lookup hit the API rate limit');
      }
      if (response.status !== 200 || !Array.isArray(response.data)) {
        throw new Error(`Spamhaus TLD list lookup failed (${response.status || 'unknown'})`);
      }

      tldCache = response.data.map((entry) => String(entry).toLowerCase()).sort((a, b) => b.length - a.length);
      return tldCache;
    })();

    try {
      return await tldPromise;
    } finally {
      tldPromise = null;
    }
  }

  async function lookupIp(ip) {
    const response = await authenticatedGet(`/api/intel/v1/byobject/cidr/ALL/listed/live/${encodeURIComponent(ip)}`);
    if (response.status === 404) {
      return { checked: true, hit: false, datasets: [] };
    }
    if (response.status === 429) {
      throw new Error('Spamhaus IP lookup hit the API rate limit');
    }
    if (response.status !== 200) {
      throw new Error(`Spamhaus IP lookup failed (${response.status || 'unknown'})`);
    }

    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    return {
      checked: true,
      hit: results.length > 0,
      datasets: [...new Set(results.map((result) => result.dataset).filter(Boolean))]
    };
  }

  async function lookupDomain(domain) {
    const response = await authenticatedGet(`/api/intel/v2/byobject/domain/${encodeURIComponent(domain)}/listing`);
    if (response.status === 404) {
      return { checked: true, hit: false };
    }
    if (response.status === 429) {
      throw new Error('Spamhaus domain lookup hit the API rate limit');
    }
    if (response.status !== 200) {
      throw new Error(`Spamhaus domain lookup failed (${response.status || 'unknown'})`);
    }

    const data = response.data || {};
    return {
      checked: true,
      hit: Boolean(data['is-listed'] ?? data.is_listed)
    };
  }

  async function runGuarded(step, requestId, details, fallbackValue) {
    try {
      return await step();
    } catch (error) {
      log('[Spamhaus]', 'Lookup failed', {
        requestId,
        ...details,
        error: error.message
      });

      if (!failOpen) throw error;
      return fallbackValue;
    }
  }

  async function checkMessage({ senderIp, envelopeFrom, rawEmail, requestId }) {
    if (!enabled) {
      return { checked: false, blocked: false, reason: 'disabled' };
    }

    const ipLookup = !senderIp || isPrivateOrReservedIp(senderIp)
      ? { checked: false, hit: false, reason: 'private_or_missing_ip', datasets: [] }
      : await runGuarded(
          () => lookupIp(senderIp),
          requestId,
          { senderIp },
          { checked: false, hit: false, reason: 'lookup_failed', datasets: [] }
        );

    let senderDomain = null;
    let domainLookup = { checked: false, hit: false, reason: 'missing_sender_domain' };

    const tlds = await runGuarded(
      () => getTlds(),
      requestId,
      { senderIp },
      null
    );

    if (tlds) {
      senderDomain = await runGuarded(
        () => deriveSenderDomain({ envelopeFrom, rawEmail, tlds }),
        requestId,
        { senderIp },
        null
      );
    }

    if (senderDomain) {
      domainLookup = await runGuarded(
        () => lookupDomain(senderDomain),
        requestId,
        { senderIp, senderDomain },
        { checked: false, hit: false, reason: 'lookup_failed' }
      );
    }

    const blocked = Boolean(ipLookup.hit || domainLookup.hit);
    log('[Spamhaus]', 'Reputation checked', {
      requestId,
      senderIp: senderIp || 'unknown',
      senderDomain: senderDomain || null,
      ipHit: ipLookup.hit,
      ipDatasets: ipLookup.datasets || [],
      domainHit: domainLookup.hit
    });

    return {
      checked: Boolean(ipLookup.checked || domainLookup.checked),
      blocked,
      senderDomain,
      ipHit: Boolean(ipLookup.hit),
      domainHit: Boolean(domainLookup.hit),
      datasets: ipLookup.datasets || []
    };
  }

  return {
    checkMessage,
    getTlds,
    isPrivateOrReservedIp
  };
}

module.exports = {
  createSpamhausClient,
  isPrivateOrReservedIp
};
