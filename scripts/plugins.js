#!/usr/bin/env node
// Copyright (c) 2026 Ra's al Ghul

const path = require('node:path');
const crypto = require('node:crypto');
const { parse } = require('dotenv');
const { readOptionalFile } = require('../lib/atomic-files');
const { getCompatibility, getPluginExecutionOptions } = require('../lib/compatibility');
const { pluginEnvironment, loadPluginConfig } = require('../lib/plugin-environment');
const { createPluginManager, createPluginExecutor } = require('../lib/plugin-manager');

const USAGE = 'Usage: npm run plugins -- [--system] list|enable ID|disable ID|test ID|install PACKAGE@VERSION|upgrade PACKAGE@VERSION|rollback ID|remove ID';

async function run(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, output = process.stdout, npmRunner } = {}) {
  const systemMode = argv.includes('--system');
  const args = argv.filter(arg => arg !== '--system');
  const [command, target] = args;
  if (!['list', 'enable', 'disable', 'test', 'install', 'upgrade', 'rollback', 'remove'].includes(command) || args.length !== (command === 'list' ? 1 : 2)) throw new Error(USAGE);
  const configRoot = systemMode ? '/etc/mailbridge' : cwd;
  const envPath = path.join(configRoot, systemMode ? 'mailbridge.env' : '.env');
  // Read through operator-owned links only in the compatibility profile.
  const contents = readOptionalFile(envPath, 'utf8', { allowSymlinks: !getCompatibility(env).strictFileReads });
  const activeEnv = { ...(contents === undefined ? {} : parse(contents)), ...env };
  if (getCompatibility(activeEnv).strictFileReads && contents !== undefined) readOptionalFile(envPath);
  const { pluginStrict: strict } = getCompatibility(activeEnv);
  const hostPath = value => !systemMode && /^\/app\/data(?:\/|$)/.test(value) ? path.join(cwd, 'data', value.slice('/app/data'.length)) : path.resolve(cwd, value);
  const dataDirectory = hostPath(activeEnv.DATA_DIR || (systemMode ? '/var/lib/mailbridge' : path.join(cwd, 'data')));
  const executor = createPluginExecutor(getPluginExecutionOptions(activeEnv));
  const manager = createPluginManager({
    pluginDirectory: hostPath(activeEnv.MAILBRIDGE_PLUGIN_DIR || path.join(dataDirectory, 'plugins')),
    lockfilePath: hostPath(activeEnv.MAILBRIDGE_PLUGIN_LOCKFILE || path.join(systemMode ? configRoot : dataDirectory, 'plugins.lock.json')),
    strict, env: activeEnv, executor
  });
  const print = value => output.write(`${JSON.stringify(value)}\n`);
  const status = id => {
    const entry = manager.status().find(item => item.id === id);
    if (!entry || entry.error) throw new Error(entry?.error || 'Plugin is not installed');
    return entry;
  };
  const environment = manifest => pluginEnvironment(manifest, { env: activeEnv, strict, config: loadPluginConfig(hostPath(activeEnv.MAILBRIDGE_PLUGIN_CONFIG_FILE || path.join(systemMode ? configRoot : dataDirectory, 'plugins.config.json')), { strict }) });
  if (command === 'list') {
    const rows = manager.status().map(({ id, version, type, enabled, error }) => ({ id, version, type, enabled, ...(error ? { error } : {}) }));
    print(rows);
    return rows;
  }
  if (command === 'test') {
    const plugin = status(target);
    let result;
    const scopedEnvironment = environment(plugin.manifest);
    try { result = await executor.run({ pluginDirectory: plugin.directory, releaseDirectory: plugin.releaseDirectory, manifest: plugin.manifest, operation: 'health', payload: { requestId: crypto.randomUUID(), payload: {} }, strict, ...scopedEnvironment }); }
    catch { throw new Error('Plugin health check failed'); }
    if (result.ok !== true) throw new Error('Plugin health check failed');
    print({ id: target, message: 'Plugin health check passed' });
    return { id: target, healthy: true };
  }
  if (command === 'enable') environment(status(target).manifest);
  const result = command === 'install' || command === 'upgrade'
    ? manager[command](target, { ...(npmRunner ? { npmRunner } : {}), ...(command === 'upgrade' ? { validateManifest: environment } : {}) })
    : command === 'rollback' ? manager.rollback(target, { validateManifest: environment }) : manager[command](target);
  print(result.manifest ? { id: result.manifest.id, version: result.manifest.version, enabled: manager.status().find(item => item.id === result.manifest.id)?.enabled } : result);
  return result;
}

if (require.main === module) run().catch(error => {
  // Only host-generated diagnostics reach the terminal; child stderr is never printed.
  process.stderr.write(`Plugin command failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { run };
