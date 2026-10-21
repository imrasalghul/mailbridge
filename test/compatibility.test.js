const test = require('node:test');
const assert = require('node:assert/strict');
const { getCompatibility, getPluginExecutionOptions } = require('../lib/compatibility');

test('an unchanged environment retains legacy behavior', () => {
  const settings = getCompatibility({});
  assert.deepEqual(settings, getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'legacy' }));
  assert.equal(settings.pluginStrict, false);
  assert.equal(settings.receipts, false);
  assert.equal(settings.allowRedirects, true);
  assert.equal(settings.logFormat, 'text');
  assert.equal(settings.strictFileReads, false);
});

test('plugin limits are explicit on upgrades and bounded for modern installs', () => {
  assert.equal(getPluginExecutionOptions({}).maxConcurrent, 0);
  const modern = getPluginExecutionOptions({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' });
  assert.equal(modern.maxConcurrent, 4);
  assert.equal(modern.maxPending, 100);
  assert.equal(modern.memoryMb, 128);
  assert.equal(getPluginExecutionOptions({ MAILBRIDGE_PLUGIN_MAX_CONCURRENT: '2' }).maxConcurrent, 2);
});

test('modern behavior is explicit and individual switches allow gradual adoption', () => {
  const modern = getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' });
  assert.equal(modern.pluginStrict, true);
  assert.equal(modern.receipts, true);
  assert.equal(modern.allowRedirects, false);
  assert.equal(modern.logFormat, 'json');
  const staged = getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_PLUGIN_STRICT: 'false', MAILBRIDGE_DELIVERY_RECEIPTS: 'false', MAILBRIDGE_HTTP_ALLOW_REDIRECTS: 'true', MAILBRIDGE_LOG_FORMAT: 'text' });
  assert.equal(staged.pluginStrict, false);
  assert.equal(staged.receipts, false);
  assert.equal(staged.allowRedirects, true);
  assert.equal(staged.logFormat, 'text');
  assert.throws(() => getCompatibility({ MAILBRIDGE_BEHAVIOR_PROFILE: 'modren' }), /profile/i);
  assert.throws(() => getCompatibility({ MAILBRIDGE_PLUGIN_STRICT: 'maybe' }), /MAILBRIDGE_PLUGIN_STRICT/);
});
