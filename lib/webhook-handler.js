const { createHash } = require('node:crypto');
const { validateWebhookRequest } = require('./webhook-intake');
const { getCompatibility } = require('./compatibility');

function createWebhookHandler({ webhookSecret, receiptStore, processWebhook, receiptsEnabled = getCompatibility().receipts }) {
  return async (req, res) => {
    res.type('text/plain').set('X-Content-Type-Options', 'nosniff');
    const validation = validateWebhookRequest(req, webhookSecret);
    if (!validation.ok) return res.status(validation.statusCode).send(validation.error);
    const headerId = receiptsEnabled ? req.headers['x-mailbridge-delivery-id'] : undefined;
    if (headerId !== undefined && (typeof headerId !== 'string' || !headerId.trim() || headerId.length > 512)) {
      return res.status(400).send('Invalid delivery identity');
    }
    try {
      const fingerprint = receiptsEnabled ? createHash('sha256').update(JSON.stringify(req.body)).digest('hex') : undefined;
      // Keep ciphertext identity stable across old/new Workers during deployment.
      // An outer object receipt also prevents reusing an object ID for different mail.
      const deliver = () => processWebhook(req, validation);
      const deliverOnce = receiptsEnabled && validation.payload.encryptedPayload
        ? () => receiptStore.processOnce({ deliveryId: `encrypted:${fingerprint}`, fingerprint }, deliver)
        : deliver;
      const result = headerId
        ? await receiptStore.processOnce({ deliveryId: `object:${headerId}`, fingerprint }, deliverOnce)
        : await deliverOnce();
      return res.status(result.statusCode).send(result.body);
    } catch {
      console.error('[Webhook] Processing failed; delivery will be retried');
      return res.status(503).send('Mail processing temporarily unavailable');
    }
  };
}

module.exports = { createWebhookHandler };
