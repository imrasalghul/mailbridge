// Copyright (c) 2026 Ra's al Ghul

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { createAuditLogStore } = require('./lib/audit-log-store');
const { createCloudflareDelivery } = require('./lib/cloudflare-delivery');
const { extractDomainFromAddress } = require('./lib/email-metadata');
const { createInboundMessageDecryptor } = require('./lib/inbound-message-crypto');
const { createLocalMailTransport } = require('./lib/local-mail-transport');
const { createPluginManager } = require('./lib/plugin-manager');
const { createQueueCrypto } = require('./lib/queue-crypto');
const { createQueueManager } = require('./lib/queue-manager');
const { createQueueStore } = require('./lib/queue-store');
const { createSpamAssassinClient } = require('./lib/spamassassin-client');
const {
  containsGtube,
  prependHeadersToRaw,
  applySpamSubjectTag,
  buildInboundHeaders
} = require('./lib/spam-pipeline');
const { buildSmtpRelayPolicy } = require('./lib/smtp-relay-policy');
const { createSmtpRelayServer } = require('./lib/smtp-relay-server');
const { validateWebhookRequest } = require('./lib/webhook-intake');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const port = Number.parseInt(process.env.PORT || '3090', 10);
const smtpRelayPort = Number.parseInt(process.env.SMTP_RELAY_PORT || '2525', 10);
const smtpRelayMaxMessageBytes = Number.parseInt(process.env.SMTP_RELAY_MAX_MESSAGE_BYTES || String(50 * 1024 * 1024), 10);
const maxQueueAttempts = Number.parseInt(process.env.QUEUE_MAX_ATTEMPTS || '20', 10);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dbPath = path.join(dataDir, 'mailbridge.db');
const secretsDbPath = path.resolve(process.env.SECRETS_DB_PATH || path.join(__dirname, 'secrets', 'secrets.db'));
const legacyDbPath = path.join(__dirname, 'mail_queue.sqlite');
const spamcTimeoutMs = Number.parseInt(process.env.SPAMC_TIMEOUT_MS || '10000', 10);
const spamAssassinMode = (process.env.SPAMASSASSIN_MODE || 'local').toLowerCase();
const hardBlockThreshold = Number.parseFloat(process.env.SA_BLOCK_THRESHOLD || '12');
const questionableThreshold = Number.parseFloat(process.env.SA_QUESTIONABLE_THRESHOLD || '5');
const spamSclScore = Number.parseInt(process.env.SPAM_SCL_SCORE || '9', 10);
const spamSubjectTag = process.env.SPAM_SUBJECT_TAG || '[SPAM]';
const mailbridgeHostname = process.env.MAILBRIDGE_HOSTNAME || 'mailbridge.example.com';
const verboseAppLogging = parseBoolean(process.env.MAILBRIDGE_VERBOSE_LOGGING, true);
const verboseSmtpRelayLogging = parseBoolean(process.env.SMTP_RELAY_VERBOSE_LOGGING, true);
const smtpRelayEnabled = parseBoolean(process.env.SMTP_RELAY_ENABLED, false);
const smtpRelayInjectHeaders = parseBoolean(process.env.SMTP_RELAY_INJECT_HEADERS, true);
const spamcFailOpen = parseBoolean(process.env.SPAMC_FAIL_OPEN, false);
const configuredUpstreamProvider = String(process.env.RELAY_UPSTREAM_PROVIDER || 'cloudflare').trim().toLowerCase();
const relayFromFallback = process.env.RELAY_FROM_FALLBACK || process.env.SENDGRID_FROM_FALLBACK || 'postmaster@localhost';
const pluginManager = createPluginManager({
  pluginDirectory: process.env.MAILBRIDGE_PLUGIN_DIR || path.join(dataDir, 'plugins'),
  lockfilePath: process.env.MAILBRIDGE_PLUGIN_LOCKFILE || path.join(dataDir, 'plugins.lock.json'),
  log: (...args) => logVerbose(...args)
});
let pluginConfigFile = {};
try {
  const configPath = process.env.MAILBRIDGE_PLUGIN_CONFIG_FILE || path.join(dataDir, 'plugins.config.json');
  if (configPath && fs.existsSync(configPath)) pluginConfigFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.warn(`[Plugin] Ignoring invalid plugin config file: ${error.message}`);
}

