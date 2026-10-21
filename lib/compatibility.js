// Existing configurations retain their interfaces. Fresh setup explicitly opts in.
function booleanSetting(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (/^(true|1|yes|on)$/i.test(String(value))) return true;
  if (/^(false|0|no|off)$/i.test(String(value))) return false;
  throw new Error(`Invalid boolean setting: ${name}`);
}

function getCompatibility(env = process.env) {
  const profile = String(env.MAILBRIDGE_BEHAVIOR_PROFILE || 'legacy').toLowerCase();
  if (!['legacy', 'modern'].includes(profile)) throw new Error('Invalid MAILBRIDGE_BEHAVIOR_PROFILE; use legacy or modern');
  const modern = profile === 'modern';
  const logFormat = env.MAILBRIDGE_LOG_FORMAT || (modern ? 'json' : 'text');
  if (!['text', 'json'].includes(logFormat)) throw new Error('Invalid MAILBRIDGE_LOG_FORMAT');
  return {
    profile, modern, logFormat,
    pluginStrict: booleanSetting(env, 'MAILBRIDGE_PLUGIN_STRICT', modern),
    receipts: booleanSetting(env, 'MAILBRIDGE_DELIVERY_RECEIPTS', modern),
    allowRedirects: booleanSetting(env, 'MAILBRIDGE_HTTP_ALLOW_REDIRECTS', !modern),
    strictFileReads: booleanSetting(env, 'MAILBRIDGE_STRICT_FILE_READS', modern)
  };
}

function getPluginExecutionOptions(env = process.env) {
  const { pluginStrict: strict } = getCompatibility(env);
  return {
    strict,
    maxConcurrent: Number(env.MAILBRIDGE_PLUGIN_MAX_CONCURRENT ?? (strict ? 4 : 0)),
    maxPending: Number(env.MAILBRIDGE_PLUGIN_MAX_PENDING ?? 100),
    maxWaitMs: Number(env.MAILBRIDGE_PLUGIN_WAIT_TIMEOUT_MS ?? 15000),
    timeoutMs: Number(env.MAILBRIDGE_PLUGIN_TIMEOUT_MS ?? 15000),
    memoryMb: Number(env.MAILBRIDGE_PLUGIN_MEMORY_MB ?? (strict ? 128 : 0)),
    sandbox: env.MAILBRIDGE_PLUGIN_SANDBOX || 'process',
    dockerNetwork: env.MAILBRIDGE_PLUGIN_DOCKER_NETWORK || 'none',
    ...(env.MAILBRIDGE_PLUGIN_DOCKER_IMAGE ? { dockerImage: env.MAILBRIDGE_PLUGIN_DOCKER_IMAGE } : {})
  };
}

module.exports = { getCompatibility, getPluginExecutionOptions, booleanSetting };
