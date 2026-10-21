// Copyright (c) 2026 Ra's al Ghul

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readOptionalFile, writeFileAtomic } = require('./atomic-files');

function within(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid plugin installation path');
  const target = path.resolve(root, relative);
  const difference = path.relative(root, target);
  if (!difference || difference.startsWith('..') || path.isAbsolute(difference)) throw new Error('Plugin installation path escapes its root');
  return target;
}

function assertNoLinks(root, target = root) {
  const difference = path.relative(root, target);
  if (difference.startsWith('..') || path.isAbsolute(difference)) throw new Error('Plugin path escapes its root');
  let current = root;
  for (const part of ['', ...difference.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Plugin symbolic links are not permitted');
  }
}

function readRegistry(lockPath, { strict = false } = {}) {
  const contents = readOptionalFile(lockPath, 'utf8', { allowSymlinks: !strict });
  if (contents === undefined) return null;
  let lock;
  try { lock = JSON.parse(contents); } catch { throw new Error('Invalid Mailbridge plugin lockfile JSON'); }
  if (lock?.apiVersion !== 1 || !lock.plugins || typeof lock.plugins !== 'object' || Array.isArray(lock.plugins)) throw new Error('Invalid Mailbridge plugin lockfile');
  return lock;
}

function legacyBinTarget(root, location) {
  const binDirectory = path.dirname(location);
  const modulesDirectory = path.dirname(binDirectory);
  if (path.basename(binDirectory) !== '.bin' || path.basename(modulesDirectory) !== 'node_modules') throw new Error('Legacy snapshot contains an unrelated symbolic link');
  const target = path.resolve(binDirectory, fs.readlinkSync(location));
  const relative = path.relative(modulesDirectory, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Legacy npm bin link escapes its node_modules directory');
  assertNoLinks(root, target);
  if (!fs.lstatSync(target).isFile()) throw new Error('Legacy npm bin link must target a contained regular file');
  return target;
}

function inventory(root, { allowBinLinks = false } = {}) {
  const files = Object.create(null);
  assertNoLinks(root);
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const location = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        if (!allowBinLinks) throw new Error('Plugin symbolic links are not permitted');
        const target = legacyBinTarget(root, location);
        files[path.relative(root, location).split(path.sep).join('/')] = `symlink:${path.relative(path.dirname(location), target).split(path.sep).join('/')}`;
        continue;
      }
      if (item.isDirectory()) visit(location);
      else if (item.isFile()) {
        const relative = path.relative(root, location).split(path.sep).join('/');
        files[relative] = crypto.createHash('sha256').update(readOptionalFile(location, null)).digest('hex');
      } else throw new Error('Plugin installation contains a nonregular file');
    }
  };
  visit(root);
  return files;
}

function copyLegacySnapshot(sourceRoot, targetRoot) {
  // Retain only npm's contained executable aliases; copying a CLI's bytes into
  // .bin would change its relative imports and break the restored plugin.
  inventory(sourceRoot, { allowBinLinks: true });
  const visit = (source, destination) => {
    assertNoLinks(sourceRoot, source);
    fs.mkdirSync(destination, { mode: 0o755 });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, item.name);
      const to = path.join(destination, item.name);
      if (item.isDirectory()) visit(from, to);
      else if (item.isFile()) fs.writeFileSync(to, readOptionalFile(from, null), { flag: 'wx', mode: fs.statSync(from).mode & 0o777 });
      else if (item.isSymbolicLink()) {
        const originalTarget = legacyBinTarget(sourceRoot, from);
        const snapshotTarget = path.join(targetRoot, path.relative(sourceRoot, originalTarget));
        fs.symlinkSync(path.relative(path.dirname(to), snapshotTarget), to, 'file');
      } else throw new Error('Legacy snapshot contains a nonregular file');
    }
  };
  visit(sourceRoot, targetRoot);
}

function createReleaseParent(root, id) {
  let directory = root;
  for (const component of ['.versions', id]) {
    directory = path.join(directory, component);
    try { fs.mkdirSync(directory, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertNoLinks(root, directory);
    if (!fs.statSync(directory).isDirectory()) throw new Error('Plugin release parent must be a directory');
  }
}

function validateNpmLock(lock, packageName, expectedVersion) {
  if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('Plugin requires a full npm dependency lockfile');
  const requested = lock.packages[`node_modules/${packageName}`];
  if (!requested || requested.version !== expectedVersion) throw new Error('Plugin npm lockfile does not match requested version');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith('node_modules/') || name.split(/[\\/]/).includes('..') || entry.link || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(entry.version)) throw new Error('Plugin npm lockfile contains an unsupported dependency');
    if (typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) throw new Error('Plugin dependency integrity metadata is missing or invalid');
    let resolved;
    try { resolved = new URL(entry.resolved); } catch { throw new Error('Plugin dependency must resolve to an HTTPS registry artifact'); }
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) throw new Error('Plugin dependency must resolve to an HTTPS registry artifact');
  }
  return requested.integrity;
}

