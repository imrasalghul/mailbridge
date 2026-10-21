#!/usr/bin/env node
// Copyright (c) 2026 Ra's al Ghul

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { parse: parseEnv } = require('dotenv');
const { createPluginManager, assertExactPackageSpecifier } = require('../lib/plugin-manager');
const { readOptionalFile, writeFileAtomic } = require('../lib/atomic-files');
const { getCompatibility, booleanSetting } = require('../lib/compatibility');

const WRANGLER_PACKAGE = 'wrangler@4.151.3';

function envValue(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:@,+\-[\]]*$/.test(text)) return text;
  // Use the common subset of dotenv, systemd EnvironmentFile, and Compose:
  // double quotes without escapes/interpolation, or literal single quotes.
  // Backtick delimiters and escaped newlines are not portable.
  const candidates = [];
  if (!/[\u0000-\u0008\u000B-\u001F\u007F\uFEFF]/.test(text) && text.isWellFormed()) {
    if (!/["\\$\n`]/.test(text)) candidates.push(`"${text}"`);
    if (!text.includes("'") && !text.endsWith('\\')) candidates.push(`'${text}'`);
  }
  for (const candidate of candidates) {
    const serialized = `VALUE=${candidate}\nBOUNDARY=unchanged\n`;
    if ([false, true].every(fast => {
      const parsed = parseEnv(serialized, { fast });
      return Object.keys(parsed).length === 2 && parsed.VALUE === text && parsed.BOUNDARY === 'unchanged';
    })) return candidate;
  }
  throw new Error('Environment value cannot be represented safely across dotenv, systemd, and Docker Compose');
}

function tomlValue(value) {
  return JSON.stringify(String(value ?? ''));
}

function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { privateKey, publicKey };
}

function configuredHostPath(configuredPath, runtimeDefault, hostDefault, cwd, { dataDirectory, keyDirectory, systemMode } = {}) {
  if (!configuredPath || path.normalize(configuredPath) === path.normalize(runtimeDefault)) return hostDefault;
  if (!systemMode) {
    const normalized = configuredPath.replaceAll('\\', '/');
    for (const [prefix, hostPath] of [['/app/data', dataDirectory], ['/app/secrets', keyDirectory]]) {
      if (hostPath && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
        return path.resolve(hostPath, normalized.slice(prefix.length + 1));
      }
    }
  }
  return path.resolve(cwd, configuredPath);
}

function publicKeyFromPrivateFile(privatePath, fileOptions) {
  try {
    const contents = readOptionalFile(privatePath, 'utf8', fileOptions);
    if (!contents) throw new Error('Missing private key');
    const privateKey = crypto.createPrivateKey(contents);
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Expected an RSA private key');
    return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  } catch {
    throw new Error('Configured Mailbridge private key is missing, unreadable, or invalid; restore the pair before running setup');
  }
}

function loadKeyPair(privatePath, publicPath, fileOptions) {
  const publicKey = publicKeyFromPrivateFile(privatePath, fileOptions);
  const existingPublicKey = readOptionalFile(publicPath, 'utf8', fileOptions);
  if (!existingPublicKey) throw new Error('Only one Mailbridge key file exists; restore the pair before running setup');
  if (crypto.createPublicKey(existingPublicKey).export({ type: 'spki', format: 'pem' }) !== publicKey) {
    throw new Error('Mailbridge key files do not match; restore the pair before running setup');
  }
  return { publicKey };
}

function createOrLoadKeyPair(keyDirectory, fileOptions) {
  fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  const privatePath = path.join(keyDirectory, 'mailbridge-r2-private.pem');
  const publicPath = path.join(keyDirectory, 'mailbridge-r2-public.pem');
  let privateDescriptor;
  try {
    privateDescriptor = fs.openSync(privatePath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadKeyPair(privatePath, publicPath, fileOptions);
  }
  let publicDescriptor;
  let complete = false;
  try {
    try {
      publicDescriptor = fs.openSync(publicPath, 'wx', 0o644);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Only one Mailbridge key file exists; restore the pair before running setup');
      throw error;
    }
    const keys = generateKeyPair();
    fs.writeFileSync(privateDescriptor, keys.privateKey);
    fs.fsyncSync(privateDescriptor);
    fs.writeFileSync(publicDescriptor, keys.publicKey);
    fs.fsyncSync(publicDescriptor);
    complete = true;
    return { publicKey: keys.publicKey };
  } finally {
    fs.closeSync(privateDescriptor);
    if (publicDescriptor !== undefined) fs.closeSync(publicDescriptor);
    if (!complete) {
      fs.unlinkSync(privatePath);
      if (publicDescriptor !== undefined) fs.unlinkSync(publicPath);
    }
  }
}

function runCommand(command, args, { cwd, input, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => output.write(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      output.write(chunk);
    });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.end(input ? `${input}\n` : undefined);
  });
}

