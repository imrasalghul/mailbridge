#!/usr/bin/env node
// Copyright (c) 2026 Ra's al Ghul

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

function envValue(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:@,+\-[\]]*$/.test(text) ? text : JSON.stringify(text);
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
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.end(input ? `${input}\n` : undefined);
  });
}

async function deployWorker({ cwd, npxCommand, artifacts, output }) {
  const configArgs = ['--yes', 'wrangler', '--config', path.join(cwd, 'wrangler.toml')];
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
    QUEUE_MAX_ATTEMPTS: 20,
    DATA_DIR: config.dataDir || '/app/data',
    SECRETS_DB_PATH: config.secretsDbPath || '/app/secrets/secrets.db',
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
    RELAY_API_KEY: '',
    RELAY_FROM_FALLBACK: config.relayFrom,
    RESEND_BASE_URL: 'https://api.resend.com',
    MAILGUN_DOMAIN: config.mailgunDomain || '',
    MAILGUN_BASE_URL: 'https://api.mailgun.net',
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
    SPAMHAUS_ENABLED: false,
    SPAMHAUS_USERNAME: '',
    SPAMHAUS_PASSWORD: '',
    SPAMHAUS_FAIL_OPEN: true,
    AI_ENABLED: false,
    AI_API_KEY: '',
    AI_MODEL: 'gpt-5.4-nano',
    AI_BASE_URL: '',
    AI_INPUT_SCOPE: 'headers',
    AI_MAX_INPUT_CHARS: 20000
  };

  const sections = [
    ['Node App Configuration', ['PORT', 'SMTP_RELAY_PORT', 'SMTP_RELAY_SOCKET_TIMEOUT_MS', 'SMTP_RELAY_MAX_MESSAGE_BYTES', 'MAILBRIDGE_VERBOSE_LOGGING', 'MAILBRIDGE_HOSTNAME', 'QUEUE_MAX_ATTEMPTS', 'DATA_DIR', 'SECRETS_DB_PATH', 'QUEUE_MASTER_KEY', 'MAILBRIDGE_PRIVATE_KEY_PATH', 'AUDIT_LOG_RETENTION_DAYS']],
    ['Optional in-container Cloudflare Tunnel', ['CLOUDFLARED_ENABLED', 'CLOUDFLARED_TUNNEL_TOKEN', 'CLOUDFLARED_LOGLEVEL']],
    ['Shared Worker Authentication', ['WEBHOOK_SECRET']],
    ['Local Mail Server Configuration', ['LOCAL_MAIL_HOST', 'LOCAL_MAIL_PORT', 'LOCAL_MAIL_SECURE', 'LOCAL_MAIL_REQUIRE_TLS', 'LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED', 'LOCAL_MAIL_TLS_SERVERNAME', 'LOCAL_MAIL_TLS_CA_FILE']],
    ['Outbound Relay Provider Configuration', ['RELAY_UPSTREAM_PROVIDER', 'RELAY_API_KEY', 'RELAY_FROM_FALLBACK', 'RESEND_BASE_URL', 'MAILGUN_DOMAIN', 'MAILGUN_BASE_URL', 'CLOUDFLARE_SEND_WORKER_URL', 'CLOUDFLARE_SEND_WEBHOOK_SECRET']],
    ['SMTP Relay', ['SMTP_RELAY_ENABLED', 'SMTP_RELAY_VERBOSE_LOGGING', 'SMTP_RELAY_INJECT_HEADERS', 'SMTP_RELAY_REQUIRE_TLS', 'SMTP_RELAY_ALLOW_INSECURE', 'SMTP_RELAY_ALLOWED_CIDRS', 'SMTP_RELAY_TLS_CERT_FILE', 'SMTP_RELAY_TLS_KEY_FILE', 'SMTP_RELAY_TLS_CA_FILE']],
    ['Spam Filtering', ['SPAMASSASSIN_MODE', 'POSTMARK_SPAMCHECK_URL', 'SPAMD_HOST', 'SPAMD_PORT', 'SPAMD_STARTUP_ATTEMPTS', 'SPAMC_TIMEOUT_MS', 'SPAMC_FAIL_OPEN', 'SA_BLOCK_THRESHOLD', 'SA_QUESTIONABLE_THRESHOLD', 'SPAM_SCL_SCORE', 'SPAM_SUBJECT_TAG']],
    ['Optional Spamhaus Intelligence API', ['SPAMHAUS_ENABLED', 'SPAMHAUS_USERNAME', 'SPAMHAUS_PASSWORD', 'SPAMHAUS_FAIL_OPEN']],
    ['Optional AI Secondary Screening', ['AI_ENABLED', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_INPUT_SCOPE', 'AI_MAX_INPUT_CHARS']]
  ];
  const envText = sections.map(([label, keys]) => `# ${label}\n${keys.map((key) => `${key}=${envValue(env[key])}`).join('\n')}`).join('\n\n') + '\n';
  const wranglerText = `name = ${tomlValue(config.workerName)}\nmain = ${tomlValue(config.workerMain || 'worker.js')}\ncompatibility_date = "2026-05-19"\npreview_urls = false\n\n[vars]\nNODE_APP_URL = ${tomlValue(`https://${config.hostname}/api/webhook/email`)}\nMAIL_STORE_ENCRYPTION_VERSION = "v1"\n\n[[r2_buckets]]\nbinding = "MAIL_STORE"\nbucket_name = ${tomlValue(config.r2BucketName)}\n\n[[queues.producers]]\nbinding = "MAIL_QUEUE"\nqueue = ${tomlValue(config.queueName)}\n\n[[queues.consumers]]\nqueue = ${tomlValue(config.queueName)}\nmax_batch_size = 10\nmax_batch_timeout = 5\nmax_retries = 3\n\n[[send_email]]\nname = "EMAIL"\n`;

  return { envText, wranglerText, queueMasterKey, webhookSecret, cloudflareSendSecret, publicKey: generated.publicKey || '', r2BucketName: config.r2BucketName, queueName: config.queueName };
}

async function runSetup({
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  envFileName = '.env',
  keyDirectory = path.join(cwd, 'secrets'),
  dataDirectory = path.join(cwd, 'data'),
  runtimePaths = {},
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
    output.write(`\nMailbridge interactive setup${systemMode ? ' (system package)' : ''}\nPress Enter to accept the value shown in brackets.\n\n`);
    const hostname = await ask('Public Mailbridge hostname', 'mailbridge.example.com');
    const workerName = await ask('Cloudflare Worker name', 'mailbridge-worker');
    const localMailHost = await ask('Local/private SMTP host', 'mail.internal.example');
    const localMailPort = Number.parseInt(await ask('Local/private SMTP port', '25'), 10);
    if (!Number.isInteger(localMailPort) || localMailPort < 1 || localMailPort > 65535) throw new Error('SMTP port must be between 1 and 65535');
    const localMailRequireTls = await askBoolean('Require STARTTLS for local mail delivery', true);
    const localMailTlsServername = localMailRequireTls ? await ask('TLS server name (blank uses SMTP host)', '') : '';
    const pathContext = systemMode ? 'on this host' : 'inside container';
    const localMailTlsCaFile = localMailRequireTls ? await ask(`Custom CA file ${pathContext} (optional)`, '') : '';
    const spamAssassinMode = await askChoice('Spam filtering mode', ['local', 'postmark'], 'local');
    const upstreamProvider = await askChoice('Outbound provider', ['sendgrid', 'resend', 'mailgun', 'cloudflare'], 'sendgrid');
    const relayFrom = await ask('Fallback outbound From address', `postmaster@${hostname}`);
    const mailgunDomain = upstreamProvider === 'mailgun' ? await ask('Mailgun sending domain') : '';
    const workerSendUrl = upstreamProvider === 'cloudflare' ? await ask('Deployed Worker send URL') : '';
    const smtpRelayEnabled = await askBoolean('Enable the trusted outbound SMTP relay', false);
    const allowedCidrs = smtpRelayEnabled ? await ask('Allowed relay CIDRs', '127.0.0.1/32,::1/128') : '127.0.0.1/32,::1/128';
    let smtpRelayRequireTls = true;
    let smtpRelayAllowInsecure = false;
    let smtpRelayTlsCertFile = '';
    let smtpRelayTlsKeyFile = '';
    let smtpRelayTlsCaFile = '';
    if (smtpRelayEnabled) {
      smtpRelayRequireTls = await askBoolean('Require STARTTLS for relay clients', true);
      if (smtpRelayRequireTls) {
        smtpRelayTlsCertFile = await ask(`Relay TLS certificate file ${pathContext}`);
        smtpRelayTlsKeyFile = await ask(`Relay TLS private-key file ${pathContext}`);
        smtpRelayTlsCaFile = await ask(`Relay TLS CA file ${pathContext} (optional)`, '');
        if (!smtpRelayTlsCertFile || !smtpRelayTlsKeyFile) throw new Error('Relay TLS certificate and key paths are required when STARTTLS is required');
      } else {
        smtpRelayAllowInsecure = await askBoolean('Explicitly allow plaintext relay traffic', false);
        if (!smtpRelayAllowInsecure) throw new Error('Relay setup stopped: enable STARTTLS or explicitly allow plaintext relay traffic');
      }
    }
    const cloudflaredEnabled = systemMode ? false : await askBoolean('Run an in-container Cloudflare Tunnel', false);
    const cloudflareTunnelToken = cloudflaredEnabled ? await ask('Cloudflare Tunnel token') : '';
    if (cloudflaredEnabled && !cloudflareTunnelToken) throw new Error('A tunnel token is required when the in-container tunnel is enabled');
    const r2BucketName = await ask('R2 bucket name', 'mailbridge-inbound');
    const queueName = await ask('Cloudflare Queue name', 'mailbridge-inbound');

    const targets = [envFileName, 'wrangler.toml'].map((name) => path.join(cwd, name));
    const existing = targets.filter((target) => fs.existsSync(target));
    if (existing.length && !await askBoolean(`Overwrite ${existing.map((file) => path.basename(file)).join(' and ')}`, false)) {
      output.write('No files changed.\n');
      return { written: false };
    }

    const keyDir = keyDirectory;
    const privateKeyPath = path.join(keyDir, 'mailbridge-r2-private.pem');
    const publicKeyPath = path.join(keyDir, 'mailbridge-r2-public.pem');
    let keys;
    if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
      if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) throw new Error('Only one Mailbridge key file exists; restore the pair before running setup');
    } else {
      keys = generateKeyPair();
    }

    const artifacts = generateArtifacts({ hostname, workerName, localMailHost, localMailPort, localMailRequireTls, localMailTlsServername, localMailTlsCaFile, spamAssassinMode, upstreamProvider, relayFrom, mailgunDomain, workerSendUrl, smtpRelayEnabled, allowedCidrs, smtpRelayRequireTls, smtpRelayAllowInsecure, smtpRelayTlsCertFile, smtpRelayTlsKeyFile, smtpRelayTlsCaFile, cloudflaredEnabled, cloudflareTunnelToken, r2BucketName, queueName, ...runtimePaths }, { publicKey: keys?.publicKey || (fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8') : '') });
    fs.mkdirSync(path.join(dataDirectory, 'queue'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(targets[0], artifacts.envText, { mode: 0o600 });
    fs.writeFileSync(targets[1], artifacts.wranglerText, { mode: 0o600 });
    fs.chmodSync(targets[0], 0o600);
    fs.chmodSync(targets[1], 0o600);
    if (keys) {
      fs.writeFileSync(privateKeyPath, keys.privateKey, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(publicKeyPath, keys.publicKey, { mode: 0o644, flag: 'wx' });
    }

    const npxCommand = systemMode ? '/opt/mailbridge/node/bin/npx' : 'npx';
    output.write(`\nConfiguration generated. Secrets were written to ${envFileName}.\n`);
    const deployAutomatically = await askBoolean('Deploy the Cloudflare Worker automatically now', false);
    if (deployAutomatically) {
      try {
        await deployWorker({ cwd, npxCommand, artifacts, output });
        output.write('Worker deployed successfully.\n');
      } catch (error) {
        output.write(`Automatic Worker deployment failed: ${error.message}\n`);
        output.write('The generated configuration is preserved. Use the manual commands below.\n');
        output.write(`  ${npxCommand} --yes wrangler r2 bucket create ${r2BucketName}\n`);
        output.write(`  ${npxCommand} --yes wrangler queues create ${queueName}\n`);
        output.write(`  ${npxCommand} --yes wrangler secret put WEBHOOK_SECRET\n`);
        output.write(`  ${npxCommand} --yes wrangler secret put CLOUDFLARE_SEND_WEBHOOK_SECRET\n`);
        output.write(`  ${npxCommand} --yes wrangler secret put MAILBRIDGE_PUBLIC_KEY_PEM < ${publicKeyPath}\n`);
        output.write(`  ${npxCommand} --yes wrangler deploy\n`);
      }
    } else {
      output.write('\nWorker deployment skipped. Enter these values when Wrangler prompts for Worker secrets:\n');
      output.write(`  WEBHOOK_SECRET=${artifacts.webhookSecret}\n`);
      output.write(`  CLOUDFLARE_SEND_WEBHOOK_SECRET=${artifacts.cloudflareSendSecret}\n`);
      output.write(`  MAILBRIDGE_PUBLIC_KEY_PEM=\n${artifacts.publicKey}\n`);
      output.write(`  ${npxCommand} --yes wrangler r2 bucket create ${r2BucketName}\n`);
      output.write(`  ${npxCommand} --yes wrangler queues create ${queueName}\n`);
      output.write(`  ${npxCommand} --yes wrangler deploy\n`);
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
