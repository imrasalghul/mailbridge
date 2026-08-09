// Copyright (c) 2026 Ra's al Ghul

const { SMTPServer } = require('smtp-server');

const { extractDomainFromAddress } = require('./email-metadata');
const { formatUpstreamProviderLabel } = require('./upstream-provider');

function createSmtpRelayServer({
  verboseAppLogging,
  socketTimeoutMs,
  maxMessageSizeBytes = 50 * 1024 * 1024,
  logSmtpRelay,
  sendViaUpstream,
  addToQueue,
  relayFromFallback,
  upstreamProvider,
  policy,
  auditStore,
  smtpServerClass = SMTPServer
}) {
  if (!Number.isSafeInteger(maxMessageSizeBytes) || maxMessageSizeBytes <= 0) {
    throw new Error('SMTP relay maximum message size must be a positive integer');
  }
  const providerLabel = formatUpstreamProviderLabel(upstreamProvider);
  const logPrefix = `[SMTP->${providerLabel}]`;

  return new smtpServerClass({
    secure: false,
    logger: verboseAppLogging,
    socketTimeout: socketTimeoutMs,
    size: maxMessageSizeBytes,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: !policy.tlsEnabled,
    ...(policy.tlsOptions || {}),
    onConnect(session, callback) {
      logSmtpRelay(logPrefix, 'Connection opened', {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        hostNameAppearsAs: session.hostNameAppearsAs
      });

      try {
        policy.assertRemoteAllowed(session.remoteAddress);
        callback();
      } catch (error) {
        callback(error);
      }
    },
    onMailFrom(address, session, callback) {
      try {
        policy.assertSecureSession(session);
        logSmtpRelay(logPrefix, 'MAIL FROM accepted', {
          sessionId: session.id,
          sender: address?.address || 'unknown'
        });
        callback();
      } catch (error) {
        callback(error);
      }
    },
    onRcptTo(address, session, callback) {
      try {
        policy.assertSecureSession(session);
        if (!address?.address) {
          return callback(new Error('Recipient address is required'));
        }

        logSmtpRelay(logPrefix, 'RCPT accepted', {
          sessionId: session.id,
          recipient: address.address
        });
        callback();
      } catch (error) {
        callback(error);
      }
    },
    onData(stream, session, callback) {
      const relaySessionId = session.id || Math.random().toString(36).substring(7);
      let hasCompleted = false;
      const safeCallback = (error) => {
        if (hasCompleted) {
          if (error) console.error(`[SMTP] Late callback error ignored: ${error.message}`);
          return;
        }
        hasCompleted = true;
        callback(error);
      };

      try {
        policy.assertSecureSession(session);
      } catch (error) {
        return safeCallback(error);
      }

      const chunks = [];
      let receivedBytes = 0;
      let messageTooLarge = false;
      stream.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxMessageSizeBytes) {
          messageTooLarge = true;
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', (error) => safeCallback(error));
      stream.on('end', async () => {
        if (messageTooLarge || stream.sizeExceeded) {
          const error = new Error(`Message exceeds SMTP relay size limit of ${maxMessageSizeBytes} bytes`);
          error.responseCode = 552;
          return safeCallback(error);
        }
        const rawBuffer = Buffer.concat(chunks);
        const from = session.envelope?.mailFrom?.address || relayFromFallback || 'postmaster@localhost';
        const to = (session.envelope?.rcptTo || []).map((rcpt) => rcpt.address).filter(Boolean);
        const senderDomain = extractDomainFromAddress(from);
        const queueContext = {
          direction: 'outbound',
          requestId: relaySessionId,
          sourceIp: session.remoteAddress,
          senderDomain
        };

        logSmtpRelay(logPrefix, 'Received message from local relay client', {
          sessionId: relaySessionId,
          from,
          to,
          rcptCount: to.length,
          rawSizeBytes: rawBuffer.length,
          secure: session.secure
        });

        if (!to.length) {
          console.error(`${logPrefix} sessionId=${relaySessionId} rejected: no recipients in envelope`);
          return safeCallback(new Error('No recipients in envelope'));
        }

        try {
          const upstreamResult = await sendViaUpstream({
            provider: upstreamProvider,
            from,
            to,
            rawInput: rawBuffer
          });
          if (auditStore) {
            await Promise.all(to.map((recipient) => auditStore.logEvent({
              requestId: relaySessionId,
              eventType: 'delivered',
              direction: 'outbound',
              target: upstreamProvider,
              outcome: 'delivered',
              sender: from,
              recipient,
              sourceIp: session.remoteAddress,
              senderDomain,
              statusCode: upstreamResult?.status,
              details: {
                messageId: upstreamResult?.messageId || null,
                pluginId: upstreamResult?.pluginId || null,
                pluginVersion: upstreamResult?.pluginVersion || null
              }
            })));
          }
          logSmtpRelay(logPrefix, `Delivery accepted by ${providerLabel}`, {
            sessionId: relaySessionId,
            status: upstreamResult?.status,
            messageId: upstreamResult?.messageId,
            rcptCount: to.length
          });
          safeCallback();
        } catch (error) {
          console.error(`${logPrefix} sessionId=${relaySessionId} ${providerLabel} delivery error: ${error.message}`);
          if (error.permanent) {
            if (auditStore) {
              await Promise.all(to.map((recipient) => auditStore.logEvent({
                requestId: relaySessionId,
                eventType: 'delivery_failed',
                direction: 'outbound',
                target: upstreamProvider,
                outcome: 'permanent_failure',
                sender: from,
                recipient,
                sourceIp: session.remoteAddress,
                senderDomain,
                statusCode: error.statusCode,
                errorCode: error.code,
                errorMessage: error.message,
                details: { pluginId: error.pluginId || null, pluginVersion: error.pluginVersion || null }
              })));
            }
            const smtpError = new Error(error.message);
            smtpError.responseCode = 550;
            safeCallback(smtpError);
            return;
          }

          try {
            for (const recipient of to) {
              await addToQueue(from, recipient, rawBuffer, upstreamProvider, queueContext);
              logSmtpRelay(logPrefix, 'Queued recipient for retry', {
                sessionId: relaySessionId,
                from,
                to: recipient
              });
            }
            console.warn(`${logPrefix} sessionId=${relaySessionId} ${providerLabel} unavailable; queued message from ${from} to ${to.join(', ')}`);
            safeCallback();
          } catch (queueError) {
            console.error(`${logPrefix} sessionId=${relaySessionId} Failed to queue message: ${queueError.message}`);
            safeCallback(queueError);
          }
        }
      });
    }
  });
}

module.exports = {
  createSmtpRelayServer
};
