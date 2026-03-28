const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClassificationPrompt,
  createAiClassifier,
  normalizeClassificationReason,
  parseClassificationResult
} = require('../lib/ai-classifier');

test('ai classifier is disabled by default', async () => {
  let createClientCalls = 0;
  const classifier = createAiClassifier({
    env: {
      AI_ENABLED: 'false'
    },
    createClient() {
      createClientCalls += 1;
      return {};
    }
  });

  const result = await classifier.classify('Subject: hi\r\n\r\nbody', 'req-disabled');
  assert.equal(result, null);
  assert.equal(createClientCalls, 0);
});

test('ai classifier uses custom baseURL when configured', async () => {
  let clientOptions = null;
  const classifier = createAiClassifier({
    env: {
      AI_ENABLED: 'true',
      AI_API_KEY: 'sk-test',
      AI_BASE_URL: 'http://localhost:4000/v1',
      AI_MODEL: 'gpt-5.4-nano'
    },
    createClient(options) {
      clientOptions = options;
      return {
        chat: {
          completions: {
            async create() {
              return {
                choices: [
                  { message: { content: '{"spam":1,"reason":"phishing","score":9}' } }
                ]
              };
            }
          }
        }
      };
    }
  });

  const result = await classifier.classify('Subject: hi\r\n\r\nbody', 'req-baseurl');
  assert.deepEqual(result, {
    spam: '1',
    reason: 'phishing',
    score: 9
  });
  assert.equal(clientOptions.baseURL, 'http://localhost:4000/v1');
});

test('classification prompt uses headers-only mode by default', async () => {
  const { prompt } = await buildClassificationPrompt({
    rawEmailContent: 'Subject: hi\r\nX-Test: 1\r\n\r\nsecret body',
    inputScope: 'headers',
    maxInputChars: 100
  });

  assert.match(prompt, /<email_headers>/);
  assert.doesNotMatch(prompt, /<email_body>/);
  assert.doesNotMatch(prompt, /secret body/);
  assert.match(prompt, /"spam"/);
  assert.match(prompt, /"reason"/);
  assert.match(prompt, /"score"/);
});

test('classification prompt attachments mode includes filenames but not bodies', async () => {
  const { prompt, effectiveScope } = await buildClassificationPrompt({
    rawEmailContent: 'Subject: hi\r\n\r\nbody content',
    inputScope: 'attachments',
    maxInputChars: 100,
    attachmentNameExtractor: async () => ['Invoice.pdf']
  });

  assert.equal(effectiveScope, 'attachments');
  assert.match(prompt, /<attachment_names>/);
  assert.match(prompt, /Invoice\.pdf/);
  assert.doesNotMatch(prompt, /<email_body>/);
  assert.doesNotMatch(prompt, /body content/);
});

test('classification prompt falls back to headers mode when attachment extraction fails', async () => {
  const { prompt, effectiveScope } = await buildClassificationPrompt({
    rawEmailContent: 'Subject: hi\r\n\r\nbody content',
    inputScope: 'attachments',
    maxInputChars: 100,
    attachmentNameExtractor: async () => {
      throw new Error('boom');
    }
  });

  assert.equal(effectiveScope, 'headers');
  assert.doesNotMatch(prompt, /<attachment_names>/);
  assert.doesNotMatch(prompt, /<email_body>/);
});

test('classification prompt full_email mode includes the body', async () => {
  const { prompt } = await buildClassificationPrompt({
    rawEmailContent: 'Subject: hi\r\n\r\nbody content',
    inputScope: 'full_email',
    maxInputChars: 100
  });

  assert.match(prompt, /<email_body>/);
  assert.match(prompt, /body content/);
});

test('ai classifier rejects invalid structured responses', async () => {
  const classifier = createAiClassifier({
    env: {
      AI_ENABLED: 'true',
      AI_API_KEY: 'sk-test'
    },
    createClient() {
      return {
        chat: {
          completions: {
            async create() {
              return {
                choices: [
                  { message: { content: 'maybe' } }
                ]
              };
            }
          }
        }
      };
    }
  });

  const result = await classifier.classify('Subject: hi\r\n\r\nbody', 'req-strict');
  assert.equal(result, null);
});

test('parseClassificationResult normalizes json payloads', () => {
  assert.deepEqual(
    parseClassificationResult('{"spam":1,"reason":"Escalated Tone","score":9.4}'),
    {
      spam: '1',
      reason: 'escalated_tone',
      score: 9
    }
  );

  assert.deepEqual(
    parseClassificationResult('{"spam":0,"reason":"clean","score":2.2}'),
    {
      spam: '0',
      reason: 'not_spam',
      score: 2
    }
  );
});

test('parseClassificationResult tolerates fenced json and bare compatibility output', () => {
  assert.deepEqual(
    parseClassificationResult('```json\n{"spam":1,"reason":"crypto","score":8}\n```'),
    {
      spam: '1',
      reason: 'crypto',
      score: 8
    }
  );

  assert.deepEqual(
    parseClassificationResult('1'),
    {
      spam: '1',
      reason: 'spam',
      score: null
    }
  );
});

test('normalizeClassificationReason keeps short safe tokens', () => {
  assert.equal(normalizeClassificationReason('Credential Theft!!!'), 'credential_theft');
  assert.equal(normalizeClassificationReason(''), 'unknown');
});