function pluginEnvironment(manifest) {
  const prefix = `MAILBRIDGE_PLUGIN_${manifest.id.toUpperCase().replace(/-/g, '_')}_`;
  const fieldNames = (fields) => Array.isArray(fields) ? fields : Object.keys(fields || {});
  const config = { ...(pluginConfigFile[manifest.id] || {}) };
  const secrets = {};
  for (const name of fieldNames(manifest.config)) if (process.env[`${prefix}${name}`] !== undefined) config[name] = process.env[`${prefix}${name}`];
  for (const name of fieldNames(manifest.secrets)) {
    if (process.env[`${prefix}${name}`] !== undefined) secrets[name] = process.env[`${prefix}${name}`];
    else if (process.env[name] !== undefined) secrets[name] = process.env[name];
  }
  return { config, secrets };
}

async function invokeCapability(type, capability, operation, payload) {
  const plugins = pluginManager.discover()
    .filter(({ manifest }) => manifest.type === type && manifest.capabilities.includes(capability))
    .sort((a, b) => a.manifest.priority - b.manifest.priority || a.manifest.id.localeCompare(b.manifest.id));
  const results = [];
  for (const { manifest } of plugins) {
    try {
      const response = await pluginManager.invoke(manifest.id, operation, { requestId: `${payload.requestId}:${manifest.id}`, payload }, pluginEnvironment(manifest));
      if (!response.ok) throw new Error(response.error || `Plugin ${manifest.id} failed`);
      results.push({ plugin: manifest, result: response.result || {} });
    } catch (error) {
      if (manifest.failurePolicy === 'fail-closed') throw error;
      console.warn(`[${payload.requestId}] Plugin ${manifest.id} failed open: ${error.message}`);
    }
  }
  return results;
}