async function deployWorker({ cwd, npxCommand, artifacts, output }) {
  const configArgs = ['--yes', WRANGLER_PACKAGE, '--config', path.join(cwd, 'wrangler.toml')];
  const ensureResource = async (args, label) => {
    try {
      await runCommand(npxCommand, [...configArgs, ...args], { cwd, output });
    } catch (error) {
      if (/already exists|already taken|already configured/i.test(error.message)) {
        output.write(`${label} already exists; keeping the existing resource.\n`);
        return;
      }
      throw error;
    }
  };

  output.write('\nCreating or verifying Cloudflare resources...\n');
  await ensureResource(['r2', 'bucket', 'create', artifacts.r2BucketName], `R2 bucket ${artifacts.r2BucketName}`);
  await ensureResource(['queues', 'create', artifacts.queueName], `Queue ${artifacts.queueName}`);
  if (artifacts.deadLetterQueueName) await ensureResource(['queues', 'create', artifacts.deadLetterQueueName], `Dead-letter queue ${artifacts.deadLetterQueueName}`);
  output.write('Deploying the Worker and uploading generated Worker secrets...\n');
  await runCommand(npxCommand, [...configArgs, 'secret', 'put', 'WEBHOOK_SECRET'], {
    cwd,
    input: artifacts.webhookSecret,
    output
  });
  await runCommand(npxCommand, [...configArgs, 'secret', 'put', 'CLOUDFLARE_SEND_WEBHOOK_SECRET'], {
    cwd,
    input: artifacts.cloudflareSendSecret,
    output
  });
  await runCommand(npxCommand, [...configArgs, 'secret', 'put', 'MAILBRIDGE_PUBLIC_KEY_PEM'], {
    cwd,
    input: artifacts.publicKey,
    output
  });
  await runCommand(npxCommand, [...configArgs, 'deploy'], { cwd, output });
}

