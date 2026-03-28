// Copyright (c) 2026 Ra's al Ghul

const Spamc = require('spamc');

function createSpamAssassinClient({
  host,
  port,
  timeoutMs,
  spamcImpl = Spamc,
  log = () => {}
}) {
  const spamc = new spamcImpl({ host, port });

  return {
    async checkMessage(rawEmailContent, requestId) {
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

          const score = Number.parseFloat(result?.score);
          if (Number.isNaN(score)) {
            return reject(new Error('SpamAssassin returned an invalid score'));
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
  createSpamAssassinClient
};
