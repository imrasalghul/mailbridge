// Copyright (c) 2026 Ra's al Ghul

const fs = require('node:fs');
const path = require('node:path');
const { readOptionalFile } = require('./atomic-files');
const { within, assertNoLinks, readRegistry, verifyRecord, mutateRegistry, installVersion } = require('./plugin-install');

const PLUGIN_API_VERSION = 1;
const FORBIDDEN_PLUGIN_SECRET_NAMES = new Set(['QUEUE_MASTER_KEY', 'MAILBRIDGE_PRIVATE_KEY', 'MAILBRIDGE_PRIVATE_KEY_PATH', 'WEBHOOK_SECRET', 'CLOUDFLARE_SEND_WEBHOOK_SECRET', 'CLOUDFLARED_TUNNEL_TOKEN']);
const EXACT_PACKAGE_SPECIFIER = /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;
const PLUGIN_ID = /^[a-z][a-z0-9_-]{1,63}$/;

function assertExactPackageSpecifier(specifier) {
  const value = String(specifier || '').trim();
  if (!EXACT_PACKAGE_SPECIFIER.test(value)) throw new Error('Plugin package must use an exact name@x.y.z version');
  return value;
}

function normalizeManifest(manifest, source = 'plugin', { strict = false } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(source + ': manifest must be an object');
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new Error(source + ': unsupported plugin API version');
  if (!PLUGIN_ID.test(String(manifest.id || ''))) throw new Error(source + ': invalid plugin id');
  if (!['scanner', 'provider', 'middleware'].includes(manifest.type)) throw new Error(source + ': invalid plugin type');
  if (!['fail-open', 'fail-closed'].includes(manifest.failurePolicy)) throw new Error(source + ': invalid failure policy');
  if (typeof manifest.entrypoint !== 'string' || !manifest.entrypoint) throw new Error(source + ': entrypoint is required');
  if (path.isAbsolute(manifest.entrypoint) || manifest.entrypoint.split(/[\\/]/).includes('..')) throw new Error(source + ': entrypoint must stay inside the plugin directory');
  const normalizeFields = (value, label) => {
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, schema]) => [String(key), schema && typeof schema === 'object' ? schema : { type: 'string' }]));
    throw new Error(source + ': ' + label + ' must be an array or schema object');
  };
  const config = normalizeFields(manifest.config, 'config');
  const secrets = normalizeFields(manifest.secrets, 'secrets');
  const secretNames = Array.isArray(secrets) ? secrets : Object.keys(secrets);
  if (secretNames.some(name => FORBIDDEN_PLUGIN_SECRET_NAMES.has(strict ? name.toUpperCase() : name))) throw new Error(source + ': plugin cannot request a protected secret');
  if (strict) {
    for (const fields of [config, secrets]) {
      const names = Array.isArray(fields) ? fields : Object.keys(fields);
      if (names.some(name => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name))) throw new Error(source + ': invalid plugin field name');
      if (new Set(names.map(name => name.toUpperCase())).size !== names.length) throw new Error(source + ': duplicate plugin field namespace');
    }
  }
  return { apiVersion: PLUGIN_API_VERSION, id: manifest.id, version: String(manifest.version || ''), type: manifest.type, failurePolicy: manifest.failurePolicy, priority: Number.isFinite(manifest.priority) ? manifest.priority : 100, entrypoint: manifest.entrypoint, config, secrets, capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [] };
}

function readManifest(pluginDirectory, { strict = false } = {}) {
  if (strict) assertNoLinks(pluginDirectory);
  let parsed;
  try { parsed = JSON.parse(readOptionalFile(path.join(pluginDirectory, 'mailbridge-plugin.json'), 'utf8', { allowSymlinks: !strict })); }
  catch { throw new Error('Plugin manifest is missing, unreadable, or invalid JSON'); }
  const manifest = normalizeManifest(parsed, 'plugin', { strict });
  if (strict) {
    const entrypoint = within(pluginDirectory, manifest.entrypoint);
    assertNoLinks(pluginDirectory, entrypoint);
    if (!fs.statSync(entrypoint).isFile()) throw new Error('Plugin entrypoint must be a regular file');
  }
  return manifest;
}

function runPluginProcess(options) { return require('./plugin-process').runPluginProcess(options); }
function createPluginExecutor(options) { return require('./plugin-process').createPluginExecutor(options); }

