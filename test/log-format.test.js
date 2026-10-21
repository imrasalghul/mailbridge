const test = require('node:test');
const assert = require('node:assert/strict');
const { formatLog } = require('../lib/log-format');

test('legacy logs keep their prefixes while escaping forged lines in both formats', () => {
  assert.equal(formatLog('[Queue] Delivery successful.', 'text'), '[Queue] Delivery successful.');
  for (const format of ['text', 'json']) {
    const line = formatLog('[Plugin] sender\r\nFORGED', format);
    assert.equal(line.includes('\n'), false);
    assert.match(line, /\\r\\nFORGED/);
  }
  assert.equal(formatLog('Message', 'json'), '"Message"');
});
