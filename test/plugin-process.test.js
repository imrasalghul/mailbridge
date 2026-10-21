const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runPluginProcess, createPluginExecutor, buildPluginCommand, DEFAULT_DOCKER_IMAGE } = require('../lib/plugin-process');

function fixture(t, body, overrides = {}) {
  const pluginDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-process-'));
  t.after(() => fs.rmSync(pluginDirectory, { recursive: true, force: true }));
  const { source, config = {} } = typeof body === 'string' ? { source: body } : body;
  fs.writeFileSync(path.join(pluginDirectory, 'index.js'), source);
  return {
    pluginDirectory,
    manifest: { id: 'fixture', entrypoint: 'index.js', type: 'scanner', capabilities: ['classification'] },
    operation: 'scan', payload: { requestId: 'request-1', payload: {} }, timeoutMs: 3000,
    ...overrides,
    config: { ...config, ...overrides.config }
  };
}

function responding(response) {
  return {
    source: `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(JSON.stringify(JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON).fixtureResponse) + '\\n'));`,
    config: { fixtureResponse: response }
  };
}

test('plugin output preserves UTF-8 characters split between stdout chunks', async (t) => {
  const options = fixture(t, `
    process.stdin.resume();
    process.stdin.once('end', () => {
      const text = Buffer.from(JSON.stringify({ requestId: 'request-1', ok: true, result: { reason: '📨 café' } }) + '\\n');
      const split = text.indexOf(Buffer.from('📨')) + 1;
      process.stdout.write(text.subarray(0, split), () => setTimeout(() => process.stdout.end(text.subarray(split)), 50));
    });
  `);
  const response = await runPluginProcess(options);
  assert.equal(response.result.reason, '📨 café');
});

test('strict plugin responses reject malformed success and operation fields', async (t) => {
  const malformed = [
    { requestId: 'request-1', ok: 'true', result: {} },
    { requestId: 'request-1', ok: true, result: [] },
    { requestId: 'request-1', ok: true },
    { requestId: 'request-1', ok: false, error: { message: 'failure' } },
    { requestId: 'request-1', ok: true, result: { blocked: 'false' } },
    { requestId: 'request-1', ok: true, result: { spam: true } },
    { requestId: 'request-1', ok: true, result: { spam: 'maybe' } },
    { requestId: 'request-1', ok: true, result: { score: '3' } },
    { requestId: 'request-1', ok: true, result: { reason: 1 } },
    { requestId: 'request-1', ok: true, result: { senderDomain: [] } },
    { requestId: 'request-1', apiVersion: 2, ok: true, result: {} }
  ];
  for (const response of malformed) {
    const options = fixture(t, responding(response), { strict: true });
    await assert.rejects(runPluginProcess(options), { code: 'PLUGIN_PROTOCOL' });
  }
  for (const result of [{}, { action: 'typo' }, { action: 'continue', rawEmail: {} }, { action: 'reject', to: ['recipient@example.test'] }]) {
    const options = fixture(t, responding({ requestId: 'request-1', ok: true, result }), { strict: true, operation: 'transform' });
    await assert.rejects(runPluginProcess(options), { code: 'PLUGIN_PROTOCOL' });
  }
});

