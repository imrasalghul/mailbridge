// Copyright (c) 2026 Ra's al Ghul

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { createAiClassifier } = require('./lib/ai-classifier');
const { createAuditLogStore } = require('./lib/audit-log-store');
const { extractDomainFromAddress } = require('./lib/email-metadata');
const { createInboundMessageDecryptor } = require('./lib/inbound-message-crypto');
const { createLocalMailTransport } = require('./lib/local-mail-transport');
const { createMailgunDelivery } = require('./lib/mailgun-delivery');
const { createQueueCrypto } = require('./lib/queue-crypto');
const { createQueueManager } = require('./lib/queue-manager');
const { createQueueStore } = require('./lib/queue-store');
const { createResendDelivery } = require('./lib/resend-delivery');
const { createSendGridDelivery } = require('./lib/sendgrid-delivery');
const { createSpamAssassinClient } = require('./lib/spamassassin-client');
const { createSpamhausClient } = require('./lib/spamhaus-client');
const {
  containsGtube,
  prependHeadersToRaw,
  applySpamSubjectTag,
  buildInboundHeaders
} = require('./lib/spam-pipeline');
const { buildSmtpRelayPolicy } = require('./lib/smtp-relay-policy');
const { createSmtpRelayServer } = require('./lib/smtp-relay-server');
const { createUpstreamEmailDelivery } = require('./lib/upstream-email-delivery');
const {
  assertSupportedUpstreamProvider,
  formatUpstreamProviderLabel,
  isOutboundTarget
} = require('./lib/upstream-provider');
const { validateWebhookRequest } = require('./lib/webhook-intake');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const port = Number.parseInt(process.env.PORT || '3090', 10);
const smtpRelayPort = Number.parseInt(process.env.SMTP_RELAY_PORT || '2525', 10);
const maxQueueAttempts = Number.parseInt(process.env.QUEUE_MAX_ATTEMPTS || '20', 10);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dbPath = path.join(dataDir, 'mailbridge.db');
const secretsDbPath = path.resolve(process.env.SECRETS_DB_PATH || path.join(__dirname, 'secrets', 'secrets.db'));
const legacyDbPath = path.join(__dirname, 'mail_queue.sqlite');
const spamcTimeoutMs = Number.parseInt(process.env.SPAMC_TIMEOUT_MS || '10000', 10);
const hardBlockThreshold = Number.parseFloat(process.env.SA_BLOCK_THRESHOLD || '12');
const questionableThreshold = Number.parseFloat(process.env.SA_QUESTIONABLE_THRESHOLD || '5');
const spamSclScore = Number.parseInt(process.env.SPAM_SCL_SCORE || '9', 10);
const spamSubjectTag = process.env.SPAM_SUBJECT_TAG || '[SPAM]';
const mailbridgeHostname = process.env.MAILBRIDGE_HOSTNAME || 'mailbridge.example.com';
const verboseAppLogging = parseBoolean(process.env.MAILBRIDGE_VERBOSE_LOGGING, true);
const verboseSmtpRelayLogging = parseBoolean(process.env.SMTP_RELAY_VERBOSE_LOGGING, true);
const smtpRelayInjectHeaders = parseBoolean(process.env.SMTP_RELAY_INJECT_HEADERS, true);
const spamcFailOpen = parseBoolean(process.env.SPAMC_FAIL_OPEN, false);
const configuredUpstreamProvider = assertSupportedUpstreamProvider(process.env.RELAY_UPSTREAM_PROVIDER || 'sendgrid');
const relayApiKey = process.env.RELAY_API_KEY || '';
const relayFromFallback = process.env.RELAY_FROM_FALLBACK || process.env.SENDGRID_FROM_FALLBACK || 'postmaster@localhost';

function logVerbose(scope, message, details = {}) {
  if (!verboseAppLogging) return;
  const formattedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}=${value.join(',')}`;
      if (typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${value}`;
    })
    .join(' ');
  console.log(`${scope} ${message}${formattedDetails ? ` ${formattedDetails}` : ''}`);
}

function logSmtpRelay(scope, message, details = {}) {
  if (!verboseSmtpRelayLogging) return;
  logVerbose(scope, message, details);
}

