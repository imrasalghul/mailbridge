// Copyright (c) 2026 Ra's al Ghul

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN_API_VERSION = 1;
const FORBIDDEN_PLUGIN_SECRET_NAMES = new Set(['QUEUE_MASTER_KEY', 'MAILBRIDGE_PRIVATE_KEY', 'MAILBRIDGE_PRIVATE_KEY_PATH', 'WEBHOOK_SECRET', 'CLOUDFLARE_SEND_WEBHOOK_SECRET', 'CLOUDFLARED_TUNNEL_TOKEN']);
const EXACT_PACKAGE_SPECIFIER = /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;

function assertExactPackageSpecifier(specifier) {
  const value = String(specifier || '').trim();
  if (!EXACT_PACKAGE_SPECIFIER.test(value)) {
    throw new Error(`Plugin package must use an exact name@x.y.z version: ${value || '<empty>'}`);
  }
  return value;
}

function normalizeManifest(manifest, source = 'plugin') {
  if (!manifest || typeof manifest !== 'object') throw new Error(`${source}: manifest must be an object`);
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new Error(`${source}: unsupported plugin API version`);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(String(manifest.id || ''))) throw new Error(`${source}: invalid plugin id`);
  if (!['scanner', 'provider', 'middleware'].includes(manifest.type)) throw new Error(`${source}: invalid plugin type`);
  if (!['fail-open', 'fail-closed'].includes(manifest.failurePolicy)) throw new Error(`${source}: invalid failure policy`);
  if (typeof manifest.entrypoint !== 'string' || !manifest.entrypoint) throw new Error(`${source}: entrypoint is required`);
  if (path.isAbsolute(manifest.entrypoint) || manifest.entrypoint.split(/[\\/]/).includes('..')) throw new Error(`${source}: entrypoint must stay inside the plugin directory`);
  const normalizeFields = (value, label) => {
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, schema]) => [String(key), schema && typeof schema === 'object' ? schema : { type: 'string' }]));
    throw new Error(`${source}: ${label} must be an array or schema object`);
  };
  const config = normalizeFields(manifest.config, 'config');
  const secrets = normalizeFields(manifest.secrets, 'secrets');
  const secretNames = Array.isArray(secrets) ? secrets : Object.keys(secrets);
  const forbiddenSecret = secretNames.find((name) => FORBIDDEN_PLUGIN_SECRET_NAMES.has(name));
  if (forbiddenSecret) throw new Error(`${source}: plugin cannot request protected secret ${forbiddenSecret}`);
  return {
    apiVersion: PLUGIN_API_VERSION,
    id: manifest.id,
    version: String(manifest.version || ''),
    type: manifest.type,
    failurePolicy: manifest.failurePolicy,
    priority: Number.isFinite(manifest.priority) ? manifest.priority : 100,
    entrypoint: manifest.entrypoint,
    config,
    secrets,
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : []
  };
}

