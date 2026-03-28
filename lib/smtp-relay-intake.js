// Copyright (c) 2026 Ra's al Ghul

const { SMTPServer } = require('smtp-server');

function createSmtpRelayServer({ verboseAppLogging, socketTimeoutMs, logSmtpRelay, sendViaSendGrid, addToQueue, sendgridFromFallback }) {
  return new SMTPServer({
    secure: false,
    logger: verboseAppLogging,
    authOptional: true,
    allowInsecureAuth: true,
    socketTimeout: socketTimeoutMs,
    disabledCommands: ['STARTTLS'],
    onConnect(session, callback) {
      logSmtpRelay('[SMTP->SendGrid] Connection opened', {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        hostNameAppearsAs: session.hostNameAppearsAs
      });
      callback();
    },
    onAuth(auth, session, callback) {
      logSmtpRelay('[SMTP->SendGrid] AUTH accepted', {
        sessionId: session.id,
        username: auth.username || 'unknown',
        method: auth.method
      });
      callback(null, { user: auth.username || 'anonymous' });
    },
    onMailFrom(address, session, callback) {
      logSmtpRelay('[SMTP->SendGrid] MAIL FROM accepted', {
        sessionId: session.id,
        sender: address?.address || 'unknown'
      });
      callback();
    },
    onRcptTo(address, session, callback) {
      if (!address?.address) {
        return callback(new Error('Recipient address is required'));
      }
      logSmtpRelay('[SMTP->SendGrid] RCPT accepted', {
        sessionId: session.id,
        recipient: address.address
      });
      callback();
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

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (error) => safeCallback(error));
      stream.on('end', async () => {
        const rawBuffer = Buffer.concat(chunks);
        const from = session.envelope?.mailFrom?.address || sendgridFromFallback || 'postmaster@localhost';
        const to = (session.envelope?.rcptTo || []).map((rcpt) => rcpt.address).filter(Boolean);
        const authenticatedAs = session.user || 'anonymous';

        logSmtpRelay('[SMTP->SendGrid] Received message from Exchange', {
          sessionId: relaySessionId,
          from,
          to,
          rcptCount: to.length,
          rawSizeBytes: rawBuffer.length,
          authenticatedAs
        });

        if (!to.length) {
          console.error(`[SMTP->SendGrid] sessionId=${relaySessionId} rejected: no recipients in envelope`);
          return safeCallback(new Error('No recipients in envelope'));
        }

        try {
          const sendGridResult = await sendViaSendGrid(from, to, rawBuffer);
          logSmtpRelay('[SMTP->SendGrid] Delivery accepted by SendGrid', {
            sessionId: relaySessionId,
            status: sendGridResult?.status,
            messageId: sendGridResult?.messageId,
            rcptCount: to.length
          });
          safeCallback();
        } catch (error) {
          console.error(`[SMTP->SendGrid] sessionId=${relaySessionId} SendGrid delivery error: ${error.message}`);
          if (error.permanent) {
            const smtpError = new Error(error.message);
            smtpError.responseCode = 550;
            safeCallback(smtpError);
            return;
          }

          try {
            for (const recipient of to) {
              await addToQueue(from, recipient, rawBuffer, 'sendgrid');
              logSmtpRelay('[SMTP->SendGrid] Queued recipient for retry', {
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
