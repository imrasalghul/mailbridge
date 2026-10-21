// Audit availability must not change an already committed mail delivery or queue write.
async function recordAuditEvent(store, event, onError = (error) => console.error(`[Audit] Event write failed: ${error.code || 'unavailable'}`)) {
  try {
    await store?.logEvent(event);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

module.exports = { recordAuditEvent };
