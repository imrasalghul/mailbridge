// Copyright (c) 2026 Ra's al Ghul

const net = require('net');
const axios = require('axios');

const DEFAULT_POSTMARK_SPAMCHECK_URL = 'https://spamcheck.postmarkapp.com/filter';

function normalizeScore(value) {
  const score = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(score)) {
    throw new Error('SpamAssassin returned an invalid score');
  }
  return score;
}

function parseSpamAssassinCheckResponse(lines) {
  const status = lines[0]?.match(/^SPAMD\/([\d.-]+)\s+(\d+)\s+([A-Z0-9_]+)/);
  if (!status) {
    throw new Error(`SpamAssassin returned an unrecognized response: ${lines[0] || 'empty response'}`);
  }

  const responseCode = Number.parseInt(status[2], 10);
  const responseMessage = status[3];
  if (responseCode !== 0) {
    throw new Error(`SpamAssassin returned ${responseCode} ${responseMessage}`);
  }

  for (const line of lines) {
    const spam = line.match(/^Spam:\s*(True|False|Yes|No)\s*;\s*([+-]?\d+(?:\.\d+)?)\s*\/\s*([+-]?\d+(?:\.\d+)?)/i);
    if (spam) {
      return {
        responseCode,
        responseMessage,
        isSpam: ['true', 'yes'].includes(spam[1].toLowerCase()),
        spamScore: normalizeScore(spam[2]),
        baseSpamScore: normalizeScore(spam[3]),
        score: normalizeScore(spam[2]),
        backend: 'local'
      };
    }
  }

  throw new Error('SpamAssassin returned an invalid score');
}

async function checkWithPostmarkSpamCheck({ url, timeoutMs, rawEmailContent, axiosImpl = axios }) {
  const response = await axiosImpl.post(
    url || DEFAULT_POSTMARK_SPAMCHECK_URL,
    {
      email: String(rawEmailContent || ''),
      options: 'short'
    },
    {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Postmark SpamCheck returned HTTP ${response.status}`);
  }

  const payload = response.data || {};
  if (payload.success === false) {
    throw new Error(`Postmark SpamCheck error: ${payload.message || 'unknown error'}`);
  }

  const score = normalizeScore(payload.score);
  return {
    responseCode: 0,
    responseMessage: 'EX_OK',
    isSpam: false,
    spamScore: score,
    baseSpamScore: null,
    score,
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    backend: 'postmark'
  };
}

function checkWithSpamd({ host, port, timeoutMs, rawEmailContent }) {
  return new Promise((resolve, reject) => {
    let didComplete = false;
    let response = '';
    const socket = net.createConnection({ host, port });

    function finish(error, result) {
      if (didComplete) return;
      didComplete = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setTimeout(timeoutMs, () => {
      finish(new Error(`SpamAssassin check timed out after ${timeoutMs}ms`));
    });

    socket.on('connect', () => {
      const body = String(rawEmailContent || '');
      const request = [
        'CHECK SPAMC/1.5',
        `Content-length: ${Buffer.byteLength(body)}`,
        '',
        body
      ].join('\r\n');
      socket.end(request);
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });

    socket.on('error', (error) => {
      finish(new Error(`SpamAssassin error: ${error.message || error}`));
    });

    socket.on('close', () => {
      if (didComplete) return;
      try {
        const lines = response.split(/\r?\n/).filter(Boolean);
        finish(null, parseSpamAssassinCheckResponse(lines));
      } catch (error) {
        finish(error);
      }
    });
  });
}

function createSpamAssassinClient({
  host,
  port,
  timeoutMs,
  mode = 'local',
  postmarkUrl = DEFAULT_POSTMARK_SPAMCHECK_URL,
  axiosImpl = axios,
  spamcImpl = null,
  log = () => {}
}) {
  const normalizedMode = String(mode || 'local').toLowerCase();
  if (!['local', 'postmark'].includes(normalizedMode)) {
    throw new Error(`Unsupported SpamAssassin mode: ${mode}`);
  }

  const spamc = spamcImpl ? new spamcImpl(host, port, Math.ceil(timeoutMs / 1000)) : null;

  return {
    async checkMessage(rawEmailContent, requestId) {
      if (normalizedMode === 'postmark') {
        const result = await checkWithPostmarkSpamCheck({ url: postmarkUrl, timeoutMs, rawEmailContent, axiosImpl });
        log('[SpamAssassin]', 'Score resolved', {
          requestId,
          backend: result.backend,
          score: result.score
        });
        return result;
      }

      if (!spamc) {
        const result = await checkWithSpamd({ host, port, timeoutMs, rawEmailContent });
        log('[SpamAssassin]', 'Score resolved', {
          requestId,
          backend: result.backend,
          score: result.score
        });
        return result;
      }

      return new Promise((resolve, reject) => {
        let didComplete = false;
        const timeout = setTimeout(() => {
          if (didComplete) return;
          didComplete = true;
          reject(new Error(`SpamAssassin check timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        spamc.check(rawEmailContent, (error, result) => {
          if (didComplete) return;
          didComplete = true;
          clearTimeout(timeout);

          if (error) {
            return reject(new Error(`SpamAssassin error: ${error.message || error}`));
          }

          let score;
          try {
            score = normalizeScore(result?.score ?? result?.spamScore);
          } catch (error) {
            return reject(error);
          }

          log('[SpamAssassin]', 'Score resolved', {
            requestId,
            score
          });
          resolve({ ...result, score });
        });
      });
    }
  };
}

module.exports = {
  createSpamAssassinClient,
  parseSpamAssassinCheckResponse,
  normalizeScore
};
