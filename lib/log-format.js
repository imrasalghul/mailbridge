function formatLog(message, format = 'text') {
  const encoded = JSON.stringify(String(message));
  // Keep the established text prefix, with JSON escaping for untrusted controls.
  return format === 'json' ? encoded : encoded.slice(1, -1);
}

module.exports = { formatLog };