test('strict errors do not expose stderr or malformed response content', async (t) => {
  const secret = 'private-content-DO-NOT-LOG';
  const logs = [];
  const options = fixture(t, `process.stderr.write(JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON).fixtureSecret + '\\u001b[31m\\n'); process.exitCode = 3;`, { strict: true, config: { fixtureSecret: secret }, log: (...args) => logs.push(args) });
  await assert.rejects(runPluginProcess(options), error => error.code === 'PLUGIN_EXIT' && !error.message.includes(secret));
  const malformed = fixture(t, `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON).fixtureSecret));`, { strict: true, config: { fixtureSecret: secret } });
  await assert.rejects(runPluginProcess(malformed), error => error.code === 'PLUGIN_PROTOCOL' && !error.message.includes(secret));
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('legacy responses keep their shape and strict inconclusive scans remain valid', async (t) => {
  const legacy = { requestId: 'request-1', ok: true, label: 'legacy' };
  assert.deepEqual(await runPluginProcess(fixture(t, responding(legacy))), legacy);
  const inconclusive = { requestId: 'request-1', ok: true, result: { reason: 'Unavailable' } };
  assert.deepEqual(await runPluginProcess(fixture(t, responding(inconclusive), { strict: true })), inconclusive);
});

test('strict failure responses redact plugin-provided errors before the host can log them', async (t) => {
  const response = { requestId: 'request-1', ok: false, error: 'credential=private-value\nmessage body', permanent: true, statusCode: 422 };
  const result = await runPluginProcess(fixture(t, responding(response), { strict: true, operation: 'deliver' }));
  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.equal(result.statusCode, 422);
  assert.equal(result.error.includes('private-value'), false);
});

test('plugin timeout kills descendants before they can act after invocation ends', async (t) => {
  const options = fixture(t, `
    const { spawn } = require('node:child_process');
    const config = JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON);
    const child = spawn(process.execPath, ['-e',
      'const fs = require("node:fs");' +
      'fs.writeFileSync(' + JSON.stringify(config.heartbeat) + ', "");' +
      'fs.writeFileSync(' + JSON.stringify(config.started) + ', String(process.pid));' +
      'const heartbeat = setInterval(() => fs.appendFileSync(' + JSON.stringify(config.heartbeat) + ', "."), 50);' +
      'setTimeout(() => clearInterval(heartbeat), 10000);'
    ], { stdio: 'ignore' });
    setTimeout(() => {}, 10000);
  `, { timeoutMs: 1000 });
  options.config = { heartbeat: path.join(options.pluginDirectory, 'descendant-heartbeat'), started: path.join(options.pluginDirectory, 'descendant-started') };
  await assert.rejects(runPluginProcess(options), { code: 'PLUGIN_TIMEOUT' });
  assert.equal(fs.existsSync(options.config.started), true, 'fixture must launch a descendant');
  // Cleanup can take longer than the deadline under load. Activity before the
  // runner rejects is permitted; a surviving child must not act after rejection.
  const heartbeatAtRejection = fs.statSync(options.config.heartbeat).size;
  await delay(750);
  assert.equal(fs.statSync(options.config.heartbeat).size, heartbeatAtRejection, 'descendant must stop before the invocation rejects');
});

test('executor bounds concurrent processes and pending work while recording health', async (t) => {
  assert.equal(typeof createPluginExecutor, 'function');
  const options = fixture(t, `process.stdin.resume(); process.stdin.once('end', () => setTimeout(() => process.stdout.write('{"requestId":"request-1","ok":true,"result":{}}\\n'), 180));`);
  const executor = createPluginExecutor({ maxConcurrent: 1, maxPending: 1, maxWaitMs: 2000, strict: true });
  t.after(() => executor.close());
  const first = executor.run(options);
  const second = executor.run(options);
  await assert.rejects(executor.run(options), { code: 'PLUGIN_QUEUE_FULL' });
  assert.equal(executor.status().active, 1);
  assert.equal(executor.status().pending, 1);
  await Promise.all([first, second]);
  const status = executor.status();
  assert.equal(status.active, 0);
  assert.equal(status.pending, 0);
  assert.equal(status.plugins.fixture.succeeded, 2);
  assert.equal(status.plugins.fixture.failed, 1);
  assert.equal(typeof status.plugins.fixture.lastSuccessAt, 'string');
});

test('executor expires pending work and close rejects pending and running requests', async (t) => {
  assert.equal(typeof createPluginExecutor, 'function');
  const options = fixture(t, `process.stdin.resume(); process.stdin.once('end', () => setTimeout(() => process.stdout.write('{"requestId":"request-1","ok":true,"result":{}}\\n'), 500));`);
  const executor = createPluginExecutor({ maxConcurrent: 1, maxPending: 2, maxWaitMs: 50 });
  const first = executor.run(options);
  const firstRejected = assert.rejects(first, { code: 'PLUGIN_CLOSED' });
  await assert.rejects(executor.run(options), { code: 'PLUGIN_QUEUE_TIMEOUT' });
  const waiting = assert.rejects(executor.run(options), { code: 'PLUGIN_CLOSED' });
  await executor.close();
  await Promise.all([firstRejected, waiting]);
  assert.equal(executor.status().active, 0);
  assert.equal(executor.status().pending, 0);
  await assert.rejects(executor.run(options), { code: 'PLUGIN_CLOSED' });
});

test('executor defaults impose no concurrency limit on legacy configurations', async (t) => {
  assert.equal(typeof createPluginExecutor, 'function');
  const options = fixture(t, responding({ requestId: 'request-1', ok: true }));
  const executor = createPluginExecutor();
  t.after(() => executor.close());
  const jobs = [executor.run(options), executor.run(options), executor.run(options)];
  assert.equal(executor.status().active, 3);
  assert.equal(executor.status().pending, 0);
  await Promise.all(jobs);
});

test('executor rejects invalid configured limits and sandbox settings before receiving mail', () => {
  for (const options of [
    { maxConcurrent: -1 }, { maxPending: 1.5 }, { maxWaitMs: Infinity }, { maxWaitMs: 2147483648 },
    { timeoutMs: -1 }, { timeoutMs: 2147483648 }, { memoryMb: NaN }, { memoryMb: '128' },
    { maxPayloadBytes: -1 }, { maxOutputBytes: -1 }, { sandbox: 'typo' },
    { sandbox: 'docker', dockerImage: 'node:latest' }, { sandbox: 'docker', dockerNetwork: 'host' }
  ]) assert.throws(() => createPluginExecutor(options), /must be|Invalid|Unsupported/);
});

test('aborted requests cannot occupy pending slots', async (t) => {
  const options = fixture(t, `process.stdin.resume(); process.stdin.once('end', () => setTimeout(() => process.stdout.write('{"requestId":"request-1","ok":true,"result":{}}\\n'), 500));`);
  const executor = createPluginExecutor({ maxConcurrent: 1, maxPending: 1, maxWaitMs: 5000 });
  t.after(() => executor.close());
  const active = executor.run(options);
  const controller = new AbortController();
  const pending = executor.run({ ...options, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'PLUGIN_CLOSED' });
  controller.abort();
  await rejected;
  assert.equal(executor.status().pending, 0);
  await assert.rejects(executor.run({ ...options, signal: controller.signal }), { code: 'PLUGIN_CLOSED' });
  const next = executor.run(options);
  assert.equal(executor.status().pending, 1);
  await Promise.all([active, next]);
});

test('strict completion cleans the POSIX process group after its leader exits', { skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false }, async (t) => {
  const options = fixture(t, `
    const { spawn } = require('node:child_process');
    const config = JSON.parse(process.env.MAILBRIDGE_PLUGIN_CONFIG_JSON);
    process.stdin.resume();
    process.stdin.once('end', () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(config.marker) + ', "escaped"), 500);'], { stdio: 'ignore' });
      child.unref();
      process.stdout.end('{"requestId":"request-1","ok":true,"result":{}}\\n');
    });
  `, { strict: true });
  options.config = { marker: path.join(options.pluginDirectory, 'orphan-acted') };
  await runPluginProcess(options);
  await delay(700);
  assert.equal(fs.existsSync(options.config.marker), false);
});

test('Docker runner mounts only the release with explicit restrictions and no secret CLI values', (t) => {
  assert.equal(typeof buildPluginCommand, 'function');
  const options = fixture(t, '', { sandbox: 'docker', memoryMb: 128, secrets: { token: 'do-not-put-on-command-line' }, config: { label: 'config-is-private-too' } });
  const releaseDirectory = options.pluginDirectory;
  options.pluginDirectory = path.join(releaseDirectory, 'node_modules', '@scope', 'plugin');
  fs.mkdirSync(options.pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(options.pluginDirectory, 'index.js'), '');
  const plan = buildPluginCommand({ ...options, releaseDirectory });
  assert.equal(plan.command, 'docker');
  assert.ok(plan.args.includes('--read-only'));
  assert.ok(plan.args.includes('--log-driver=none'));
  assert.ok(plan.args.includes('--cap-drop=ALL'));
  assert.ok(plan.args.includes('--security-opt=no-new-privileges'));
  assert.ok(plan.args.includes('--user=65534:65534'));
  assert.ok(plan.args.includes('--network=none'));
  assert.ok(plan.args.includes('--pids-limit=64'));
  assert.ok(plan.args.includes('--cpus=1'));
  assert.ok(plan.args.includes('--memory=256m'));
  assert.ok(plan.args.some(value => value.startsWith('--tmpfs=/tmp:') && value.includes('noexec')));
  assert.ok(plan.args.some(value => /@sha256:[a-f0-9]{64}$/.test(value)));
  const mounts = plan.args.filter(value => value.startsWith('type=bind,'));
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0], `type=bind,src=${fs.realpathSync(releaseDirectory)},dst=/plugin,readonly`);
  assert.ok(plan.args.includes('--workdir=/plugin/node_modules/@scope/plugin'));
  assert.ok(plan.args.includes('/plugin/node_modules/@scope/plugin/index.js'));
  assert.ok(plan.args.includes('--max-old-space-size=128'));
  assert.ok(plan.args.includes('MAILBRIDGE_PLUGIN_SECRETS_JSON'));
  assert.equal(plan.args.join(' ').includes('do-not-put-on-command-line'), false);
  assert.equal(plan.args.join(' ').includes('config-is-private-too'), false);
  assert.equal(JSON.parse(plan.options.env.MAILBRIDGE_PLUGIN_SECRETS_JSON).token, 'do-not-put-on-command-line');
});

