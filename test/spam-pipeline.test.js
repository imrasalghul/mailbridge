const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInboundHeaders } = require('../lib/spam-pipeline');

test('buildInboundHeaders injects the human-facing mailbridge reason without legacy internal headers', () => {
  const headers = buildInboundHeaders({
    mailbridgeHostname: 'mailbridge.example.com',
    sourceIp: '203.0.113.7',
    spamSource: 'spamassassin+ai',
    spamReason: 'sa_questionable_ai_spam',
    mailbridgeReason: 'credential_theft',
    mailbridgeProbabilityScore: 8,
    spamScore: 6.5,
    finalSpamVerdict: true,
    spamSclScore: 9,
    aiConfirmedSpam: true
  });

  assert.match(headers, /X-Mailbridge-Reason: credential_theft/);
  assert.match(headers, /X-Mailbridge-PS: 8/);
  assert.match(headers, /X-AI-Confirmed-Spam: YES/);
  assert.doesNotMatch(headers, /X-Mailbridge-Source-IP:/);
  assert.doesNotMatch(headers, /X-Mailbridge-Spam-Source:/);
  assert.doesNotMatch(headers, /X-Mailbridge-Spam-Reason:/);
});

test('buildInboundHeaders defaults mailbridge reason safely for non-spam mail', () => {
  const headers = buildInboundHeaders({
    mailbridgeHostname: 'mailbridge.example.com',
    sourceIp: '203.0.113.7',
    spamSource: 'spamassassin',
    spamReason: 'sa_clean',
    mailbridgeReason: null,
    mailbridgeProbabilityScore: null,
    spamScore: 0,
    finalSpamVerdict: false,
    spamSclScore: 1,
    aiConfirmedSpam: false
  });

  assert.match(headers, /X-Mailbridge-Reason: not_spam/);
  assert.doesNotMatch(headers, /X-Mailbridge-PS:/);
});