async function start() {
  await fs.promises.mkdir(path.join(dataDir, 'queue'), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.dirname(secretsDbPath), { recursive: true, mode: 0o700 });

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.get('/health', (req, res) => res.status(200).send('OK'));

  const queueCrypto = createQueueCrypto();
  const auditStore = createAuditLogStore({
    dbPath,
    queueCrypto,
    log: logVerbose
  });
  await auditStore.init();
  const secretsDb = new sqlite3.Database(secretsDbPath);

  const queueStore = createQueueStore({
    db: secretsDb,
    dataDir,
    queueCrypto,
    auditStore,
    log: logVerbose
  });
  await queueStore.init();
  await queueStore.migrateQueueItemsFromDatabase(auditStore.db, 'audit-db');
  await queueStore.migrateLegacyQueueFromDatabase(auditStore.db, 'audit-db');
  await queueStore.migrateLegacyQueue(legacyDbPath);

  const localMailTransport = createLocalMailTransport();
  const smtpRelayPolicy = buildSmtpRelayPolicy();
  const sendViaSendGrid = createSendGridDelivery({
    apiKey: relayApiKey,
    injectHeaders: smtpRelayInjectHeaders,
    relayHostname: mailbridgeHostname,
    fromFallback: relayFromFallback,
    log: logVerbose
  });
  const sendViaResend = createResendDelivery({
    apiKey: relayApiKey,
    baseUrl: process.env.RESEND_BASE_URL || 'https://api.resend.com',
    injectHeaders: smtpRelayInjectHeaders,
    relayHostname: mailbridgeHostname,
    fromFallback: relayFromFallback,
    log: logVerbose
  });
  const sendViaMailgun = createMailgunDelivery({
    apiKey: relayApiKey,
    domain: process.env.MAILGUN_DOMAIN,
    baseUrl: process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net',
    injectHeaders: smtpRelayInjectHeaders,
    relayHostname: mailbridgeHostname,
    fromFallback: relayFromFallback,
    log: logVerbose
  });
  const sendViaUpstream = createUpstreamEmailDelivery({
    defaultProvider: configuredUpstreamProvider,
    sendgridDelivery: sendViaSendGrid,
    resendDelivery: sendViaResend,
    mailgunDelivery: sendViaMailgun
  });
  const spamAssassinClient = createSpamAssassinClient({
    host: process.env.SPAMD_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.SPAMD_PORT || '783', 10),
    timeoutMs: spamcTimeoutMs,
    log: logVerbose
  });
  const aiClassifier = createAiClassifier({
    log: logVerbose
  });
  const spamhausClient = createSpamhausClient({
    log: logVerbose
  });
  const inboundMessageDecryptor = createInboundMessageDecryptor();

  const queueManager = createQueueManager({
    store: queueStore,
    auditStore,
    maxQueueAttempts,
    async deliverQueuedMessage(row) {
      if (isOutboundTarget(row.target)) {
        const providerLabel = formatUpstreamProviderLabel(row.target);
        logSmtpRelay(`[Queue->${providerLabel}]`, 'Retrying delivery', {
          queueId: row.id,
          from: row.sender,
          to: row.recipient,
          attempts: row.attempts
        });
        const upstreamResult = await sendViaUpstream({
          provider: row.target,
          from: row.sender,
          to: [row.recipient],
          rawInput: row.raw_content
        });
        logSmtpRelay(`[Queue->${providerLabel}]`, `Delivery accepted by ${providerLabel}`, {
          queueId: row.id,
          status: upstreamResult?.status,
          messageId: upstreamResult?.messageId
        });
        return;
      }

      await localMailTransport.sendMail({
        envelope: { from: row.sender, to: [row.recipient] },
        raw: row.raw_content
      });
    },
    onLog(level, message) {
      if (level === 'error') console.error(message);
      else console.log(message);
    }
  });
  queueManager.start(5 * 60 * 1000);

  async function logInboundAiEvent({ requestId, from, to, sourceIp, senderDomain, result, stage }) {
    await auditStore.logEvent({
      requestId,
      eventType: 'ai_result',
      direction: 'inbound',
      target: 'local_mail',
      outcome: result === '1' ? 'spam' : result === '0' ? 'not_spam' : 'inconclusive',
      sender: from,
      recipient: to,
      sourceIp,
      senderDomain,
      details: { stage }
    });
  }

  app.post('/api/webhook/email', async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    const validation = validateWebhookRequest(req, process.env.WEBHOOK_SECRET);

    if (!validation.ok) {
      if (validation.statusCode === 403) {
        logVerbose('[Webhook]', 'Rejected request due to invalid secret', {
          requestId,
          remoteAddress: validation.requestIp || req.ip
        });
      } else if (validation.statusCode === 500) {
        console.error(`[${requestId}] WEBHOOK_SECRET is not configured`);
      }
      return res.status(validation.statusCode).send(validation.error);
    }

    let resolvedPayload = validation.payload;
    if (validation.payload.encryptedPayload) {
      try {
        resolvedPayload = inboundMessageDecryptor.decryptPayload(validation.payload.encryptedPayload);
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
          console.error(`[${requestId}] Encrypted payload could not be processed: ${error.message}`);
        } else {
          console.warn(`[${requestId}] Invalid encrypted payload rejected: ${error.message}`);
        }
        return res.status(statusCode).send(error.message);
      }
    }

    const { from, to, raw } = resolvedPayload;
    const sourceIp = resolvedPayload.senderIp || validation.messageSourceIp;
    const requestIp = validation.requestIp;

    console.log(`[${requestId}] Processing mail from ${from}`);
    logVerbose('[Webhook]', 'Inbound payload accepted', {
      requestId,
      from,
      to,
      sourceIp,
      requestIp,
      rawSizeBytes: typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.byteLength(raw || ''),
      encryptedWebhookPayload: Boolean(validation.payload.encryptedPayload)
    });

    let isHardSpam = false;
    let isQuestionable = false;
    let aiConfirmedSpam = false;
    let spamSource = 'spamassassin';
    let spamReason = 'clean';
    let spamScore = null;
    const gtubeDetected = containsGtube(raw);

    try {
      const reputationCheck = await spamhausClient.checkMessage({
        senderIp: sourceIp,
        envelopeFrom: from,
        rawEmail: raw,
        requestId
      });
      const senderDomain = reputationCheck.senderDomain || extractDomainFromAddress(from);

      if (reputationCheck.blocked) {
        console.warn(`[${requestId}] Rejected sender due to Spamhaus listing. ipHit=${reputationCheck.ipHit} domainHit=${reputationCheck.domainHit} domain=${senderDomain || 'n/a'}`);
        await auditStore.logEvent({
          requestId,
          eventType: 'spamhaus_blocked',
          direction: 'inbound',
          target: 'local_mail',
          outcome: 'blocked',
          sender: from,
          recipient: to,
          sourceIp,
          senderDomain,
          details: {
            ipHit: reputationCheck.ipHit,
            domainHit: reputationCheck.domainHit,
            datasets: reputationCheck.datasets || []
          }
        });
        return res.status(406).send('Rejected by Spamhaus reputation filter');
      }

      let spamAssassinResult;
      try {
        spamAssassinResult = await spamAssassinClient.checkMessage(raw, requestId);
        spamScore = spamAssassinResult.score;
      } catch (spamError) {
        console.warn(`[${requestId}] ${spamError.message}. Falling back to AI classification.`);
        spamSource = 'ai-fallback';
        const aiFallback = await aiClassifier.classify(raw, requestId);
        await logInboundAiEvent({
          requestId,
          from,
          to,
          sourceIp,
          senderDomain,
          result: aiFallback,
          stage: 'fallback'
        });
        if (aiFallback === '1') {
          aiConfirmedSpam = true;
          spamReason = 'ai_fallback_spam';
        } else if (aiFallback === '0') {
          spamReason = 'ai_fallback_not_spam';
        } else if (!spamcFailOpen) {
          console.error(`[${requestId}] SpamAssassin and AI unavailable. Rejecting inbound mail (SPAMC_FAIL_OPEN=false).`);
          await auditStore.logEvent({
            requestId,
            eventType: 'delivery_failed',
            direction: 'inbound',
            target: 'local_mail',
            outcome: 'spam_filter_unavailable',
            sender: from,
            recipient: to,
            sourceIp,
            senderDomain,
            errorMessage: 'SpamAssassin and AI unavailable'
          });
          return res.status(503).send('Spam filter unavailable');
        } else {
          console.warn(`[${requestId}] SpamAssassin and AI unavailable. Continuing with fail-open behavior (SPAMC_FAIL_OPEN=true).`);
          spamReason = 'fail_open';
        }
        spamAssassinResult = { score: 0 };
      }

      logVerbose('[Spam]', 'Spam thresholds loaded', {
        requestId,
        hardBlockThreshold,
        questionableThreshold,
        score: spamAssassinResult.score
      });

      if (gtubeDetected) {
        isHardSpam = true;
        spamReason = 'gtube_test_string';
        spamSource = 'gtube';
      } else if (spamAssassinResult.score >= hardBlockThreshold) {
        isHardSpam = true;
        spamReason = 'sa_hard_block';
      } else if (spamAssassinResult.score >= questionableThreshold) {
        isQuestionable = true;
      }

      if (isQuestionable) {
        const aiResult = await aiClassifier.classify(raw, requestId);
        await logInboundAiEvent({
          requestId,
          from,
          to,
          sourceIp,
          senderDomain,
          result: aiResult,
          stage: 'questionable'
        });
        spamSource = 'spamassassin+ai';
        if (aiResult === '1') {
          aiConfirmedSpam = true;
          spamReason = 'sa_questionable_ai_spam';
        } else {
          spamReason = 'sa_questionable_ai_not_spam';
        }

        logVerbose('[Spam]', 'AI classification executed', {
          requestId,
          aiResult,
          aiConfirmedSpam
        });
      }

      if (!isHardSpam && !isQuestionable && !aiConfirmedSpam) {
        spamReason = 'sa_clean';
      }

      const finalSpamVerdict = isHardSpam || aiConfirmedSpam;
      logVerbose('[Spam]', 'Final verdict resolved', {
        requestId,
        finalSpamVerdict,
        spamReason,
        spamSource,
        spamScore,
        gtubeDetected
      });

      const headers = buildInboundHeaders({
        mailbridgeHostname,
        sourceIp,
        spamSource,
        spamReason,
        spamScore,
        finalSpamVerdict,
        spamSclScore,
        aiConfirmedSpam
      });

      const taggedRaw = applySpamSubjectTag(raw, finalSpamVerdict, spamSubjectTag);
      const finalRaw = prependHeadersToRaw(taggedRaw, headers);
      logVerbose('[Webhook]', 'Injected inbound local-mail headers', {
        requestId,
        isQuestionable,
        aiConfirmedSpam,
        injectedHeaderLines: headers.split('\r\n').filter(Boolean).length
      });

      try {
        await localMailTransport.sendMail({
          envelope: { from, to: [to] },
          raw: finalRaw
        });
        await auditStore.logEvent({
          requestId,
          eventType: 'delivered',
          direction: 'inbound',
          target: 'local_mail',
          outcome: 'delivered',
          sender: from,
          recipient: to,
          sourceIp,
          senderDomain
        });
        console.log(`[${requestId}] Direct delivery successful.`);
        return res.status(200).send('OK');
      } catch (deliveryError) {
        const smtpCode = deliveryError.responseCode;
        if (smtpCode && smtpCode >= 500) {
          await auditStore.logEvent({
            requestId,
            eventType: 'delivery_failed',
            direction: 'inbound',
            target: 'local_mail',
            outcome: 'permanent_failure',
            sender: from,
            recipient: to,
            sourceIp,
            senderDomain,
            statusCode: smtpCode,
            errorCode: deliveryError.code,
            errorMessage: deliveryError.message
          });
          console.error(`[${requestId}] Local mail server permanent rejection: ${deliveryError.message}`);
          return res.status(smtpCode).send(deliveryError.message);
        }

        console.warn(`[${requestId}] Local mail server offline/busy (${smtpCode || 'Timeout'}). Queueing...`);
        await queueManager.addToQueue(from, to, finalRaw, 'local_mail', {
          direction: 'inbound',
          requestId,
          sourceIp,
          senderDomain
        });
        return res.status(202).send('Queued for later delivery');
      }
    } catch (error) {
      console.error(`[${requestId}] Error: ${error.message}`);
      return res.status(500).send(error.message);
    }
  });

  const smtpRelayServer = createSmtpRelayServer({
    verboseAppLogging,
    socketTimeoutMs: Number.parseInt(process.env.SMTP_RELAY_SOCKET_TIMEOUT_MS || '120000', 10),
    logSmtpRelay,
    sendViaUpstream,
    addToQueue: queueManager.addToQueue,
    relayFromFallback,
    upstreamProvider: configuredUpstreamProvider,
    policy: smtpRelayPolicy,
    auditStore
  });

  app.listen(port, '0.0.0.0', () => console.log(`Mail Bridge HTTP listener running on port ${port}`));
  smtpRelayServer.listen(smtpRelayPort, '0.0.0.0', () => {
    console.log(`Mail Bridge SMTP relay running on port ${smtpRelayPort}`);
  });
}

start().catch((error) => {
  console.error(`[Startup] ${error?.message || error}`);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`[Process] Unhandled rejection: ${error?.message || error}`);
});