test('Docker runner rejects escaping entrypoints, roots, ambiguous mount paths, and unpinned images', (t) => {
  assert.equal(typeof buildPluginCommand, 'function');
  const options = fixture(t, '', { sandbox: 'docker' });
  assert.throws(() => buildPluginCommand({ ...options, manifest: { ...options.manifest, entrypoint: '../outside.js' } }), /inside|outside|entrypoint/i);
  assert.throws(() => buildPluginCommand({ ...options, releaseDirectory: path.join(options.pluginDirectory, 'other') }), /release|ENOENT/i);
  assert.throws(() => buildPluginCommand({ ...options, dockerImage: 'node:latest' }), /digest|pinned/i);
  assert.throws(() => buildPluginCommand({ ...options, dockerNetwork: 'host' }), /network/i);
  const commaDirectory = path.join(options.pluginDirectory, 'comma,path');
  fs.mkdirSync(commaDirectory);
  fs.writeFileSync(path.join(commaDirectory, 'index.js'), '');
  assert.throws(() => buildPluginCommand({ ...options, pluginDirectory: commaDirectory }), /bind mount/i);
});

test('strict provider success accepts opaque delivery metadata', async (t) => {
  const response = { apiVersion: 1, requestId: 'request-1', ok: true, result: { to: ['recipient@example.test'], messageId: 'id-1' } };
  assert.deepEqual(await runPluginProcess(fixture(t, responding(response), { strict: true, operation: 'deliver' })), response);
});