function generateArtifacts(config, generated = {}) {
  const compatibility = getCompatibility({ ...config.existingEnvironment, MAILBRIDGE_BEHAVIOR_PROFILE: config.behaviorProfile || config.existingEnvironment?.MAILBRIDGE_BEHAVIOR_PROFILE || (config.existingEnvironment ? 'legacy' : 'modern') });
  const deadLetterQueueEnabled = config.deadLetterQueueEnabled ?? booleanSetting(config.existingEnvironment || {}, 'MAILBRIDGE_DEAD_LETTER_QUEUE', compatibility.modern);
  const deadLetterQueueName = deadLetterQueueEnabled ? config.deadLetterQueueName || `${config.queueName}-dead-letter` : undefined;
  const queueMasterKey = generated.queueMasterKey || crypto.randomBytes(32).toString('base64');
  const webhookSecret = generated.webhookSecret || crypto.randomBytes(48).toString('base64');
  const cloudflareSendSecret = generated.cloudflareSendSecret || crypto.randomBytes(48).toString('base64');
  const env = {
    PORT: 3090,
    SMTP_RELAY_PORT: 2525,
    SMTP_RELAY_SOCKET_TIMEOUT_MS: 120000,
    SMTP_RELAY_MAX_MESSAGE_BYTES: 52428800,
    MAILBRIDGE_VERBOSE_LOGGING: true,
    MAILBRIDGE_HOSTNAME: config.hostname,
    MAILBRIDGE_BEHAVIOR_PROFILE: compatibility.profile,
    QUEUE_MAX_ATTEMPTS: 20,
    DATA_DIR: config.dataDir || '/app/data',
    SECRETS_DB_PATH: config.secretsDbPath || '/app/secrets/secrets.db',
    MAILBRIDGE_PLUGIN_DIR: config.pluginDirectory || '/app/data/plugins',
    MAILBRIDGE_PLUGIN_LOCKFILE: config.pluginLockfile || '/app/data/plugins.lock.json',
    MAILBRIDGE_PLUGIN_CONFIG_FILE: config.pluginConfigFile || '/app/data/plugins.config.json',
    QUEUE_MASTER_KEY: queueMasterKey,
    MAILBRIDGE_PRIVATE_KEY_PATH: config.privateKeyPath || '/app/secrets/mailbridge-r2-private.pem',
    AUDIT_LOG_RETENTION_DAYS: 1,
    CLOUDFLARED_ENABLED: config.cloudflaredEnabled,
    CLOUDFLARED_TUNNEL_TOKEN: config.cloudflareTunnelToken || '',
    CLOUDFLARED_LOGLEVEL: 'info',
    WEBHOOK_SECRET: webhookSecret,
    LOCAL_MAIL_HOST: config.localMailHost,
    LOCAL_MAIL_PORT: config.localMailPort,
    LOCAL_MAIL_SECURE: false,
    LOCAL_MAIL_REQUIRE_TLS: config.localMailRequireTls,
    LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED: true,
    LOCAL_MAIL_TLS_SERVERNAME: config.localMailTlsServername || '',
    LOCAL_MAIL_TLS_CA_FILE: config.localMailTlsCaFile || '',
    RELAY_UPSTREAM_PROVIDER: config.upstreamProvider,
    RELAY_FROM_FALLBACK: config.relayFrom,
    CLOUDFLARE_SEND_WORKER_URL: config.workerSendUrl || '',
    CLOUDFLARE_SEND_WEBHOOK_SECRET: cloudflareSendSecret,
    SMTP_RELAY_ENABLED: config.smtpRelayEnabled,
    SMTP_RELAY_VERBOSE_LOGGING: true,
    SMTP_RELAY_INJECT_HEADERS: true,
    SMTP_RELAY_REQUIRE_TLS: config.smtpRelayRequireTls,
    SMTP_RELAY_ALLOW_INSECURE: config.smtpRelayAllowInsecure,
    SMTP_RELAY_ALLOWED_CIDRS: config.allowedCidrs,
    SMTP_RELAY_TLS_CERT_FILE: config.smtpRelayTlsCertFile || '',
    SMTP_RELAY_TLS_KEY_FILE: config.smtpRelayTlsKeyFile || '',
    SMTP_RELAY_TLS_CA_FILE: config.smtpRelayTlsCaFile || '',
    SPAMASSASSIN_MODE: config.spamAssassinMode,
    POSTMARK_SPAMCHECK_URL: 'https://spamcheck.postmarkapp.com/filter',
    SPAMD_HOST: '127.0.0.1',
    SPAMD_PORT: 783,
    SPAMD_STARTUP_ATTEMPTS: 30,
    SPAMC_TIMEOUT_MS: 10000,
    SPAMC_FAIL_OPEN: false,
    SA_BLOCK_THRESHOLD: 12,
    SA_QUESTIONABLE_THRESHOLD: 5,
    SPAM_SCL_SCORE: 9,
    SPAM_SUBJECT_TAG: '[SPAM]',
    ...(config.pluginSecretEnvironment || {})
  };
  const configuredKeys = new Set([
    'MAILBRIDGE_HOSTNAME', 'MAILBRIDGE_BEHAVIOR_PROFILE', 'QUEUE_MASTER_KEY', 'WEBHOOK_SECRET', 'CLOUDFLARE_SEND_WEBHOOK_SECRET',
    'CLOUDFLARED_ENABLED', 'CLOUDFLARED_TUNNEL_TOKEN', 'LOCAL_MAIL_HOST', 'LOCAL_MAIL_PORT',
    'LOCAL_MAIL_REQUIRE_TLS', 'LOCAL_MAIL_TLS_SERVERNAME', 'LOCAL_MAIL_TLS_CA_FILE',
    'RELAY_UPSTREAM_PROVIDER', 'RELAY_FROM_FALLBACK', 'CLOUDFLARE_SEND_WORKER_URL',
    'SMTP_RELAY_ENABLED', 'SMTP_RELAY_REQUIRE_TLS', 'SMTP_RELAY_ALLOW_INSECURE',
    'SMTP_RELAY_ALLOWED_CIDRS', 'SMTP_RELAY_TLS_CERT_FILE', 'SMTP_RELAY_TLS_KEY_FILE',
    'SMTP_RELAY_TLS_CA_FILE', 'SPAMASSASSIN_MODE', ...Object.keys(config.pluginSecretEnvironment || {})
  ]);
  for (const [name, value] of Object.entries(config.existingEnvironment || {})) {
    if (!configuredKeys.has(name)) env[name] = value;
  }

  const sections = [
    ['Node App Configuration', ['PORT', 'SMTP_RELAY_PORT', 'SMTP_RELAY_SOCKET_TIMEOUT_MS', 'SMTP_RELAY_MAX_MESSAGE_BYTES', 'MAILBRIDGE_VERBOSE_LOGGING', 'MAILBRIDGE_HOSTNAME', 'QUEUE_MAX_ATTEMPTS', 'DATA_DIR', 'SECRETS_DB_PATH', 'MAILBRIDGE_PLUGIN_DIR', 'MAILBRIDGE_PLUGIN_LOCKFILE', 'MAILBRIDGE_PLUGIN_CONFIG_FILE', 'QUEUE_MASTER_KEY', 'MAILBRIDGE_PRIVATE_KEY_PATH', 'AUDIT_LOG_RETENTION_DAYS']],
    ['Optional in-container Cloudflare Tunnel', ['CLOUDFLARED_ENABLED', 'CLOUDFLARED_TUNNEL_TOKEN', 'CLOUDFLARED_LOGLEVEL']],
    ['Shared Worker Authentication', ['WEBHOOK_SECRET']],
    ['Local Mail Server Configuration', ['LOCAL_MAIL_HOST', 'LOCAL_MAIL_PORT', 'LOCAL_MAIL_SECURE', 'LOCAL_MAIL_REQUIRE_TLS', 'LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED', 'LOCAL_MAIL_TLS_SERVERNAME', 'LOCAL_MAIL_TLS_CA_FILE']],
    ['Outbound Relay Provider Configuration', ['RELAY_UPSTREAM_PROVIDER', 'RELAY_FROM_FALLBACK', 'CLOUDFLARE_SEND_WORKER_URL', 'CLOUDFLARE_SEND_WEBHOOK_SECRET']],
    ['SMTP Relay', ['SMTP_RELAY_ENABLED', 'SMTP_RELAY_VERBOSE_LOGGING', 'SMTP_RELAY_INJECT_HEADERS', 'SMTP_RELAY_REQUIRE_TLS', 'SMTP_RELAY_ALLOW_INSECURE', 'SMTP_RELAY_ALLOWED_CIDRS', 'SMTP_RELAY_TLS_CERT_FILE', 'SMTP_RELAY_TLS_KEY_FILE', 'SMTP_RELAY_TLS_CA_FILE']],
    ['Spam Filtering', ['SPAMASSASSIN_MODE', 'POSTMARK_SPAMCHECK_URL', 'SPAMD_HOST', 'SPAMD_PORT', 'SPAMD_STARTUP_ATTEMPTS', 'SPAMC_TIMEOUT_MS', 'SPAMC_FAIL_OPEN', 'SA_BLOCK_THRESHOLD', 'SA_QUESTIONABLE_THRESHOLD', 'SPAM_SCL_SCORE', 'SPAM_SUBJECT_TAG']],
    ['Plugin Settings', Object.keys(config.pluginSecretEnvironment || {})]
  ];
  const sectionKeys = new Set(sections.flatMap(([, keys]) => keys));
  sections.push(['Additional Settings', Object.keys(env).filter(name => !sectionKeys.has(name))]);
  let envText;
  if (!compatibility.modern && config.existingEnvText !== undefined) {
    const updates = Object.entries(env).filter(([name, value]) => config.existingEnvironment?.[name] !== String(value ?? ''));
    envText = config.existingEnvText + (config.existingEnvText.endsWith('\n') ? '' : '\n')
      + updates.map(([name, value]) => `${name}=${envValue(value)}\n`).join('');
    const reparsed = parseEnv(envText);
    if (Object.entries(env).some(([name, value]) => reparsed[name] !== String(value ?? ''))) throw new Error('Existing environment text cannot safely accept updated settings');
  } else {
    envText = sections.map(([label, keys]) => `# ${label}\n${keys.map((key) => `${key}=${envValue(env[key])}`).join('\n')}`).join('\n\n') + '\n';
  }
  const workerSettings = ['MAILBRIDGE_BEHAVIOR_PROFILE', 'MAILBRIDGE_HTTP_ALLOW_REDIRECTS', 'MAILBRIDGE_HTTP_TIMEOUT_MS']
    .filter(name => env[name] !== undefined).map(name => `${name} = ${tomlValue(env[name])}\n`).join('');
  const deadLetterBinding = deadLetterQueueName ? `dead_letter_queue = ${tomlValue(deadLetterQueueName)}\n` : '';
  const wranglerText = `name = ${tomlValue(config.workerName)}\nmain = ${tomlValue(config.workerMain || 'worker.js')}\ncompatibility_date = ${tomlValue(config.compatibilityDate || '2026-10-21')}\npreview_urls = false\n\n[vars]\nNODE_APP_URL = ${tomlValue(`https://${config.hostname}/api/webhook/email`)}\nMAIL_STORE_ENCRYPTION_VERSION = "v1"\n${workerSettings}\n[[r2_buckets]]\nbinding = "MAIL_STORE"\nbucket_name = ${tomlValue(config.r2BucketName)}\n\n[[queues.producers]]\nbinding = "MAIL_QUEUE"\nqueue = ${tomlValue(config.queueName)}\n\n[[queues.consumers]]\nqueue = ${tomlValue(config.queueName)}\nmax_batch_size = 10\nmax_batch_timeout = 5\nmax_retries = 3\n${deadLetterBinding}\n[[send_email]]\nname = "EMAIL"\n`;

  return { envText, wranglerText, queueMasterKey, webhookSecret, cloudflareSendSecret, publicKey: generated.publicKey || '', r2BucketName: config.r2BucketName, queueName: config.queueName, deadLetterQueueName };
}