async function applyMiddlewarePlugins({ requestId, from, to, rawEmail, sourceIp }) {
  let current = { from, to, rawEmail };
  const middleware = pluginManager.discover()
    .filter(({ manifest }) => manifest.type === 'middleware')
    .sort((a, b) => a.manifest.priority - b.manifest.priority || a.manifest.id.localeCompare(b.manifest.id));
  for (const { manifest } of middleware) {
    try {
      const response = await pluginManager.invoke(manifest.id, 'transform', {
        requestId: `${requestId}:${manifest.id}`,
        payload: { ...current, sourceIp }
      }, pluginEnvironment(manifest));
      if (!response.ok) throw Object.assign(new Error(response.error || `Middleware ${manifest.id} failed`), { permanent: response.permanent });
      const result = response.result || {};
      if (result.action === 'reject') return { rejected: true, reason: result.reason || manifest.id };
      if (typeof result.rawEmail === 'string') current.rawEmail = result.rawEmail;
      if (typeof result.from === 'string') current.from = result.from;
      if (typeof result.to === 'string') current.to = result.to;
    } catch (error) {
      if (manifest.failurePolicy === 'fail-closed') throw error;
      console.warn(`[${requestId}] Middleware ${manifest.id} failed open: ${error.message}`);
    }
  }
  return { rejected: false, ...current };
}

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
  const sendViaCloudflare = createCloudflareDelivery({
    workerUrl: process.env.CLOUDFLARE_SEND_WORKER_URL,
    webhookSecret: process.env.CLOUDFLARE_SEND_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET,
    injectHeaders: smtpRelayInjectHeaders,
    relayHostname: mailbridgeHostname,
    fromFallback: relayFromFallback,
    log: logVerbose
  });
  const sendViaUpstream = async ({ provider = configuredUpstreamProvider, from, to, rawInput }) => {
    const providerId = String(provider || configuredUpstreamProvider).trim().toLowerCase();
    if (providerId === 'cloudflare') return sendViaCloudflare(from, to, rawInput);
    const { manifest } = pluginManager.find(providerId);
    if (manifest.type !== 'provider') throw new Error(`Plugin ${providerId} is not an outbound provider`);
    const response = await pluginManager.invoke(providerId, 'deliver', {
      requestId: `${providerId}-${Date.now()}`,
      payload: { from, to, rawInput: Buffer.from(rawInput).toString('base64'), context: { relayHostname: mailbridgeHostname, injectHeaders: smtpRelayInjectHeaders, fromFallback: relayFromFallback } }
    }, pluginEnvironment(manifest));
    if (!response.ok) throw Object.assign(new Error(response.error || `Provider ${providerId} failed`), { permanent: response.permanent, statusCode: response.statusCode });
    return response.result;
  };
  const spamAssassinClient = createSpamAssassinClient({
    host: process.env.SPAMD_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.SPAMD_PORT || '783', 10),
    timeoutMs: spamcTimeoutMs,
    mode: spamAssassinMode,
    postmarkUrl: process.env.POSTMARK_SPAMCHECK_URL,
    log: logVerbose
  });
  const classifyWithPlugins = async (rawEmail, requestId) => {
    const results = await invokeCapability('scanner', 'classification', 'scan', { rawEmail, requestId });
    return results.map(({ result }) => result).find((result) => result.spam === '1' || result.spam === '0') || null;
  };
  const inboundMessageDecryptor = createInboundMessageDecryptor();

  const queueManager = createQueueManager({
    store: queueStore,
    auditStore,
    maxQueueAttempts,
    async deliverQueuedMessage(row) {
      if (row.target && row.target !== 'local_mail') {
        const providerLabel = String(row.target);
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

  async function logClassificationEvent({ requestId, from, to, sourceIp, senderDomain, result, stage }) {
    await auditStore.logEvent({
      requestId,
      eventType: 'classification_result',
      direction: 'inbound',
      target: 'local_mail',
      outcome: result?.spam === '1' ? 'spam' : result?.spam === '0' ? 'not_spam' : 'inconclusive',
      sender: from,
      recipient: to,
      sourceIp,
      senderDomain,
      details: {
        stage,
        reason: result?.reason || null,
        score: result?.score ?? null
      }
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
    let pluginConfirmedSpam = false;
    let pluginClassification = null;
    let spamSource = 'spamassassin';
    let spamReason = 'clean';
    let spamScore = null;
    const gtubeDetected = containsGtube(raw);

    try {
      const reputationResults = await invokeCapability('scanner', 'reputation', 'scan', { senderIp: sourceIp, envelopeFrom: from, rawEmail: raw, requestId });
      const reputationCheck = reputationResults.map(({ result }) => result).find((result) => result.blocked) || {};
      const senderDomain = reputationCheck.senderDomain || extractDomainFromAddress(from);

      if (reputationCheck.blocked) {
        console.warn(`[${requestId}] Rejected sender by reputation plugin. domain=${senderDomain || 'n/a'}`);
        await auditStore.logEvent({
          requestId,
          eventType: 'reputation_plugin_blocked',
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
        return res.status(406).send('Rejected by reputation filter');
      }

      let spamAssassinResult;
      try {
        spamAssassinResult = await spamAssassinClient.checkMessage(raw, requestId);
        spamScore = spamAssassinResult.score;
      } catch (spamError) {
        console.warn(`[${requestId}] ${spamError.message}. Falling back to classification plugins.`);
        spamSource = 'plugin-fallback';
        const classificationFallback = await classifyWithPlugins(raw, requestId);
        await logClassificationEvent({
          requestId,
          from,
          to,
          sourceIp,
          senderDomain,
          result: classificationFallback,
          stage: 'fallback'
        });
        pluginClassification = classificationFallback;
        if (classificationFallback?.spam === '1') {
          pluginConfirmedSpam = true;
          spamReason = 'plugin_fallback_spam';
        } else if (classificationFallback?.spam === '0') {
          spamReason = 'plugin_fallback_not_spam';
        } else if (!spamcFailOpen) {
          console.error(`[${requestId}] SpamAssassin and classification plugins unavailable. Rejecting inbound mail (SPAMC_FAIL_OPEN=false).`);
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
            errorMessage: 'SpamAssassin and classification plugins unavailable'
          });
          return res.status(503).send('Spam filter unavailable');
        } else {
          console.warn(`[${requestId}] SpamAssassin and classification plugins unavailable. Continuing with fail-open behavior (SPAMC_FAIL_OPEN=true).`);
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
        const classificationResult = await classifyWithPlugins(raw, requestId);
        await logClassificationEvent({
          requestId,
          from,
          to,
          sourceIp,
          senderDomain,
          result: classificationResult,
          stage: 'questionable'
        });
        pluginClassification = classificationResult;
        spamSource = 'spamassassin+plugin';
        if (classificationResult?.spam === '1') {
          pluginConfirmedSpam = true;
          spamReason = 'sa_questionable_plugin_spam';
        } else if (classificationResult?.spam === '0') {
          spamReason = 'sa_questionable_plugin_not_spam';
        } else {
          spamReason = 'sa_questionable_plugin_inconclusive';
        }

        logVerbose('[Spam]', 'Classification plugin executed', {
        requestId,
        classificationResult: classificationResult?.spam || null,
        pluginReason: classificationResult?.reason || null,
        pluginScore: classificationResult?.score ?? null,
        pluginConfirmedSpam
      });
    }

      if (!isHardSpam && !isQuestionable && !pluginConfirmedSpam) {
        spamReason = 'sa_clean';
      }

      const finalSpamVerdict = isHardSpam || pluginConfirmedSpam;
      const mailbridgeProbabilityScore = pluginClassification?.score ?? null;
      const mailbridgeReason = finalSpamVerdict
        ? pluginClassification?.spam === '1'
          ? pluginClassification.reason
          : gtubeDetected
            ? 'gtube'
            : isHardSpam
              ? 'spam_score'
              : 'spam'
        : pluginClassification?.spam === '0'
          ? pluginClassification.reason
          : 'not_spam';
      logVerbose('[Spam]', 'Final verdict resolved', {
        requestId,
        finalSpamVerdict,
        spamReason,
        mailbridgeReason,
        mailbridgeProbabilityScore,
        spamSource,
        spamScore,
        gtubeDetected,
        pluginReason: pluginClassification?.reason || null,
        pluginScore: pluginClassification?.score ?? null
      });

      const headers = buildInboundHeaders({
        mailbridgeHostname,
        sourceIp,
        spamSource,
        spamReason,
        mailbridgeReason,
        mailbridgeProbabilityScore,
        spamScore,
        finalSpamVerdict,
        spamSclScore,
        pluginConfirmedSpam
      });

      const taggedRaw = applySpamSubjectTag(raw, finalSpamVerdict, spamSubjectTag);
      const finalRaw = prependHeadersToRaw(taggedRaw, headers);
      const middlewareResult = await applyMiddlewarePlugins({ requestId, from, to, rawEmail: finalRaw, sourceIp });
      if (middlewareResult.rejected) {
        await auditStore.logEvent({ requestId, eventType: 'middleware_blocked', direction: 'inbound', target: 'local_mail', outcome: 'blocked', sender: from, recipient: to, sourceIp, errorMessage: middlewareResult.reason });
        return res.status(406).send(`Rejected by middleware: ${middlewareResult.reason}`);
      }
      const transformedFrom = middlewareResult.from;
      const transformedTo = middlewareResult.to;
      const transformedRaw = middlewareResult.rawEmail;
      logVerbose('[Webhook]', 'Injected inbound local-mail headers', {
        requestId,
        isQuestionable,
        pluginConfirmedSpam,
        injectedHeaderLines: headers.split('\r\n').filter(Boolean).length
      });

      try {
        await localMailTransport.sendMail({
          envelope: { from: transformedFrom, to: [transformedTo] },
          raw: transformedRaw
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
        await queueManager.addToQueue(transformedFrom, transformedTo, transformedRaw, 'local_mail', {
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

  app.listen(port, '0.0.0.0', () => console.log(`Mail Bridge HTTP listener running on port ${port}`));

  if (smtpRelayEnabled) {
    const smtpRelayPolicy = buildSmtpRelayPolicy();
    const smtpRelayServer = createSmtpRelayServer({
      verboseAppLogging,
      socketTimeoutMs: Number.parseInt(process.env.SMTP_RELAY_SOCKET_TIMEOUT_MS || '120000', 10),
      maxMessageSizeBytes: smtpRelayMaxMessageBytes,
      logSmtpRelay,
      sendViaUpstream,
      addToQueue: queueManager.addToQueue,
      relayFromFallback,
      upstreamProvider: configuredUpstreamProvider,
      policy: smtpRelayPolicy,
      auditStore
    });

    smtpRelayServer.listen(smtpRelayPort, '0.0.0.0', () => {
      console.log(`Mail Bridge SMTP relay running on port ${smtpRelayPort}`);
    });
  } else {
    console.log('Mail Bridge SMTP relay disabled. Set SMTP_RELAY_ENABLED=true to enable outbound relay.');
  }
}

start().catch((error) => {
  console.error(`[Startup] ${error?.message || error}`);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`[Process] Unhandled rejection: ${error?.message || error}`);
});