test('plugin heap flags are opt-in and ambient host secrets are not inherited', async (t) => {
  const previous = process.env.MAILBRIDGE_TEST_HOST_SECRET;
  process.env.MAILBRIDGE_TEST_HOST_SECRET = 'hidden-host-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.MAILBRIDGE_TEST_HOST_SECRET;
    else process.env.MAILBRIDGE_TEST_HOST_SECRET = previous;
  });
  const options = fixture(t, `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(JSON.stringify({ requestId: 'request-1', ok: true, result: { flags: process.execArgv, ambient: process.env.MAILBRIDGE_TEST_HOST_SECRET || null } }) + '\\n'));`);
  const legacy = await runPluginProcess(options);
  assert.deepEqual(legacy.result, { flags: [], ambient: null });
  const modern = await runPluginProcess({ ...options, memoryMb: 128, strict: true });
  assert.deepEqual(modern.result, { flags: ['--max-old-space-size=128'], ambient: null });
});

test('plugin output and input limits reject oversized byte streams', async (t) => {
  const options = fixture(t, responding({ requestId: 'request-1', ok: true, result: { reason: 'é'.repeat(1000) } }));
  await assert.rejects(runPluginProcess({ ...options, maxPayloadBytes: 1 }), { code: 'PLUGIN_PAYLOAD_LIMIT' });
  await assert.rejects(runPluginProcess({ ...options, maxOutputBytes: 1000 }), { code: 'PLUGIN_OUTPUT_LIMIT' });
});

