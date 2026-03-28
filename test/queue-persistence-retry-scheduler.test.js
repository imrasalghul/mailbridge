const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPermanentDeliveryError,
} = require('../lib/queue-persistence-retry-scheduler');

test('explicit permanent=false keeps 5xx sendgrid-style errors retryable', () => {
  assert.equal(
    isPermanentDeliveryError({ statusCode: 503, permanent: false }),
    false,
  );
});

test('explicit permanent=true still wins regardless of status code', () => {
  assert.equal(
    isPermanentDeliveryError({ statusCode: 429, permanent: true }),
    true,
  );
});

test('429 remains temporary when no explicit permanent flag is provided', () => {
  assert.equal(isPermanentDeliveryError({ statusCode: 429 }), false);
});

test('smtp 5xx remains permanent when no explicit permanent flag is provided', () => {
  assert.equal(isPermanentDeliveryError({ responseCode: 550 }), true);
});