function readManifest(pluginDirectory) {
  const manifestPath = path.join(pluginDirectory, 'mailbridge-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return normalizeManifest(manifest, manifestPath);
}

function packageNameFromSpecifier(specifier) {
  const at = specifier.lastIndexOf('@');
  return specifier.slice(0, at);
}

function installExactPlugin(specifier, { pluginDirectory, lockfilePath, npmCommand = 'npm', log = () => {} } = {}) {
  const exactSpecifier = assertExactPackageSpecifier(specifier);
  const packageName = packageNameFromSpecifier(exactSpecifier);
  const root = path.resolve(pluginDirectory || path.join(process.cwd(), 'plugins'));
  const lockPath = path.resolve(lockfilePath || path.join(root, 'plugins.lock.json'));
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-plugin-install-'));
  try {
    const result = spawnSync(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true', '--prefix', staging, exactSpecifier], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) throw new Error(`Plugin installation failed: ${(result.stderr || result.stdout || '').trim()}`);
    const packageRoot = path.join(staging, 'node_modules', packageName);
    const expectedVersion = exactSpecifier.slice(exactSpecifier.lastIndexOf('@') + 1);
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (packageMetadata.name !== packageName || packageMetadata.version !== expectedVersion) throw new Error(`Installed package metadata does not match ${exactSpecifier}`);
    const manifest = readManifest(packageRoot);
    if (manifest.version !== expectedVersion) throw new Error(`Plugin manifest version ${manifest.version} does not match ${expectedVersion}`);
    const target = path.join(root, manifest.id);
    if (fs.existsSync(target)) throw new Error(`Plugin is already installed: ${manifest.id}`);
    fs.mkdirSync(target, { recursive: true, mode: 0o750 });
    fs.cpSync(packageRoot, target, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
    fs.cpSync(path.join(staging, 'node_modules'), path.join(target, 'node_modules'), { recursive: true });
    const packageLock = JSON.parse(fs.readFileSync(path.join(staging, 'package-lock.json'), 'utf8'));
    const integrity = packageLock.packages?.[`node_modules/${packageName}`]?.integrity || null;
    if (!integrity) throw new Error(`npm did not provide integrity metadata for ${exactSpecifier}`);
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : { apiVersion: PLUGIN_API_VERSION, plugins: {} };
    if (lock.apiVersion !== PLUGIN_API_VERSION || typeof lock.plugins !== 'object') throw new Error('Invalid Mailbridge plugin lockfile');
    lock.plugins[manifest.id] = { package: packageName, version: expectedVersion, integrity, source: 'npm', installedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o640 });
    log('[Plugin]', 'Installed plugin', { id: manifest.id, version: expectedVersion });
    return { directory: target, manifest, integrity };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function runPluginProcess({ pluginDirectory, manifest, operation, payload, config = {}, secrets = {}, timeoutMs = 15000, maxPayloadBytes = 64 * 1024 * 1024, maxOutputBytes = 64 * 1024 * 1024, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const entrypoint = path.resolve(pluginDirectory, manifest.entrypoint);
    const requestLine = `${JSON.stringify({ apiVersion: PLUGIN_API_VERSION, operation, requestId: payload.requestId, payload: payload.payload || null })}\n`;
    if (Buffer.byteLength(requestLine) > maxPayloadBytes) return reject(new Error(`Plugin ${manifest.id} payload exceeds limit`));
    const child = spawn(process.execPath, [entrypoint], {
      cwd: pluginDirectory,
      env: {
        PATH: process.env.PATH || '',
        NODE_ENV: 'production',
        MAILBRIDGE_PLUGIN_ID: manifest.id,
        MAILBRIDGE_PLUGIN_API_VERSION: String(PLUGIN_API_VERSION),
        MAILBRIDGE_PLUGIN_CONFIG_JSON: JSON.stringify(config),
        MAILBRIDGE_PLUGIN_SECRETS_JSON: JSON.stringify(secrets)
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Plugin ${manifest.id} timed out during ${operation}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(reject, new Error(`Plugin ${manifest.id} output exceeds limit`));
      }
    });
    child.stderr.on('data', (chunk) => { if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk.toString(); });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`Plugin ${manifest.id} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length !== 1) return finish(reject, new Error(`Plugin ${manifest.id} returned an invalid protocol response`));
      try {
        const response = JSON.parse(lines[0]);
        if (response?.requestId !== payload.requestId) throw new Error('request ID mismatch');
        finish(resolve, response);
      } catch (error) {
        finish(reject, new Error(`Plugin ${manifest.id} returned invalid JSON: ${error.message}`));
      }
    });
    log('[Plugin]', 'Invoking plugin', { id: manifest.id, operation, requestId: payload.requestId });
    child.stdin.end(requestLine);
  });
}

function createPluginManager({ pluginDirectory, lockfilePath, log = () => {} } = {}) {
  const directory = path.resolve(pluginDirectory || path.join(process.cwd(), 'plugins'));
  const lockPath = path.resolve(lockfilePath || path.join(directory, 'plugins.lock.json'));

  function discover() {
    if (!fs.existsSync(directory)) return [];
    const lock = fs.existsSync(lockPath) ? loadLockfile() : null;
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const pluginDirectoryPath = path.join(directory, entry.name);
        try {
          const manifest = readManifest(pluginDirectoryPath);
          if (lock) {
            const locked = lock.plugins[manifest.id];
            if (!locked) throw new Error('plugin is not present in the lockfile');
            if (locked.version !== manifest.version) throw new Error(`installed version ${manifest.version} does not match lockfile version ${locked.version}`);
          }
          return { directory: pluginDirectoryPath, manifest };
        } catch (error) {
          log('[Plugin]', 'Ignoring invalid plugin', { directory: pluginDirectoryPath, error: error.message });
          return null;
        }
      })
      .filter(Boolean);
  }

  function find(id) {
    const plugin = discover().find((entry) => entry.manifest.id === id);
    if (!plugin) throw new Error(`Plugin is not installed: ${id}`);
    return plugin;
  }

  async function invoke(id, operation, payload, options = {}) {
    const plugin = find(id);
    return runPluginProcess({ ...options, pluginDirectory: plugin.directory, manifest: plugin.manifest, operation, payload, log });
  }

  function loadLockfile() {
    if (!fs.existsSync(lockPath)) return { apiVersion: PLUGIN_API_VERSION, plugins: {} };
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.apiVersion !== PLUGIN_API_VERSION || !lock.plugins || typeof lock.plugins !== 'object') throw new Error('Invalid Mailbridge plugin lockfile');
    return lock;
  }

  function remove(id) {
    const plugin = find(id);
    const relative = path.relative(directory, plugin.directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing to remove plugin outside ${directory}`);
    fs.rmSync(plugin.directory, { recursive: true, force: false });
    const lock = loadLockfile();
    delete lock.plugins[id];
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o750 });
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o640 });
    return { id, removed: true };
  }

  return {
    directory,
    lockfilePath: lockPath,
    discover,
    find,
    install: (specifier, options = {}) => installExactPlugin(specifier, { ...options, pluginDirectory: directory, lockfilePath: lockPath, log }),
    remove,
    invoke,
    loadLockfile,
    apiVersion: PLUGIN_API_VERSION
  };
}

module.exports = {
  PLUGIN_API_VERSION,
  assertExactPackageSpecifier,
  createPluginManager,
  installExactPlugin,
  normalizeManifest,
  readManifest,
  runPluginProcess
};