test('Docker timeout retries named-container removal after stopping its client', async (t) => {
  // Mock only the absent external Docker CLI. Protocol I/O, timeout, and local
  // process cleanup still execute against real Node child processes.
  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  const calls = [];
  const modulePath = require.resolve('../lib/plugin-process');
  const originalModule = require.cache[modulePath];
  const mock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== 'docker') return spawn(command, args, options);
    calls.push(args);
    if (args[0] === 'run') return spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], options);
    assert.equal(args[0], 'rm');
    return spawn(process.execPath, ['-e', `process.exit(${calls.filter(call => call[0] === 'rm').length === 1 ? 1 : 0})`], options);
  });
  delete require.cache[modulePath];
  const isolatedRunner = require('../lib/plugin-process').runPluginProcess;
  require.cache[modulePath] = originalModule;
  const options = fixture(t, '', { sandbox: 'docker', timeoutMs: 80, strict: true });
  try {
    await assert.rejects(isolatedRunner(options), { code: 'PLUGIN_TIMEOUT' });
    const removals = calls.filter(call => call[0] === 'rm');
    assert.equal(removals.length, 2);
    const name = calls[0].find(arg => arg.startsWith('--name=')).slice('--name='.length);
    assert.deepEqual(removals, [['rm', '--force', name], ['rm', '--force', name]]);
  } finally {
    mock.mock.restore();
  }
});

const dockerSmokeSkip = process.env.MAILBRIDGE_TEST_DOCKER === 'true' ? false : 'Set MAILBRIDGE_TEST_DOCKER=true with the pinned image available to run Docker integration tests';

