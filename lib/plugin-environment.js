const { readOptionalFile } = require('./atomic-files');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadPluginConfig(filePath, { strict = false, log = () => {} } = {}) {
  try {
    const contents = readOptionalFile(filePath, 'utf8', { allowSymlinks: !strict });
    if (contents === undefined) return {};
    const config = JSON.parse(contents);
    if (!isRecord(config) || Object.values(config).some(value => !isRecord(value))) throw new Error('Invalid shape');
    return config;
  } catch {
    if (strict) throw new Error('Invalid plugin configuration; check its file and settings');
    log('[Plugin] Ignoring invalid plugin configuration');
    return {};
  }
}

function typedValue(value, schema, label) {
  if (value === undefined || value === null || value === '') {
    if (schema.default !== undefined) value = schema.default;
    else if (schema.required) throw new Error(`Missing required plugin setting ${label}`);
    else return undefined;
  }
  const type = schema.type || 'string';
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      if (/^(true|false)$/i.test(String(value))) value = String(value).toLowerCase() === 'true';
      else throw new Error(`Invalid boolean plugin setting ${label}`);
    }
  } else if (type === 'number' || type === 'integer') {
    if (typeof value === 'string' && value.trim()) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw new Error(`Invalid numeric plugin setting ${label}`);
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`Plugin setting outside allowed range: ${label}`);
  } else if (type === 'string' || type === 'secret') {
    if (typeof value !== 'string') throw new Error(`Invalid string plugin setting ${label}`);
  } else {
    throw new Error(`Unsupported plugin setting type: ${label}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`Invalid choice for plugin setting ${label}`);
  return value;
}

function pluginEnvironment(manifest, { env = process.env, config = {}, strict = false } = {}) {
  const prefix = `MAILBRIDGE_PLUGIN_${manifest.id.toUpperCase().replace(/-/g, '_')}_`;
  const fields = definition => Array.isArray(definition) ? definition.map(name => [name, {}]) : Object.entries(definition || {});
  const configured = config[manifest.id] || {};
  const result = { config: strict ? {} : { ...configured }, secrets: {} };
  for (const [name, schema] of fields(manifest.config)) {
    const value = env[`${prefix}${name}`] !== undefined ? env[`${prefix}${name}`] : configured[name];
    if (strict) {
      const validated = typedValue(value, schema, `${manifest.id}.${name}`);
      if (validated !== undefined) result.config[name] = validated;
    } else if (value !== undefined) result.config[name] = value;
  }
  for (const [name, schema] of fields(manifest.secrets)) {
    const value = env[`${prefix}${name}`] !== undefined ? env[`${prefix}${name}`] : (strict ? undefined : env[name]);
    if (strict && schema.required && (value === undefined || value === '')) throw new Error(`Missing required secret ${manifest.id}.${name}`);
    if (value !== undefined) result.secrets[name] = value;
  }
  return result;
}

module.exports = { pluginEnvironment, loadPluginConfig };