async function runSetup({
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  envFileName = '.env',
  keyDirectory = path.join(cwd, 'secrets'),
  dataDirectory = path.join(cwd, 'data'),
  runtimePaths = {},
  pluginDirectory = path.join(dataDirectory, 'plugins'),
  pluginLockfile = path.join(dataDirectory, 'plugins.lock.json'),
  systemMode = false
} = {}) {
  const rl = readline.createInterface({ input, output });
  const ask = async (label, defaultValue = '') => {
    const answer = (await rl.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim();
    return answer || defaultValue;
  };
  const askBoolean = async (label, defaultValue) => {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${label} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return ['y', 'yes', 'true', '1'].includes(answer);
  };
  const askChoice = async (label, choices, defaultValue) => {
    while (true) {
      const answer = (await ask(`${label} (${choices.join('/')})`, defaultValue)).toLowerCase();
      if (choices.includes(answer)) return answer;
      output.write(`Choose one of: ${choices.join(', ')}\n`);
    }
  };

  try {
    const targets = [envFileName, 'wrangler.toml'].map((name) => path.join(cwd, name));
    // Read the profile before enforcing its opt-in path policy.
    const existingEnvText = readOptionalFile(targets[0], 'utf8', { allowSymlinks: true });
    const existingEnv = existingEnvText === undefined ? {} : parseEnv(existingEnvText);
    const compatibility = getCompatibility(existingEnvText === undefined ? { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern' } : existingEnv);
    const readOptions = { allowSymlinks: !compatibility.strictFileReads };
    const writeOptions = { followSymlinks: !compatibility.strictFileReads };
    if (compatibility.strictFileReads) readOptionalFile(targets[0], 'utf8', readOptions);
    const existingWranglerText = readOptionalFile(targets[1], 'utf8', readOptions);
    const existingContents = [existingEnvText, existingWranglerText];
    const existing = targets.filter((target, index) => existingContents[index] !== undefined);
    if (compatibility.modern) Object.values(existingEnv).forEach(envValue);
    const priorWorkerValue = (name) => existingWranglerText?.match(new RegExp(`^[ \\t]*${name}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1];
    const compatibilityDate = priorWorkerValue('compatibility_date');
    const priorDeadLetterQueue = priorWorkerValue('dead_letter_queue');
    const deadLetterQueueEnabled = booleanSetting(existingEnv, 'MAILBRIDGE_DEAD_LETTER_QUEUE', existingEnvText === undefined || Boolean(priorDeadLetterQueue));
    const existingBoolean = (name, fallback) => booleanSetting(existingEnv, name, fallback);
    const pathMapping = { dataDirectory, keyDirectory, systemMode };
    const hostPath = (configured, runtimeDefault, hostDefault) => configuredHostPath(configured, runtimeDefault, hostDefault, cwd, pathMapping);
    const activeDataDirectory = hostPath(existingEnv.DATA_DIR, runtimePaths.dataDir || '/app/data', dataDirectory);
    const runtimeDataDirectory = existingEnv.DATA_DIR || runtimePaths.dataDir || '/app/data';
    const runtimePluginDirectory = existingEnv.MAILBRIDGE_PLUGIN_DIR || (systemMode ? pluginDirectory : `${runtimeDataDirectory}/plugins`);
    const runtimePluginLockfile = existingEnv.MAILBRIDGE_PLUGIN_LOCKFILE || (systemMode ? pluginLockfile : `${runtimeDataDirectory}/plugins.lock.json`);
    const runtimePluginConfigFile = existingEnv.MAILBRIDGE_PLUGIN_CONFIG_FILE || (systemMode ? path.join(path.dirname(pluginLockfile), 'plugins.config.json') : `${runtimeDataDirectory}/plugins.config.json`);
    const activePluginDirectory = hostPath(runtimePluginDirectory, '/app/data/plugins', pluginDirectory);
    const activePluginLockfile = hostPath(runtimePluginLockfile, '/app/data/plugins.lock.json', pluginLockfile);
    const pluginConfigPath = hostPath(runtimePluginConfigFile, '/app/data/plugins.config.json', path.join(dataDirectory, 'plugins.config.json'));
    const pluginManager = createPluginManager({
      pluginDirectory: activePluginDirectory,
      lockfilePath: activePluginLockfile,
      strict: compatibility.pluginStrict,
      log: (scope, message, details) => output.write(`${scope} ${message} ${JSON.stringify(details)}\n`)
    });
    const emptyPluginDirectory = !fs.existsSync(activePluginDirectory) || fs.readdirSync(activePluginDirectory).length === 0;
    const installedPlugins = emptyPluginDirectory && !fs.existsSync(activePluginLockfile) ? [] : pluginManager.discover();
    const installedProviders = installedPlugins.filter(plugin => plugin.manifest.type === 'provider').map(plugin => plugin.manifest.id);
    output.write(`\nMailbridge interactive setup${systemMode ? ' (system package)' : ''}\nPress Enter to accept the value shown in brackets.\n\n`);
    const hostname = await ask('Public Mailbridge hostname', existingEnv.MAILBRIDGE_HOSTNAME || 'mailbridge.example.com');
    const workerName = await ask('Cloudflare Worker name', priorWorkerValue('name') || 'mailbridge-worker');
    const localMailHost = await ask('Local/private SMTP host', existingEnv.LOCAL_MAIL_HOST || 'mail.internal.example');
    const localMailPort = Number.parseInt(await ask('Local/private SMTP port', existingEnv.LOCAL_MAIL_PORT || '25'), 10);
    if (!Number.isInteger(localMailPort) || localMailPort < 1 || localMailPort > 65535) throw new Error('SMTP port must be between 1 and 65535');
    const localMailRequireTls = await askBoolean('Require STARTTLS for local mail delivery', existingBoolean('LOCAL_MAIL_REQUIRE_TLS', true));
    const localMailTlsServername = localMailRequireTls ? await ask('TLS server name (blank uses SMTP host)', existingEnv.LOCAL_MAIL_TLS_SERVERNAME || '') : '';
    const pathContext = systemMode ? 'on this host' : 'inside container';
    const localMailTlsCaFile = localMailRequireTls ? await ask(`Custom CA file ${pathContext} (optional)`, existingEnv.LOCAL_MAIL_TLS_CA_FILE || '') : '';
    const spamAssassinMode = await askChoice('Spam filtering mode', ['local', 'postmark'], existingEnv.SPAMASSASSIN_MODE || 'local');
    const providerChoices = [...new Set(['sendgrid', 'resend', 'mailgun', 'cloudflare', 'community', ...installedProviders])];
    let upstreamProvider = await askChoice('Outbound provider', providerChoices, providerChoices.includes(existingEnv.RELAY_UPSTREAM_PROVIDER) ? existingEnv.RELAY_UPSTREAM_PROVIDER : 'cloudflare');
    if (existing.length && !await askBoolean(`Overwrite ${existing.map((file) => path.basename(file)).join(' and ')}`, false)) {
      output.write('No files changed.\n');
      return { written: false };
    }
    const queueDirectory = path.join(activeDataDirectory, 'queue');
    if (!existingEnv.QUEUE_MASTER_KEY) {
      let queueFiles = [];
      try { queueFiles = fs.readdirSync(queueDirectory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (queueFiles.some(name => name.endsWith('.eml'))) throw new Error('Existing queued mail requires its original QUEUE_MASTER_KEY. Restore the configuration before rerunning setup.');
    }
    const defaultPrivateKeyPath = path.join(keyDirectory, 'mailbridge-r2-private.pem');
    const activePrivateKeyPath = hostPath(existingEnv.MAILBRIDGE_PRIVATE_KEY_PATH, runtimePaths.privateKeyPath || '/app/secrets/mailbridge-r2-private.pem', defaultPrivateKeyPath);
    const usesCustomPrivateKey = path.resolve(activePrivateKeyPath) !== path.resolve(defaultPrivateKeyPath);
    const publicKeyPath = path.join(keyDirectory, usesCustomPrivateKey ? 'mailbridge-active-public.pem' : 'mailbridge-r2-public.pem');
    const activeKeys = existingEnv.MAILBRIDGE_PRIVATE_KEY_PATH
      ? (usesCustomPrivateKey ? { publicKey: publicKeyFromPrivateFile(activePrivateKeyPath, readOptions) } : loadKeyPair(activePrivateKeyPath, publicKeyPath, readOptions))
      : null;
    const selectedPlugins = [];
    const pluginConfigurationContents = readOptionalFile(pluginConfigPath, 'utf8', readOptions);
    const pluginConfiguration = pluginConfigurationContents === undefined ? {} : JSON.parse(pluginConfigurationContents);
    const pluginSecretEnvironment = Object.fromEntries(Object.entries(existingEnv).filter(([name]) => /^MAILBRIDGE_PLUGIN_/.test(name) && !['MAILBRIDGE_PLUGIN_DIR', 'MAILBRIDGE_PLUGIN_LOCKFILE', 'MAILBRIDGE_PLUGIN_CONFIG_FILE'].includes(name)));
    const promptPluginSchema = async (installed) => {
      const fields = installed.manifest.config;
      const names = Array.isArray(fields) ? fields : Object.keys(fields || {});
      const values = {};
      for (const name of names) {
        const schema = Array.isArray(fields) ? {} : (fields[name] || {});
        values[name] = await ask(`${installed.manifest.id} ${name}`, pluginConfiguration[installed.manifest.id]?.[name] ?? schema.default ?? '');
      }
      if (names.length) pluginConfiguration[installed.manifest.id] = values;
      const secretFields = installed.manifest.secrets;
      const secretNames = Array.isArray(secretFields) ? secretFields : Object.keys(secretFields || {});
      const prefix = `MAILBRIDGE_PLUGIN_${installed.manifest.id.toUpperCase().replace(/-/g, '_')}_`;
      for (const name of secretNames) pluginSecretEnvironment[`${prefix}${name}`] = await ask(`${installed.manifest.id} ${name} (secret; blank keeps existing)`, '') || pluginSecretEnvironment[`${prefix}${name}`] || '';
    };
    const installSelectedPlugin = async (label, defaultSpecifier) => {
      if (!await askBoolean(`Enable ${label} plugin`, false)) return;
      const specifier = assertExactPackageSpecifier(await ask(`Exact npm package/version for ${label}`, defaultSpecifier));
      const installed = pluginManager.install(specifier);
      await promptPluginSchema(installed);
      selectedPlugins.push(installed.manifest.id);
    };
    await installSelectedPlugin('Spamhaus', '');
    await installSelectedPlugin('Codex AI scanning', '');
    if (['sendgrid', 'resend', 'mailgun'].includes(upstreamProvider) && !installedProviders.includes(upstreamProvider)) {
      const pluginName = upstreamProvider[0].toUpperCase() + upstreamProvider.slice(1);
      const providerSpecifier = assertExactPackageSpecifier(await ask(`Exact npm package/version for ${pluginName}`));
      const installed = pluginManager.install(providerSpecifier);
      if (installed.manifest.type !== 'provider' || installed.manifest.id !== upstreamProvider) throw new Error(`${providerSpecifier} does not declare the requested ${upstreamProvider} provider`);
      await promptPluginSchema(installed);
      upstreamProvider = installed.manifest.id;
      selectedPlugins.push(installed.manifest.id);
    } else if (upstreamProvider === 'community') {
      const specifier = assertExactPackageSpecifier(await ask('Exact npm package/version for provider plugin'));
      const installed = pluginManager.install(specifier);
      if (installed.manifest.type !== 'provider') throw new Error(`${specifier} is not a provider plugin`);
      await promptPluginSchema(installed);
      upstreamProvider = installed.manifest.id;
      selectedPlugins.push(installed.manifest.id);
    }
    while (await askBoolean('Install an additional community plugin', false)) {
      const specifier = assertExactPackageSpecifier(await ask('Exact npm package/version for community plugin'));
      const installed = pluginManager.install(specifier);
      await promptPluginSchema(installed);
      selectedPlugins.push(installed.manifest.id);
    }
    const relayFrom = await ask('Fallback outbound From address', existingEnv.RELAY_FROM_FALLBACK || `postmaster@${hostname}`);
    const workerSendUrl = upstreamProvider === 'cloudflare' ? await ask('Deployed Worker send URL', existingEnv.CLOUDFLARE_SEND_WORKER_URL || '') : '';
    const smtpRelayEnabled = await askBoolean('Enable the trusted outbound SMTP relay', existingBoolean('SMTP_RELAY_ENABLED', false));
    const allowedCidrs = smtpRelayEnabled ? await ask('Allowed relay CIDRs', existingEnv.SMTP_RELAY_ALLOWED_CIDRS || '127.0.0.1/32,::1/128') : '127.0.0.1/32,::1/128';
    let smtpRelayRequireTls = true;
    let smtpRelayAllowInsecure = false;
    let smtpRelayTlsCertFile = '';
    let smtpRelayTlsKeyFile = '';
    let smtpRelayTlsCaFile = '';
    if (smtpRelayEnabled) {
      smtpRelayRequireTls = await askBoolean('Require STARTTLS for relay clients', existingBoolean('SMTP_RELAY_REQUIRE_TLS', true));
      if (smtpRelayRequireTls) {
        smtpRelayTlsCertFile = await ask(`Relay TLS certificate file ${pathContext}`, existingEnv.SMTP_RELAY_TLS_CERT_FILE || '');
        smtpRelayTlsKeyFile = await ask(`Relay TLS private-key file ${pathContext}`, existingEnv.SMTP_RELAY_TLS_KEY_FILE || '');
        smtpRelayTlsCaFile = await ask(`Relay TLS CA file ${pathContext} (optional)`, existingEnv.SMTP_RELAY_TLS_CA_FILE || '');
        if (!smtpRelayTlsCertFile || !smtpRelayTlsKeyFile) throw new Error('Relay TLS certificate and key paths are required when STARTTLS is required');
      } else {
        smtpRelayAllowInsecure = await askBoolean('Explicitly allow plaintext relay traffic', existingBoolean('SMTP_RELAY_ALLOW_INSECURE', false));
        if (!smtpRelayAllowInsecure) throw new Error('Relay setup stopped: enable STARTTLS or explicitly allow plaintext relay traffic');
      }
    }
    const cloudflaredEnabled = systemMode ? false : await askBoolean('Run an in-container Cloudflare Tunnel', existingBoolean('CLOUDFLARED_ENABLED', false));
    const cloudflareTunnelToken = cloudflaredEnabled ? (await ask('Cloudflare Tunnel token (blank keeps existing)') || existingEnv.CLOUDFLARED_TUNNEL_TOKEN || '') : '';
    if (cloudflaredEnabled && !cloudflareTunnelToken) throw new Error('A tunnel token is required when the in-container tunnel is enabled');
    const r2BucketName = await ask('R2 bucket name', priorWorkerValue('bucket_name') || 'mailbridge-inbound');
    const queueName = await ask('Cloudflare Queue name', priorWorkerValue('queue') || 'mailbridge-inbound');

    const artifacts = generateArtifacts({ hostname, workerName, localMailHost, localMailPort, localMailRequireTls, localMailTlsServername, localMailTlsCaFile, spamAssassinMode, upstreamProvider, relayFrom, workerSendUrl, smtpRelayEnabled, allowedCidrs, smtpRelayRequireTls, smtpRelayAllowInsecure, smtpRelayTlsCertFile, smtpRelayTlsKeyFile, smtpRelayTlsCaFile, cloudflaredEnabled, cloudflareTunnelToken, r2BucketName, queueName,
      pluginDirectory: runtimePluginDirectory, pluginLockfile: runtimePluginLockfile, pluginConfigFile: runtimePluginConfigFile,
      pluginSecretEnvironment, existingEnvironment: existingEnv, existingEnvText, behaviorProfile: compatibility.profile,
      compatibilityDate, deadLetterQueueEnabled, deadLetterQueueName: priorDeadLetterQueue, ...runtimePaths }, {
      queueMasterKey: existingEnv.QUEUE_MASTER_KEY,
      webhookSecret: existingEnv.WEBHOOK_SECRET,
      cloudflareSendSecret: existingEnv.CLOUDFLARE_SEND_WEBHOOK_SECRET || existingEnv.WEBHOOK_SECRET,
      publicKey: activeKeys?.publicKey || ''
    });
    const keys = activeKeys || createOrLoadKeyPair(keyDirectory, readOptions);
    artifacts.publicKey = keys.publicKey;
    if (usesCustomPrivateKey) {
      fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
      writeFileAtomic(publicKeyPath, keys.publicKey, 0o644, writeOptions);
    }
    fs.mkdirSync(path.dirname(pluginConfigPath), { recursive: true, mode: 0o700 });
    writeFileAtomic(pluginConfigPath, `${JSON.stringify(pluginConfiguration, null, 2)}\n`, 0o644, writeOptions);
    fs.mkdirSync(queueDirectory, { recursive: true, mode: 0o700 });
    writeFileAtomic(targets[0], artifacts.envText, 0o600, writeOptions);
    writeFileAtomic(targets[1], artifacts.wranglerText, 0o600, writeOptions);
    if (compatibility.pluginStrict && readOptionalFile(activePluginLockfile, 'utf8', readOptions) === undefined) {
      fs.mkdirSync(path.dirname(activePluginLockfile), { recursive: true, mode: 0o750 });
      writeFileAtomic(activePluginLockfile, `${JSON.stringify({ apiVersion: 1, plugins: {} }, null, 2)}\n`, 0o644, writeOptions);
    }
    for (const id of new Set(selectedPlugins)) pluginManager.enable(id);

    const npxCommand = systemMode ? '/opt/mailbridge/node/bin/npx' : 'npx';
    output.write(`\nConfiguration generated. Secrets were written to ${envFileName}.\n`);
    if (selectedPlugins.length) output.write(`Installed plugins: ${selectedPlugins.join(', ')}\n`);
    const deployAutomatically = await askBoolean('Deploy the Cloudflare Worker automatically now', false);
    if (deployAutomatically) {
      try {
        await deployWorker({ cwd, npxCommand, artifacts, output });
        output.write('Worker deployed successfully.\n');
      } catch (error) {
        output.write(`Automatic Worker deployment failed: ${error.message}\n`);
        output.write('The generated configuration is preserved. Use the manual commands below.\n');
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} r2 bucket create ${r2BucketName}\n`);
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} queues create ${queueName}\n`);
        if (artifacts.deadLetterQueueName) output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} queues create ${artifacts.deadLetterQueueName}\n`);
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put WEBHOOK_SECRET\n`);
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put CLOUDFLARE_SEND_WEBHOOK_SECRET\n`);
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put MAILBRIDGE_PUBLIC_KEY_PEM < ${publicKeyPath}\n`);
        output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} deploy\n`);
      }
    } else {
      output.write(`\nWorker deployment skipped. Read webhook secrets privately from ${envFileName} when Wrangler prompts; the private key stays on this host.\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put WEBHOOK_SECRET\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put CLOUDFLARE_SEND_WEBHOOK_SECRET\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} secret put MAILBRIDGE_PUBLIC_KEY_PEM < ${publicKeyPath}\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} r2 bucket create ${r2BucketName}\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} queues create ${queueName}\n`);
      if (artifacts.deadLetterQueueName) output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} queues create ${artifacts.deadLetterQueueName}\n`);
      output.write(`  ${npxCommand} --yes ${WRANGLER_PACKAGE} deploy\n`);
    }
    output.write(systemMode ? '  systemctl enable --now mailbridge\n' : '  docker compose up -d --build\n');
    return { written: true, ...artifacts };
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  const systemMode = process.argv.includes('--system');
  if (systemMode && typeof process.getuid === 'function' && process.getuid() !== 0) {
    process.stderr.write('\nSetup failed: --system must be run as root\n');
    process.exitCode = 1;
  } else runSetup(systemMode ? {
    cwd: '/etc/mailbridge',
    envFileName: 'mailbridge.env',
    keyDirectory: '/etc/mailbridge/keys',
    dataDirectory: '/var/lib/mailbridge',
    pluginDirectory: '/var/lib/mailbridge/plugins',
    pluginLockfile: '/etc/mailbridge/plugins.lock.json',
    runtimePaths: {
      dataDir: '/var/lib/mailbridge',
      secretsDbPath: '/var/lib/mailbridge/secrets.db',
      privateKeyPath: '/etc/mailbridge/keys/mailbridge-r2-private.pem',
      workerMain: '/opt/mailbridge/app/worker.js'
    },
    systemMode: true
  } : {}).catch((error) => {
    process.stderr.write(`\nSetup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  envValue,
  generateArtifacts,
  generateKeyPair,
  deployWorker,
  runSetup,
  tomlValue
};