test('real Docker runner enforces its filesystem, identity, environment, and network restrictions', { skip: dockerSmokeSkip }, async (t) => {
  const previous = process.env.MAILBRIDGE_TEST_HOST_SECRET;
  process.env.MAILBRIDGE_TEST_HOST_SECRET = 'synthetic-host-only-value';
  t.after(() => {
    if (previous === undefined) delete process.env.MAILBRIDGE_TEST_HOST_SECRET;
    else process.env.MAILBRIDGE_TEST_HOST_SECRET = previous;
  });
  const options = fixture(t, `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const attemptWrite = target => {
      try { fs.writeFileSync(target, 'synthetic fixture'); return 'allowed'; }
      catch (error) { return error.code; }
    };
    process.stdin.resume();
    process.stdin.once('end', () => {
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const result = {
        uid: process.getuid(),
        rootWrite: attemptWrite('/var/tmp/mailbridge-smoke-write'),
        pluginWrite: attemptWrite(path.join(process.cwd(), 'writable-fixture.txt')),
        temporaryWrite: attemptWrite('/tmp/mailbridge-smoke-write'),
        hostSecretPresent: Object.hasOwn(process.env, 'MAILBRIDGE_TEST_HOST_SECRET'),
        scopedSecretPresent: JSON.parse(process.env.MAILBRIDGE_PLUGIN_SECRETS_JSON).token === 'synthetic-scoped-value',
        capabilities: status.match(/^CapEff:\\s*(\\S+)/m)[1],
        noNewPrivileges: status.match(/^NoNewPrivs:\\s*(\\S+)/m)[1],
        nonLoopbackInterfaces: Object.entries(os.networkInterfaces()).filter(([, addresses]) => addresses.some(address => !address.internal)).map(([name]) => name)
      };
      process.stdout.write(JSON.stringify({ requestId: 'request-1', ok: true, result }) + '\\n');
    });
  `, { sandbox: 'docker', dockerImage: DEFAULT_DOCKER_IMAGE, strict: true, operation: 'health', memoryMb: 128, timeoutMs: 30000, secrets: { token: 'synthetic-scoped-value' } });
  options.releaseDirectory = options.pluginDirectory;
  fs.chmodSync(options.pluginDirectory, 0o755);
  fs.chmodSync(path.join(options.pluginDirectory, 'index.js'), 0o644);
  const writableFixture = path.join(options.pluginDirectory, 'writable-fixture.txt');
  fs.writeFileSync(writableFixture, 'original');
  fs.chmodSync(writableFixture, 0o666);
  const { result } = await runPluginProcess(options);
  assert.equal(result.uid, 65534);
  assert.equal(result.rootWrite, 'EROFS');
  assert.equal(result.pluginWrite, 'EROFS');
  assert.equal(result.temporaryWrite, 'allowed');
  assert.equal(result.hostSecretPresent, false);
  assert.equal(result.scopedSecretPresent, true);
  assert.match(result.capabilities, /^0+$/);
  assert.equal(result.noNewPrivileges, '1');
  assert.deepEqual(result.nonLoopbackInterfaces, []);
  assert.equal(fs.readFileSync(writableFixture, 'utf8'), 'original');
});

test('real Docker timeout removes the named running container', { skip: dockerSmokeSkip }, async (t) => {
  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  let containerName;
  let fixtureStarted = false;
  // Capture the generated container identity while forwarding every operation
  // to the real CLI. No daemon response or process behavior is mocked here.
  const capturedSpawn = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = spawn(command, args, options);
    if (command === 'docker' && args[0] === 'run') {
      containerName = args.find(arg => arg.startsWith('--name=')).slice('--name='.length);
      let diagnostic = '';
      child.stderr.on('data', chunk => {
        diagnostic += chunk.toString();
        fixtureStarted ||= diagnostic.includes('mailbridge-fixture-ready');
      });
    }
    return child;
  });
  const modulePath = require.resolve('../lib/plugin-process');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  const capturedRunner = require('../lib/plugin-process').runPluginProcess;
  require.cache[modulePath] = originalModule;
  const options = fixture(t, `process.stderr.write('mailbridge-fixture-ready\\n'); setInterval(() => {}, 1000);`, {
    sandbox: 'docker', dockerImage: DEFAULT_DOCKER_IMAGE, strict: true, timeoutMs: 5000
  });
  options.releaseDirectory = options.pluginDirectory;
  fs.chmodSync(options.pluginDirectory, 0o755);
  fs.chmodSync(path.join(options.pluginDirectory, 'index.js'), 0o644);
  try {
    await assert.rejects(capturedRunner(options), { code: 'PLUGIN_TIMEOUT' });
    assert.equal(fixtureStarted, true, 'timeout must exercise a running container');
    assert.match(containerName, /^mailbridge-plugin-[0-9a-f-]+$/);
    const remaining = childProcess.spawnSync('docker', ['container', 'ls', '--all', '--filter', `name=${containerName}`, '--format={{.Names}}'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false
    });
    assert.equal(remaining.status, 0, 'Docker must remain reachable to verify cleanup');
    assert.equal(remaining.stdout.trim(), '', 'timed-out container must have been removed');
  } finally {
    capturedSpawn.mock.restore();
    if (containerName) childProcess.spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore', timeout: 10000, windowsHide: true, shell: false });
  }
});