function verifyRecord(root, record, { allowLegacy = false } = {}) {
  if (!record || typeof record !== 'object' || !record.release || !record.directory || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) throw new Error('Plugin integrity inventory is missing; reinstall an exact version');
  const releaseDirectory = within(root, record.release);
  const directory = within(root, record.directory);
  assertNoLinks(root, releaseDirectory);
  assertNoLinks(releaseDirectory, directory);
  const actual = inventory(releaseDirectory, { allowBinLinks: Boolean(record.legacySnapshot && allowLegacy) });
  const names = Object.keys(actual);
  if (names.length !== Object.keys(record.files).length || names.some(name => actual[name] !== record.files[name])) throw new Error('Plugin installed file integrity verification failed');
  if (record.legacySnapshot) {
    if (!allowLegacy) throw new Error('Legacy plugin snapshot has no full npm lockfile; upgrade before enabling strict mode');
    return { directory, releaseDirectory };
  }
  let lock;
  try { lock = JSON.parse(readOptionalFile(path.join(releaseDirectory, 'package-lock.json'))); } catch { throw new Error('Plugin full dependency lockfile is missing or invalid'); }
  if (validateNpmLock(lock, record.package, record.version) !== record.integrity) throw new Error('Plugin registry integrity does not match dependency lockfile');
  return { directory, releaseDirectory };
}

