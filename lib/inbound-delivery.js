const { recordAuditEvent } = require('./audit-event');

async function deliverInboundMessage({ transport, queueManager, auditStore, from, to, raw, context = {} }) {
  const event = { ...context, direction: 'inbound', target: 'local_mail', sender: from, recipient: to };
  try {
    await transport.sendMail({ envelope: { from, to: [to] }, raw });
  } catch (error) {
    if (error.responseCode >= 500 && error.responseCode < 600) {
      await recordAuditEvent(auditStore, { ...event, eventType: 'delivery_failed', outcome: 'permanent_failure', statusCode: error.responseCode, errorCode: error.code, errorMessage: error.message });
      return { statusCode: 422, body: 'Permanently rejected by local mail server' };
    }
    await queueManager.addToQueue(from, to, raw, 'local_mail', { ...context, direction: 'inbound' });
    return { statusCode: 202, body: 'Queued for later delivery' };
  }
  await recordAuditEvent(auditStore, { ...event, eventType: 'delivered', outcome: 'delivered' });
  return { statusCode: 200, body: 'OK' };
}

module.exports = { deliverInboundMessage };
