// Copyright (c) 2026 Ra's al Ghul

const { SMTPServer } = require('smtp-server');

const { extractDomainFromAddress } = require('./email-metadata');

function createSmtpRelayServer({
  verboseAppLogging,
  socketTimeoutMs,
  logSmtpRelay,
  sendViaSendGrid,
  addToQueue,
  sendgridFromFallback,
  policy,
  auditStore
}) {
  return new SMTPServer({
    secure: false,
    logger: verboseAppLogging,
    socketTimeout: socketTimeoutMs,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: !policy.tlsEnabled,
    ...(policy.tlsOptions || {}),
    onConnect(session, callback) {
      logSmtpRelay('[SMTP->SendGrid]', 'Connection opened', {
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
        logSmtpRelay('[SMTP->SendGrid]', 'MAIL FROM accepted', {
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

        logSmtpRelay('[SMTP->SendGrid]', 'RCPT accepted', {
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
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (error) => safeCallback(error));
      stream.on('end', async () => {
        const rawBuffer = Buffer.concat(chunks);
        const from = session.envelope?.mailFrom?.address || sendgridFromFallback || 'postmaster@localhost';
        const to = (session.envelope?.rcptTo || []).map((rcpt) => rcpt.address).filter(Boolean);
        const senderDomain = extractDomainFromAddress(from);
        const queueContext = {
          direction: 'outbound',
          requestId: relaySessionId,
          sourceIp: session.remoteAddress,
          senderDomain
        };

        logSmtpRelay('[SMTP->SendGrid]', 'Received message from local relay client', {
          sessionId: relaySessionId,
          from,
          to,
          rcptCount: to.length,
          rawSizeBytes: rawBuffer.length,
          secure: session.secure
        });

        if (!to.length) {
          console.error(`[SMTP->SendGrid] sessionId=${relaySessionId} rejected: no recipients in envelope`);
          return safeCallback(new Error('No recipients in envelope'));
        }

        try {
          const sendGridResult = await sendViaSendGrid(from, to, rawBuffer);
          if (auditStore) {
            await Promise.all(to.map((recipient) => auditStore.logEvent({
              requestId: relaySessionId,
              eventType: 'delivered',
              direction: 'outbound',
              target: 'sendgrid',
              outcome: 'delivered',
              sender: from,
              recipient,
              sourceIp: session.remoteAddress,
              senderDomain,
              statusCode: sendGridResult?.status,
              details: {
                messageId: sendGridResult?.messageId || null
              }
            })));
          }
          logSmtpRelay('[SMTP->SendGrid]', 'Delivery accepted by SendGrid', {
            sessionId: relaySessionId,
            status: sendGridResult?.status,
            messageId: sendGridResult?.messageId,
            rcptCount: to.length
          });
          safeCallback();
        } catch (error) {
          console.error(`[SMTP->SendGrid] sessionId=${relaySessionId} SendGrid delivery error: ${error.message}`);
          if (error.permanent) {
            if (auditStore) {
              await Promise.all(to.map((recipient) => auditStore.logEvent({
                requestId: relaySessionId,
                eventType: 'delivery_failed',
                direction: 'outbound',
                target: 'sendgrid',
                outcome: 'permanent_failure',
                sender: from,
                recipient,
                sourceIp: session.remoteAddress,
                senderDomain,
                statusCode: error.statusCode,
                errorCode: error.code,
                errorMessage: error.message
              })));
            }
            const smtpError = new Error(error.message);
            smtpError.responseCode = 550;
            safeCallback(smtpError);
            return;
          }

          try {
            for (const recipient of to) {
              await addToQueue(from, recipient, rawBuffer, 'sendgrid', queueContext);
              logSmtpRelay('[SMTP->SendGrid]', 'Queued recipient for retry', {
                sessionId: relaySessionId,
                from,
                to: recipient
              });
            }
            console.warn(`[SMTP->SendGrid] sessionId=${relaySessionId} SendGrid unavailable; queued message from ${from} to ${to.join(', ')}`);
            safeCallback();
          } catch (queueError) {
            console.error(`[SMTP->SendGrid] sessionId=${relaySessionId} Failed to queue message: ${queueError.message}`);
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