function createPluginManager({ pluginDirectory, lockfilePath, strict = false, env = process.env, executor, log = () => {} } = {}) {
  let directory = path.resolve(pluginDirectory || path.join(process.cwd(), 'plugins'));
  if (!strict && fs.existsSync(directory)) directory = fs.realpathSync(directory);
  const lockPath = path.resolve(lockfilePath || path.join(directory, 'plugins.lock.json'));
  const loadLockfile = () => readRegistry(lockPath, { strict }) || { apiVersion: PLUGIN_API_VERSION, plugins: {} };
  const matches = (manifest, { type, capability } = {}) => (!type || manifest.type === type) && (!capability || (manifest.capabilities || []).includes(capability));

  function legacyDirectory(id) {
    if (fs.existsSync(directory)) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.'))) {
        const candidate = path.join(directory, entry.name);
        try { if (readManifest(candidate).id === id) return candidate; } catch { /* Preserve legacy discovery of other valid plugins. */ }
      }
    }
    return within(directory, id);
  }

  function registryPlugin(id, record, verify = strict) {
    if (!PLUGIN_ID.test(id) || !record || typeof record !== 'object') throw new Error('Invalid plugin registry entry');
    const locations = record.directory
      ? (verify ? verifyRecord(directory, record, { allowLegacy: !strict }) : { directory: within(directory, record.directory), releaseDirectory: record.release ? within(directory, record.release) : undefined })
      : { directory: strict ? within(directory, id) : legacyDirectory(id) };
    if (verify && !record.directory) throw new Error('Plugin integrity inventory is missing; reinstall an exact version');
    const manifest = readManifest(locations.directory, { strict: verify && !record.legacySnapshot });
    if (manifest.id !== id || record.version !== manifest.version) throw new Error('Installed plugin identity or version does not match lockfile');
    if (verify && (record.type !== manifest.type || record.failurePolicy !== manifest.failurePolicy || JSON.stringify(record.capabilities) !== JSON.stringify(manifest.capabilities))) throw new Error('Plugin contract does not match its locked metadata');
    return { ...locations, manifest };
  }

  function statuses() {
    let registry;
    try { registry = readRegistry(lockPath, { strict }); }
    catch (error) { return [{ id: '(registry)', enabled: true, error: error.message }]; }
    if (registry) {
      const namespaces = new Map();
      for (const id of Object.keys(registry.plugins)) {
        const namespace = id.replace(/-/g, '_').toUpperCase();
        namespaces.set(namespace, (namespaces.get(namespace) || 0) + 1);
      }
      return Object.entries(registry.plugins).map(([id, record]) => {
        const enabled = record?.enabled !== false;
        const status = { id, enabled, version: record?.version, type: record?.type, capabilities: record?.capabilities || [] };
        try {
          const namespace = id.replace(/-/g, '_').toUpperCase();
          if (strict && namespaces.get(namespace) > 1) throw new Error('Plugin secret namespace collision');
          const plugin = registryPlugin(id, record);
          return { ...status, type: plugin.manifest.type, capabilities: plugin.manifest.capabilities, manifest: plugin.manifest, directory: plugin.directory, releaseDirectory: plugin.releaseDirectory };
        } catch (error) { return { ...status, error: error.message }; }
      });
    }
    if (!fs.existsSync(directory)) return [];
    if (strict) return fs.readdirSync(directory, { withFileTypes: true }).some(item => (!item.name.startsWith('.') || item.name === '.versions') && (item.isDirectory() || item.isSymbolicLink()))
      ? [{ id: '(registry)', enabled: true, error: 'Strict plugin discovery requires an explicit registry lockfile' }] : [];
    return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => {
      try {
        const pluginDirectoryPath = path.join(directory, item.name);
        const manifest = readManifest(pluginDirectoryPath);
        return { id: manifest.id, enabled: true, version: manifest.version, type: manifest.type, capabilities: manifest.capabilities, directory: pluginDirectoryPath, manifest };
      } catch (error) { return { id: item.name, enabled: true, error: error.message }; }
    });
  }

  function discover(scope = {}) {
    const result = [];
    for (const entry of statuses()) {
      if (!entry.enabled) continue;
      // Unknown contract metadata cannot safely be classified as unaffected.
      if ((entry.type || !entry.error) && !matches(entry, scope)) continue;
      if (entry.error) {
        if (strict) throw new Error('Enabled plugin ' + entry.id + ' is unavailable: ' + entry.error);
        log('[Plugin]', 'Ignoring invalid plugin', { id: entry.id, error: entry.error });
      } else result.push({ directory: entry.directory, releaseDirectory: entry.releaseDirectory, manifest: entry.manifest });
    }
    return result;
  }

  function find(id) {
    const plugin = statuses().find(entry => entry.id === id);
    if (!plugin) throw new Error('Plugin is not installed: ' + id);
    if (!plugin.enabled) throw new Error('Plugin is disabled: ' + id);
    if (plugin.error) throw new Error('Plugin ' + id + ' is unavailable: ' + plugin.error);
    return { directory: plugin.directory, releaseDirectory: plugin.releaseDirectory, manifest: plugin.manifest };
  }

  async function invoke(id, operation, payload, options = {}) {
    const plugin = find(id);
    const request = { ...options, pluginDirectory: plugin.directory, releaseDirectory: plugin.releaseDirectory, manifest: plugin.manifest, operation, payload, strict, env, log };
    return executor ? executor.run(request) : runPluginProcess(request);
  }

  function ensureRecord(registry, id) {
    if (!PLUGIN_ID.test(String(id))) throw new Error('Invalid plugin ID');
    if (Object.hasOwn(registry.plugins, id)) return registry.plugins[id];
    if (strict) throw new Error('Plugin is not installed: ' + id);
    const plugin = find(id);
    return registry.plugins[id] = { directory: path.relative(directory, plugin.directory).split(path.sep).join('/'), version: plugin.manifest.version, type: plugin.manifest.type, capabilities: plugin.manifest.capabilities, failurePolicy: plugin.manifest.failurePolicy, enabled: true };
  }

  function initialPlugins() {
    if (strict) return {};
    return Object.fromEntries(statuses().filter(entry => !entry.error).map(entry => {
      let packageName;
      try { packageName = JSON.parse(readOptionalFile(path.join(entry.directory, 'package.json'), 'utf8', { allowSymlinks: true })).name; } catch { /* Loose development plugins need not have package metadata. */ }
      return [entry.id, { directory: path.relative(directory, entry.directory).split(path.sep).join('/'), version: entry.version, type: entry.type, capabilities: entry.capabilities, failurePolicy: entry.manifest.failurePolicy, enabled: true, ...(packageName ? { package: packageName } : {}) }];
    }));
  }

  function setEnabled(id, enabled) {
    return mutateRegistry(directory, lockPath, registry => {
      const record = ensureRecord(registry, id);
      if (enabled) registryPlugin(id, record, strict || Boolean(record.files));
      record.enabled = enabled;
      return { id, enabled };
    }, { strict, initialPlugins });
  }

  function remove(id) {
    return mutateRegistry(directory, lockPath, registry => {
      ensureRecord(registry, id);
      delete registry.plugins[id];
      // Retired trees are retained: a process may still have dependencies to load.
      return { id, removed: true };
    }, { strict, initialPlugins });
  }

  function rollback(id, { validateManifest } = {}) {
    return mutateRegistry(directory, lockPath, registry => {
      const current = ensureRecord(registry, id);
      const [previous, ...older] = current.previous || [];
      if (!previous) throw new Error('Plugin has no previous version: ' + id);
      const plugin = registryPlugin(id, previous, true);
      if (validateManifest) validateManifest(plugin.manifest);
      registry.plugins[id] = { ...previous, enabled: current.enabled !== false, previous: [{ ...current, previous: undefined }, ...older] };
      return { id, version: previous.version };
    }, { strict, initialPlugins });
  }

  const install = (specifier, options = {}) => installVersion(specifier, { ...options, root: directory, lockPath, strict, readManifest, initialPlugins, resolveLegacyDirectory: legacyDirectory, assertSpecifier: assertExactPackageSpecifier, log });
  return { directory, lockfilePath: lockPath, apiVersion: PLUGIN_API_VERSION, discover, status: statuses, list: statuses, find, invoke, loadLockfile, install, upgrade: (specifier, options = {}) => install(specifier, { ...options, upgrade: true }), rollback, enable: id => setEnabled(id, true), disable: id => setEnabled(id, false), remove };
}

function installExactPlugin(specifier, options = {}) { return createPluginManager(options).install(specifier, options); }

module.exports = { PLUGIN_API_VERSION, assertExactPackageSpecifier, createPluginManager, createPluginExecutor, installExactPlugin, normalizeManifest, readManifest, runPluginProcess };
