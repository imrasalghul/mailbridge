// Copyright (c) 2026 Ra's al Ghul

const { isOutboundTarget } = require('./upstream-provider');

function isPermanentDeliveryError(error) {
  const statusCode = error.responseCode || error.statusCode;
  if (typeof error.permanent === 'boolean') return error.permanent;
  if (!statusCode) return false;
  return (statusCode >= 400 && statusCode < 500 && statusCode !== 429) || statusCode >= 500;
}

function createQueueManager({
  store,
  auditStore,
  maxQueueAttempts,
  deliverQueuedMessage,
  onLog = () => {}
}) {
  let timer = null;
  let processing = false;

  async function addToQueue(from, to, raw, target = 'local_mail', context = {}) {
    return store.addToQueue(from, to, raw, target, context);
  }

  async function processQueue() {
    if (processing) return;
    processing = true;

    try {
      const rows = await store.listQueueItems(50);
      if (!rows.length) return;

      onLog('info', `[Queue] Attempting to process ${rows.length} queued messages...`);

      for (const row of rows) {
        if (row.attempts >= maxQueueAttempts) {
          await auditStore.logEvent({
            queueId: row.id,
            requestId: row.request_id,
            eventType: 'dropped',
            direction: isOutboundTarget(row.target) ? 'outbound' : 'inbound',
            target: row.target,
            outcome: 'max_attempts_exceeded',
            attemptNumber: row.attempts,
            senderHash: row.sender_hash,
            recipientHash: row.recipient_hash,
            sourceIpHash: row.source_ip_hash,
            senderDomain: row.sender_domain,
            details: { maxQueueAttempts }
          });
          await store.deleteQueueItem(row.id);
          onLog('error', `[Queue] Msg ${row.id} reached max attempts (${maxQueueAttempts}). Removing from queue.`);
          continue;
        }

        try {
          const queuedMessage = await store.loadQueuedMessage(row);
          await auditStore.logEvent({
            queueId: row.id,
            requestId: row.request_id,
            eventType: 'retry',
            direction: isOutboundTarget(row.target) ? 'outbound' : 'inbound',
            target: row.target,
            outcome: 'attempt_started',
            attemptNumber: row.attempts + 1,
            senderHash: row.sender_hash,
            recipientHash: row.recipient_hash,
            sourceIpHash: row.source_ip_hash,
            senderDomain: row.sender_domain
          });

          await deliverQueuedMessage({
            id: queuedMessage.id,
            target: queuedMessage.target,
            sender: queuedMessage.sender,
            recipient: queuedMessage.recipient,
            raw_content: queuedMessage.rawContent,
            attempts: queuedMessage.attempts
          });

          await store.deleteQueueItem(row.id);
          await auditStore.logEvent({
            queueId: row.id,
            requestId: row.request_id,
            eventType: 'delivered',
            direction: isOutboundTarget(row.target) ? 'outbound' : 'inbound',
            target: row.target,
            outcome: 'delivered',
            attemptNumber: row.attempts + 1,
            senderHash: row.sender_hash,
            recipientHash: row.recipient_hash,
            sourceIpHash: row.source_ip_hash,
            senderDomain: row.sender_domain
          });
          onLog('info', `[Queue] Successfully delivered queued msg ${row.id} (${row.target})`);
        } catch (error) {
          const isPermanent = isPermanentDeliveryError(error);

          if (isPermanent) {
            await auditStore.logEvent({
              queueId: row.id,
              requestId: row.request_id,
              eventType: 'delivery_failed',
              direction: isOutboundTarget(row.target) ? 'outbound' : 'inbound',
              target: row.target,
              outcome: 'permanent_failure',
              attemptNumber: row.attempts + 1,
              senderHash: row.sender_hash,
              recipientHash: row.recipient_hash,
              sourceIpHash: row.source_ip_hash,
              senderDomain: row.sender_domain,
              statusCode: error.responseCode || error.statusCode,
              errorCode: error.code,
              errorMessage: error.message
            });
            await store.deleteQueueItem(row.id);
            onLog('error', `[Queue] Permanent failure for msg ${row.id}: ${error.message}. Removing from queue.`);
          } else {
            await store.markAttemptFailed(row.id);
            await auditStore.logEvent({
              queueId: row.id,
              requestId: row.request_id,
              eventType: 'retry',
              direction: isOutboundTarget(row.target) ? 'outbound' : 'inbound',
              target: row.target,
              outcome: 'temporary_failure',
              attemptNumber: row.attempts + 1,
              senderHash: row.sender_hash,
              recipientHash: row.recipient_hash,
              sourceIpHash: row.source_ip_hash,
              senderDomain: row.sender_domain,
              statusCode: error.responseCode || error.statusCode,
              errorCode: error.code,
              errorMessage: error.message
            });
            onLog('error', `[Queue] Temporary failure for msg ${row.id}: ${error.message}. Will retry.`);
            break;
          }
        }
      }
    } finally {
      processing = false;
    }
  }

  function start(intervalMs = 5 * 60 * 1000) {
    if (timer) return timer;
    timer = setInterval(() => {
      processQueue().catch((error) => {
        onLog('error', `[Queue] Processing failed: ${error.message}`);
      });
    }, intervalMs);
    return timer;
  }

  return {
    addToQueue,
    isPermanentDeliveryError,
    processQueue,
    start
  };
}

module.exports = {
  createQueueManager,
  isPermanentDeliveryError
};