function runNpm({ cwd, args, npmCommand = 'npm', execPath = process.execPath, platform = process.platform, env = process.env, existsSync = fs.existsSync, spawnSync: spawnCommand = spawnSync }) {
  let command = npmCommand;
  let commandArgs = args;
  if (npmCommand === 'npm') {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const executableDirectory = paths.dirname(execPath);
    const candidates = [
      paths.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      paths.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    // Prefer the npm distributed with this pinned Node runtime. npm_execpath is
    // a fallback for installations launched explicitly through an npm script.
    if (env.npm_execpath && /(?:npm-cli\.js|npm\.js)$/.test(env.npm_execpath)) candidates.push(env.npm_execpath);
    const npmCli = candidates.find(candidate => existsSync(candidate));
    if (!npmCli) throw new Error('Bundled npm is unavailable; run through npm run plugins or provide an npm executable');
    command = execPath;
    commandArgs = [npmCli, ...args];
  }
  const result = spawnCommand(command, commandArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Plugin installation failed; npm could not install the requested exact version');
}

function mutateRegistry(root, lockPath, action, { strict = false, initialPlugins = () => ({}) } = {}) {
  if (!strict && fs.existsSync(lockPath)) lockPath = fs.realpathSync(lockPath);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  assertNoLinks(root);
  const operationPath = `${lockPath}.operation`;
  let descriptor;
  try { descriptor = fs.openSync(operationPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another plugin operation holds the registry lock; after a crash, remove the .operation file only after confirming no operation is running');
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const existingRegistry = readRegistry(lockPath, { strict });
    if (!existingRegistry && strict && fs.readdirSync(root, { withFileTypes: true }).some(entry => entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error('Plugin registry is missing while prior installation data exists; restore the registry before changing plugins');
    }
    const registry = existingRegistry || { apiVersion: 1, plugins: initialPlugins() };
    const result = action(registry);
    writeFileAtomic(lockPath, `${JSON.stringify(registry, null, 2)}\n`, 0o644, { followSymlinks: !strict });
    return result;
  } finally {
    fs.closeSync(descriptor);
    // A cleanup failure must not turn a committed registry into a failed install.
    try { fs.unlinkSync(operationPath); } catch { /* A surviving marker blocks the next writer. */ }
  }
}

function readableCodeTree(root, writable = false, legacyRoot) {
  fs.chmodSync(root, writable ? 0o755 : 0o555);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const location = path.join(root, entry.name);
    if (entry.isDirectory()) readableCodeTree(location, writable, legacyRoot);
    else if (entry.isFile()) fs.chmodSync(location, writable ? 0o644 : (fs.statSync(location).mode & 0o111) ? 0o555 : 0o444);
    else if (!writable) {
      if (entry.isSymbolicLink() && legacyRoot) legacyBinTarget(legacyRoot, location);
      else throw new Error('Plugin installation contains a nonregular file');
    }
  }
}

function installVersion(specifier, { root, lockPath, readManifest, resolveLegacyDirectory, initialPlugins, assertSpecifier, strict = false, upgrade = false, enabled = false, npmRunner = runNpm, npmCommand, validateManifest, log = () => {} }) {
  const exact = assertSpecifier(specifier);
  const split = exact.lastIndexOf('@');
  const packageName = exact.slice(0, split);
  const version = exact.slice(split + 1);
  let published;
  const result = mutateRegistry(root, lockPath, registry => {
      const existing = Object.entries(registry.plugins).find(([, record]) => record.package === packageName);
      if (upgrade && !existing) throw new Error('Plugin package is not installed; use install first');
      if (!upgrade && existing) throw new Error('Plugin package is already installed; use upgrade');
      const staging = fs.mkdtempSync(path.join(root, '.staging-'));
      try {
        fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'mailbridge-plugin-installation', private: true, version: '1.0.0', dependencies: { [packageName]: version } }));
        const args = ['install', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--save-exact', '--package-lock=true', '--prefix', staging, exact];
        npmRunner({ cwd: staging, specifier: exact, args, npmCommand });
        const packageDirectory = within(staging, `node_modules/${packageName}`);
        assertNoLinks(staging, packageDirectory);
        const metadata = JSON.parse(readOptionalFile(path.join(packageDirectory, 'package.json')));
        if (metadata.name !== packageName || metadata.version !== version) throw new Error('Installed plugin package metadata does not match the requested package');
        const manifest = readManifest(packageDirectory, { strict: true });
        if (manifest.version !== version) throw new Error('Plugin manifest version does not match the requested package');
        if (validateManifest) validateManifest(manifest);
        if (upgrade && existing[0] !== manifest.id) throw new Error('Plugin upgrade cannot change its ID');
        if (!upgrade && (Object.hasOwn(registry.plugins, manifest.id) || fs.existsSync(path.join(root, manifest.id)))) throw new Error('Plugin ID is already installed; use upgrade');
        const namespace = manifest.id.replace(/-/g, '_').toUpperCase();
        if (Object.keys(registry.plugins).some(id => id !== manifest.id && id.replace(/-/g, '_').toUpperCase() === namespace)) throw new Error('Plugin secret namespace collides with an installed plugin');
        const fullLock = JSON.parse(readOptionalFile(path.join(staging, 'package-lock.json')));
        const integrity = validateNpmLock(fullLock, packageName, version);
        const files = inventory(staging);
        const release = `.versions/${manifest.id}/${version}-${crypto.randomUUID()}`;
        published = within(root, release);
        createReleaseParent(root, manifest.id);
        readableCodeTree(staging);
        fs.renameSync(staging, published);
        let previousRecord = existing?.[1];
        if (previousRecord && !previousRecord.files) {
          const oldDirectory = previousRecord.directory ? within(root, previousRecord.directory) : resolveLegacyDirectory(existing[0]);
          assertNoLinks(root, oldDirectory);
          const oldManifest = readManifest(oldDirectory);
          const oldRelease = `.versions/${manifest.id}/legacy-${crypto.randomUUID()}`;
          const oldTarget = within(root, oldRelease);
          copyLegacySnapshot(oldDirectory, oldTarget);
          readableCodeTree(oldTarget, false, oldTarget);
          previousRecord = { ...previousRecord, release: oldRelease, directory: oldRelease, files: inventory(oldTarget, { allowBinLinks: true }), legacySnapshot: true, type: oldManifest.type, failurePolicy: oldManifest.failurePolicy, capabilities: oldManifest.capabilities };
        }
        const previous = previousRecord ? [{ ...previousRecord, previous: undefined }, ...(previousRecord.previous || [])] : [];
        const record = { package: packageName, version, integrity, source: 'npm', installedAt: new Date().toISOString(), release, directory: `${release}/node_modules/${packageName}`, files, type: manifest.type, capabilities: manifest.capabilities, failurePolicy: manifest.failurePolicy, enabled: previousRecord ? previousRecord.enabled !== false : Boolean(enabled), previous };
        registry.plugins[manifest.id] = record;
        return { directory: within(root, record.directory), releaseDirectory: published, manifest, integrity };
      } finally {
        if (fs.existsSync(staging)) {
          // Only this operation's private staging tree is writable for cleanup.
          readableCodeTree(staging, true);
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
    }, { strict, initialPlugins });
  // The registry pointer is the commit. Hidden orphan releases after uncertain
  // publication are retained rather than risking deletion of in-flight code.
  log('[Plugin]', upgrade ? 'Upgraded plugin' : 'Installed plugin', { id: result.manifest.id, version });
  return result;
}

module.exports = { within, assertNoLinks, readRegistry, inventory, verifyRecord, mutateRegistry, installVersion, runNpm };
