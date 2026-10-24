// Copyright (c) 2026 Ra's al Ghul

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

const PLUGIN_API_VERSION = 1;
const DEFAULT_DOCKER_IMAGE = 'node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf';

function safeText(value, maxLength = 512) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, maxLength);
}

function pluginError(manifest, code, detail) {
  return Object.assign(new Error(`Plugin ${safeText(manifest.id, 64)} ${detail}`), { code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateResponse(response, requestId, operation) {
  if (!isObject(response) || response.requestId !== requestId || typeof response.ok !== 'boolean') return false;
  if (response.apiVersion !== undefined && response.apiVersion !== PLUGIN_API_VERSION) return false;
  if (!response.ok) {
    return typeof response.error === 'string' &&
      (response.permanent === undefined || typeof response.permanent === 'boolean') &&
      (response.statusCode === undefined || (Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599));
  }
  const result = response.result;
  if (!isObject(result)) return false;
  if (operation === 'scan') {
    if (result.blocked !== undefined && typeof result.blocked !== 'boolean') return false;
    if (result.spam !== undefined && !['1', '0'].includes(result.spam)) return false;
    if (result.score !== undefined && (typeof result.score !== 'number' || !Number.isFinite(result.score))) return false;
    for (const field of ['reason', 'senderDomain']) {
      if (result[field] !== undefined && typeof result[field] !== 'string') return false;
    }
  }
  if (operation === 'transform') {
    if (!['continue', 'reject'].includes(result.action)) return false;
    for (const field of ['rawEmail', 'from', 'to', 'reason']) {
      if (result[field] !== undefined && typeof result[field] !== 'string') return false;
    }
  }
  return true;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function timerMilliseconds(value, name) {
  nonnegativeInteger(value, name);
  if (value > 2147483647) throw new Error(`${name} must be at most 2147483647`);
}

function validateRunnerOptions({ memoryMb = 0, timeoutMs = 15000, maxPayloadBytes = 64 * 1024 * 1024, maxOutputBytes = 64 * 1024 * 1024, sandbox = 'process', dockerNetwork = 'none', dockerImage = DEFAULT_DOCKER_IMAGE }) {
  nonnegativeInteger(memoryMb, 'memoryMb');
  timerMilliseconds(timeoutMs, 'timeoutMs');
  nonnegativeInteger(maxPayloadBytes, 'maxPayloadBytes');
  nonnegativeInteger(maxOutputBytes, 'maxOutputBytes');
  if (!['process', 'docker'].includes(sandbox)) throw new Error('Unsupported plugin sandbox');
  if (sandbox === 'docker') {
    if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/i.test(dockerImage)) throw new Error('Docker plugin image must be pinned to a SHA-256 digest');
    if (typeof dockerNetwork !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/i.test(dockerNetwork) || ['host', 'container'].includes(dockerNetwork.toLowerCase())) throw new Error('Invalid Docker plugin network');
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function buildPluginCommand({ pluginDirectory, releaseDirectory, releaseRoot, manifest, config = {}, secrets = {}, memoryMb = 0, sandbox = 'process', dockerNetwork = 'none', dockerImage = DEFAULT_DOCKER_IMAGE }) {
  validateRunnerOptions({ memoryMb, sandbox, dockerNetwork, dockerImage });
  const directory = path.resolve(pluginDirectory);
  const entrypoint = path.resolve(directory, manifest.entrypoint);
  if (!inside(directory, entrypoint)) throw new Error('Plugin entrypoint must stay inside the plugin directory');
  const env = {
    PATH: process.env.PATH || '',
    NODE_ENV: 'production',
    MAILBRIDGE_PLUGIN_ID: manifest.id,
    MAILBRIDGE_PLUGIN_API_VERSION: String(PLUGIN_API_VERSION),
    MAILBRIDGE_PLUGIN_CONFIG_JSON: JSON.stringify(config),
    MAILBRIDGE_PLUGIN_SECRETS_JSON: JSON.stringify(secrets)
  };
  const heapArgs = memoryMb > 0 ? [`--max-old-space-size=${memoryMb}`] : [];
  const options = { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false };
  if (sandbox === 'process') return { command: process.execPath, args: [...heapArgs, entrypoint], options };
  const root = fs.realpathSync(releaseDirectory || releaseRoot || directory);
  const realDirectory = fs.realpathSync(directory);
  const realEntrypoint = fs.realpathSync(entrypoint);
  if (!inside(root, realDirectory) || !inside(root, realEntrypoint)) throw new Error('Plugin paths must stay inside the release directory');
  if (/[\u0000-\u001f,"\r\n]/.test(root)) throw new Error('Plugin release directory cannot be represented as a Docker bind mount');
  const containerPath = target => path.posix.join('/plugin', path.relative(root, target).split(path.sep).join('/'));
  const containerName = `mailbridge-plugin-${randomUUID()}`;
  const containerMemory = Math.max(256, memoryMb * 2);
  const args = [
    'run', '--rm', '--interactive', '--init', `--name=${containerName}`, '--pull=never', '--log-driver=none',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    `--network=${dockerNetwork}`, '--pids-limit=64', '--cpus=1', `--memory=${containerMemory}m`, `--memory-swap=${containerMemory}m`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m', '--mount', `type=bind,src=${root},dst=/plugin,readonly`,
    `--workdir=${containerPath(realDirectory)}`
  ];
  for (const name of Object.keys(env).filter(name => name !== 'PATH')) args.push('--env', name);
  args.push('--entrypoint=node', dockerImage, ...heapArgs, containerPath(realEntrypoint));
  // The trusted Docker CLI needs its host configuration. Only named plugin
  // variables above are forwarded to the container; values never enter argv.
  return { command: 'docker', args, containerName, options: { ...options, env: { ...process.env, ...env } } };
}

function cleanupCommand(command, args, env) {
  return new Promise(resolve => {
    const helper = spawn(command, args, { env, stdio: 'ignore', windowsHide: true, shell: false });
    const timer = setTimeout(() => { helper.kill('SIGKILL'); resolve(false); }, 5000);
    helper.once('error', () => { clearTimeout(timer); resolve(false); });
    helper.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function terminateProcessTree(child, plan) {
  if (!child.pid) return true;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await cleanupCommand(taskkill, ['/PID', String(child.pid), '/T', '/F'], process.env);
    child.kill('SIGKILL');
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  if (plan.containerName) {
    // Stop the client first, then remove the named container. A daemon can be
    // finishing creation when cancellation arrives, so retry a failed removal.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await cleanupCommand(plan.command, ['rm', '--force', plan.containerName], plan.options.env)) return true;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  return true;
}

// A process boundary and a V8 heap limit are not an OS security sandbox.
function runPluginProcess({ pluginDirectory, manifest, operation, payload, config = {}, secrets = {}, timeoutMs = 15000, maxPayloadBytes = 64 * 1024 * 1024, maxOutputBytes = 64 * 1024 * 1024, strict = false, memoryMb = 0, log = () => {}, signal, sandbox = 'process', dockerImage, dockerNetwork, releaseDirectory, releaseRoot }) {
  return new Promise((resolve, reject) => {
    const error = (code, detail) => pluginError(manifest, code, detail);
    let plan;
    try {
      validateRunnerOptions({ timeoutMs, maxPayloadBytes, maxOutputBytes, memoryMb, sandbox, dockerImage, dockerNetwork });
      plan = buildPluginCommand({ pluginDirectory, manifest, config, secrets, memoryMb, sandbox, dockerImage, dockerNetwork, releaseDirectory, releaseRoot });
    } catch (cause) {
      return reject(strict ? error('PLUGIN_CONFIG', 'has invalid execution configuration') : cause);
    }
    const requestLine = `${JSON.stringify({ apiVersion: PLUGIN_API_VERSION, operation, requestId: payload.requestId, payload: payload.payload || null })}\n`;
    if (Buffer.byteLength(requestLine) > maxPayloadBytes) return reject(error('PLUGIN_PAYLOAD_LIMIT', 'payload exceeds limit'));
    if (signal?.aborted) return reject(error('PLUGIN_CLOSED', 'execution was cancelled'));
    const child = spawn(plan.command, plan.args, plan.options);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopping = false;
    let childClosed = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (strict && childClosed && !stopping && !plan.containerName && process.platform !== 'win32') {
        // POSIX groups survive their leader. On Windows a finished parent's PID
        // may be reused; taskkill must only target it while still alive. Only
        // an OS sandbox can contain work deliberately detached from its group.
        terminateProcessTree(child, plan).then(() => fn(value), () => reject(error('PLUGIN_CLEANUP', 'could not confirm execution cleanup')));
      } else fn(value);
    };
    const stop = (value) => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      const cleanupFailed = () => finish(reject, error('PLUGIN_CLEANUP', 'could not confirm execution cleanup'));
      terminateProcessTree(child, plan).then(cleaned => cleaned ? finish(reject, value) : cleanupFailed(), cleanupFailed);
    };
    const onAbort = () => stop(error('PLUGIN_CLOSED', 'execution was cancelled'));
    const timer = setTimeout(() => stop(error('PLUGIN_TIMEOUT', `timed out during ${safeText(operation, 64)}`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (settled || stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) return stop(error('PLUGIN_OUTPUT_LIMIT', 'output exceeds limit'));
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Strict execution discards stderr: it can contain message bodies and secrets.
      if (strict || settled || stopping) return;
      const remaining = Math.max(0, maxOutputBytes - stderrBytes);
      stderrBytes += Math.min(remaining, chunk.length);
      stderr += stderrDecoder.write(chunk.subarray(0, remaining));
    });
    child.once('error', (cause) => stop(strict ? error('PLUGIN_START', 'could not start') : cause));
    child.stdin.on('error', (cause) => stop(error('PLUGIN_INPUT', `input failed: ${safeText(cause.code || 'stream closed', 64)}`)));
    child.once('close', (code) => {
      childClosed = true;
      if (settled || stopping) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (code !== 0) return finish(reject, error('PLUGIN_EXIT', `exited with code ${code}${!strict && stderr.trim() ? `: ${safeText(stderr.trim(), maxOutputBytes)}` : ''}`));
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length !== 1) return finish(reject, error('PLUGIN_PROTOCOL', 'returned an invalid protocol response'));
      let response;
      try {
        response = JSON.parse(lines[0]);
        if (response?.requestId !== payload.requestId) throw new Error('request ID mismatch');
      } catch (cause) {
        return finish(reject, error('PLUGIN_PROTOCOL', strict ? 'returned an invalid protocol response' : `returned invalid JSON: ${safeText(cause.message)}`));
      }
      if (strict && !validateResponse(response, payload.requestId, operation)) return finish(reject, error('PLUGIN_PROTOCOL', 'returned an invalid protocol response'));
      if (strict && !response.ok) {
        // The host logs failure text; arbitrary plugin error strings are untrusted.
        response = { ...response, error: `Plugin ${safeText(manifest.id, 64)} reported failure` };
      }
      finish(resolve, response);
    });
    log('[Plugin]', 'Invoking plugin', { id: safeText(manifest.id, 64), operation: safeText(operation, 64), requestId: safeText(payload.requestId, 128) });
    child.stdin.end(requestLine);
  });
}

function createPluginExecutor({ maxConcurrent = 0, maxPending = 100, maxWaitMs = 15000, ...defaults } = {}) {
  nonnegativeInteger(maxConcurrent, 'maxConcurrent');
  nonnegativeInteger(maxPending, 'maxPending');
  timerMilliseconds(maxWaitMs, 'maxWaitMs');
  validateRunnerOptions(defaults);
  const pending = [];
  const active = new Set();
  const health = new Map();
  let closed = false;

  function stats(id) {
    if (!health.has(id)) health.set(id, { active: 0, pending: 0, succeeded: 0, failed: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null });
    return health.get(id);
  }

  function failure(record, code) {
    record.failed++;
    record.lastFailureAt = new Date().toISOString();
    record.lastErrorCode = /^PLUGIN_[A-Z_]+$/.test(code || '') ? code : 'PLUGIN_FAILURE';
  }

  function drain() {
    while (!closed && pending.length && (!maxConcurrent || active.size < maxConcurrent)) start(pending.shift());
  }

  function start(job) {
    clearTimeout(job.timer);
    job.options.signal?.removeEventListener('abort', job.onAbort);
    if (job.queued) job.record.pending--;
    job.record.active++;
    active.add(job);
    job.work = runPluginProcess({ ...defaults, ...job.options, signal: job.options.signal ? AbortSignal.any([job.options.signal, job.controller.signal]) : job.controller.signal })
      .then(response => {
        if (response.ok === false) failure(job.record, 'PLUGIN_REPORTED_FAILURE');
        else {
          job.record.succeeded++;
          job.record.lastSuccessAt = new Date().toISOString();
        }
        return response;
      }, error => {
        failure(job.record, error.code);
        throw error;
      })
      .finally(() => {
        active.delete(job);
        job.record.active--;
        drain();
      });
    job.work.then(job.resolve, job.reject);
  }

  function run(options) {
    return new Promise((resolve, reject) => {
      options = { ...defaults, ...options };
      const record = stats(safeText(options.manifest.id, 64));
      const deny = (code, detail) => { failure(record, code); reject(pluginError(options.manifest, code, detail)); };
      if (closed) return deny('PLUGIN_CLOSED', 'executor is closed');
      if (options.signal?.aborted) return deny('PLUGIN_CLOSED', 'execution was cancelled');
      if (maxConcurrent && active.size >= maxConcurrent && pending.length >= maxPending) return deny('PLUGIN_QUEUE_FULL', 'execution queue is full');
      const job = { options, resolve, reject, record, controller: new AbortController(), queued: false };
      if (!maxConcurrent || active.size < maxConcurrent) return start(job);
      job.queued = true;
      record.pending++;
      pending.push(job);
      const removePending = (code, detail) => {
        const index = pending.indexOf(job);
        if (index === -1) return;
        pending.splice(index, 1);
        clearTimeout(job.timer);
        options.signal?.removeEventListener('abort', job.onAbort);
        record.pending--;
        deny(code, detail);
      };
      job.onAbort = () => removePending('PLUGIN_CLOSED', 'execution was cancelled');
      options.signal?.addEventListener('abort', job.onAbort, { once: true });
      if (maxWaitMs) job.timer = setTimeout(() => removePending('PLUGIN_QUEUE_TIMEOUT', 'waited too long for execution'), maxWaitMs);
    });
  }

  function status() {
    return { active: active.size, pending: pending.length, plugins: Object.fromEntries([...health].map(([id, record]) => [id, { ...record }])) };
  }

  async function close() {
    closed = true;
    for (const job of pending.splice(0)) {
      clearTimeout(job.timer);
      job.options.signal?.removeEventListener('abort', job.onAbort);
      job.record.pending--;
      failure(job.record, 'PLUGIN_CLOSED');
      job.reject(pluginError(job.options.manifest, 'PLUGIN_CLOSED', 'executor is closed'));
    }
    const jobs = [...active];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.work));
  }

  return { run, status, close };
}

module.exports = { DEFAULT_DOCKER_IMAGE, buildPluginCommand, runPluginProcess, createPluginExecutor };
