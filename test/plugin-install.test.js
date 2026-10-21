const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginManager } = require('../lib/plugin-manager');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-install-'));
  t.after(() => {
    const writable = location => {
      fs.chmodSync(location, 0o755);
      for (const item of fs.readdirSync(location, { withFileTypes: true })) {
        const child = path.join(location, item.name);
        if (item.isDirectory()) writable(child);
        else if (item.isFile()) fs.chmodSync(child, 0o644);
      }
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, manager: createPluginManager({ pluginDirectory: root, strict: true, ...options }) };
}

function fakeNpm({ id = 'scanner', missingIntegrity = false, fail = false } = {}) {
  return ({ cwd, specifier, args }) => {
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('--no-bin-links'));
    if (fail) throw new Error('synthetic registry failure');
    const name = specifier.slice(0, specifier.lastIndexOf('@'));
    const version = specifier.slice(specifier.lastIndexOf('@') + 1);
    const packagePath = path.join(cwd, 'node_modules', name);
    fs.mkdirSync(path.join(packagePath, 'node_modules', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(packagePath, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id, version, type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {}, capabilities: ['headers'] }));
    fs.writeFileSync(path.join(packagePath, 'index.js'), "const r=require('node:readline').createInterface({input:process.stdin});r.once('line',l=>{const q=JSON.parse(l);process.stdout.write(JSON.stringify({apiVersion:1,requestId:q.requestId,ok:true,result:{healthy:true}})+'\\n');r.close()})");
    fs.writeFileSync(path.join(packagePath, 'node_modules', 'nested', 'index.js'), `module.exports = '${version}';`);
    fs.writeFileSync(path.join(packagePath, 'node_modules', 'nested', 'package.json'), JSON.stringify({ name: 'nested', version: '2.0.0' }));
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies: { [name]: version } },
      [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/fixture.tgz`, integrity: 'sha512-Zml4dHVyZQ==' },
      [`node_modules/${name}/node_modules/nested`]: { version: '2.0.0', resolved: 'https://registry.npmjs.org/nested/fixture.tgz', ...(missingIntegrity ? {} : { integrity: 'sha512-Zml4dHVyZQ==' }) }
    } }));
  };
}

test('transactional installs retain complete dependency layout and require explicit activation', t => {
  const { root, manager } = fixture(t);
  const installed = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm() });
  assert.equal(installed.manifest.version, '1.0.0');
  assert.equal(require(path.join(installed.directory, 'node_modules', 'nested')), '1.0.0');
  assert.deepEqual(manager.discover(), []);
  assert.equal(manager.status()[0].enabled, false);
  manager.enable('scanner');
  assert.equal(manager.discover()[0].manifest.id, 'scanner');
  const record = manager.loadLockfile().plugins.scanner;
  assert.equal(record.type, 'scanner');
  assert.deepEqual(record.capabilities, ['headers']);
  assert.ok(Object.keys(record.files).some(name => name.endsWith('nested/index.js')));
  assert.ok(fs.existsSync(path.join(root, record.release, 'package-lock.json')));
  manager.disable('scanner');
  assert.deepEqual(manager.discover(), []);
  assert.throws(() => manager.find('scanner'), /disabled/);
});

test('publication keeps the staging directory writable until its cross-parent rename', t => {
  const { manager } = fixture(t);
  const chmod = fs.chmodSync;
  const rename = fs.renameSync;
  const readonlyDirectories = new Set();
  t.mock.method(fs, 'chmodSync', (location, mode) => {
    if (fs.statSync(location).isDirectory() && !(mode & 0o200)) readonlyDirectories.add(location);
    return chmod(location, mode);
  });
  t.mock.method(fs, 'renameSync', (source, target) => {
    // POSIX requires a writable moved directory when changing its parent.
    if (readonlyDirectories.has(source) && path.dirname(source) !== path.dirname(target)) {
      throw Object.assign(new Error('cross-parent directory rename denied'), { code: 'EACCES' });
    }
    return rename(source, target);
  });
  const installed = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
  assert.ok(readonlyDirectories.has(installed.releaseDirectory), 'published code must be readonly before activation');
});

test('permission failure after publication leaves the previous active release selected', t => {
  const { root, manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  const registryBefore = fs.readFileSync(manager.lockfilePath, 'utf8');
  const chmod = fs.chmodSync;
  let sawPublishedCandidate = false;
  t.mock.method(fs, 'chmodSync', (location, mode) => {
    if (path.dirname(location) === path.join(root, '.versions', 'scanner') && path.basename(location).startsWith('2.0.0-') && mode === 0o555) {
      sawPublishedCandidate = fs.existsSync(path.join(location, 'node_modules', 'example-scanner', 'index.js'));
      throw Object.assign(new Error('candidate permission update failed'), { code: 'EACCES' });
    }
    return chmod(location, mode);
  });
  assert.throws(() => manager.upgrade('example-scanner@2.0.0', { npmRunner: fakeNpm() }), /permission update failed/);
  assert.equal(sawPublishedCandidate, true);
  assert.equal(fs.readFileSync(manager.lockfilePath, 'utf8'), registryBefore);
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
});

test('failed upgrade and invalid transitive locks leave the active version unchanged', t => {
  const { manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  for (const npmRunner of [fakeNpm({ fail: true }), fakeNpm({ missingIntegrity: true }), fakeNpm({ id: 'wrong-id' })]) {
    assert.throws(() => manager.upgrade('example-scanner@2.0.0', { npmRunner }));
    assert.equal(manager.find('scanner').manifest.version, '1.0.0');
  }
});

test('upgrade and rollback atomically select immutable versions without removing in-flight code', t => {
  const { manager } = fixture(t);
  const first = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  manager.upgrade('example-scanner@2.0.0', { npmRunner: fakeNpm() });
  assert.equal(manager.find('scanner').manifest.version, '2.0.0');
  assert.ok(fs.existsSync(first.directory));
  manager.rollback('scanner');
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
  manager.remove('scanner');
  assert.deepEqual(manager.discover(), []);
  assert.ok(fs.existsSync(first.directory), 'retired code remains safe for an in-flight process');
});

test('strict integrity failures are scoped and reported without silently skipping enabled plugins', t => {
  const { manager } = fixture(t);
  const installed = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  fs.chmodSync(path.join(installed.directory, 'index.js'), 0o644);
  fs.appendFileSync(path.join(installed.directory, 'index.js'), '\n// tampered');
  assert.throws(() => manager.discover({ type: 'scanner' }), /integrity/i);
  assert.deepEqual(manager.discover({ type: 'provider' }), []);
  assert.match(manager.status()[0].error, /integrity/i);
  assert.throws(() => manager.enable('scanner'), /integrity/i);
  manager.disable('scanner');
  assert.deepEqual(manager.discover(), []);
});

test('activation verifies managed release integrity even with the legacy runtime profile', t => {
  const { root } = fixture(t);
  const manager = createPluginManager({ pluginDirectory: root });
  const installed = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm() });
  fs.chmodSync(path.join(installed.directory, 'index.js'), 0o644);
  fs.appendFileSync(path.join(installed.directory, 'index.js'), '// tampered');
  assert.throws(() => manager.enable('scanner'), /integrity/i);
  assert.equal(manager.loadLockfile().plugins.scanner.enabled, false);
});

test('a failed upgrade configuration preflight preserves the selected release', t => {
  const { manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  assert.throws(() => manager.upgrade('example-scanner@2.0.0', { npmRunner: fakeNpm(), validateManifest() { throw new Error('Missing required configuration'); } }), /required configuration/);
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
});

test('a failed rollback configuration preflight preserves the selected release', t => {
  const { manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  manager.upgrade('example-scanner@2.0.0', { npmRunner: fakeNpm() });
  assert.throws(() => manager.rollback('scanner', { validateManifest() { throw new Error('Missing previous-version secret'); } }), /previous-version secret/);
  assert.equal(manager.find('scanner').manifest.version, '2.0.0');
});

test('CLI rollback checks the previous version secrets before switching the registry', async t => {
  const { root, manager } = fixture(t);
  const npmRunner = fakeNpm();
  manager.install('example-scanner@1.0.0', { enabled: true, npmRunner(options) {
    npmRunner(options);
    const manifestPath = path.join(options.cwd, 'node_modules', 'example-scanner', 'mailbridge-plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.secrets = { token: { type: 'secret', required: true } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  } });
  manager.upgrade('example-scanner@2.0.0', { npmRunner });
  const { run } = require('../scripts/plugins');
  const env = { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_PLUGIN_DIR: root, MAILBRIDGE_PLUGIN_LOCKFILE: manager.lockfilePath };
  let transcript = '';
  const output = { write(value) { transcript += value; } };
  await assert.rejects(run(['rollback', 'scanner'], { cwd: root, env, output }), /required secret/);
  assert.equal(manager.find('scanner').manifest.version, '2.0.0');
  await run(['rollback', 'scanner'], { cwd: root, env: { ...env, MAILBRIDGE_PLUGIN_SCANNER_token: 'synthetic-private-token' }, output });
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
  assert.equal(transcript.includes('synthetic-private-token'), false);
});

test('registry publication failure and concurrent mutation preserve the previous activation', t => {
  const { root, manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  const original = fs.readFileSync(manager.lockfilePath, 'utf8');
  const runner = fakeNpm();
  assert.throws(() => manager.upgrade('example-scanner@2.0.0', { npmRunner: options => {
    assert.throws(() => manager.disable('scanner'), /another plugin operation|locked/i);
    runner(options);
    fs.renameSync(manager.lockfilePath, path.join(root, 'saved-registry.json'));
    fs.mkdirSync(manager.lockfilePath);
  } }));
  fs.rmdirSync(manager.lockfilePath);
  fs.renameSync(path.join(root, 'saved-registry.json'), manager.lockfilePath);
  assert.equal(fs.readFileSync(manager.lockfilePath, 'utf8'), original);
  assert.equal(manager.find('scanner').manifest.version, '1.0.0');
});

test('strict discovery requires explicit lock while legacy discovery retains loose plugins', t => {
  const { root, manager } = fixture(t);
  const plugin = path.join(root, 'loose');
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'loose', version: '1.0.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
  assert.throws(() => manager.discover(), /lockfile|registry/i);
  assert.equal(createPluginManager({ pluginDirectory: root }).discover()[0].manifest.id, 'loose');
});

test('strict empty installations need no registry and normalized secret collisions block every affected ID', t => {
  const { manager } = fixture(t);
  assert.deepEqual(manager.discover(), []);
  manager.install('scanner-a@1.0.0', { npmRunner: fakeNpm({ id: 'scan-one' }), enabled: true });
  const registry = manager.loadLockfile();
  registry.plugins.scan_one = { ...registry.plugins['scan-one'] };
  fs.writeFileSync(manager.lockfilePath, JSON.stringify(registry));
  assert.throws(() => manager.find('scan-one'), /namespace/i);
  assert.throws(() => manager.discover({ type: 'scanner' }), /namespace/i);
});

test('strict discovery detects a deleted registry when immutable releases still exist', t => {
  const { manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  fs.unlinkSync(manager.lockfilePath);
  assert.throws(() => manager.discover({ type: 'scanner' }), /registry|lockfile/);
});

test('strict mutations cannot recreate a deleted registry and silently lose prior scanners', t => {
  const { root, manager } = fixture(t);
  const original = manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm(), enabled: true });
  fs.unlinkSync(manager.lockfilePath);
  let npmCalled = false;
  assert.throws(() => manager.install('second-scanner@1.0.0', { npmRunner(options) {
    npmCalled = true;
    fakeNpm({ id: 'second' })(options);
  } }), /restore.*registry|registry.*missing/i);
  assert.equal(npmCalled, false);
  assert.equal(fs.existsSync(manager.lockfilePath), false);
  assert.ok(fs.existsSync(original.directory));
  assert.equal(fs.existsSync(path.join(root, 'plugins.lock.json.operation')), false);
  assert.throws(() => manager.discover(), /registry|lockfile/i);
});

test('strict initialization rejects existing loose plugin directories before running npm', t => {
  const { root, manager } = fixture(t);
  fs.mkdirSync(path.join(root, 'previous-install'));
  assert.throws(() => manager.install('second-scanner@1.0.0', { npmRunner() { assert.fail('npm must not run'); } }), /restore.*registry|registry.*missing/i);
  assert.equal(fs.existsSync(manager.lockfilePath), false);
});

test('npm installation uses the bundled Unix npm CLI with the current Node runtime', () => {
  const { runNpm } = require('../lib/plugin-install');
  const execPath = '/opt/mailbridge/node/bin/node';
  const npmCli = '/opt/mailbridge/node/lib/node_modules/npm/bin/npm-cli.js';
  let invocation;
  runNpm({ cwd: '/temporary/plugin', args: ['install', '--ignore-scripts'], execPath, platform: 'linux', env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }, existsSync: candidate => candidate === npmCli, spawnSync(command, args, options) {
    invocation = { command, args, options };
    return { status: 0 };
  } });
  assert.equal(invocation.command, execPath);
  assert.deepEqual(invocation.args, [npmCli, 'install', '--ignore-scripts']);
  assert.equal(invocation.options.cwd, '/temporary/plugin');
});

test('npm installation uses bundled Windows npm and refuses an implicit PATH fallback', () => {
  const { runNpm } = require('../lib/plugin-install');
  const execPath = 'C:\\runtime\\node.exe';
  const npmCli = 'C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js';
  let command;
  runNpm({ cwd: 'C:\\fixture', args: ['install'], execPath, platform: 'win32', env: {}, existsSync: candidate => candidate === npmCli, spawnSync(value, args) {
    command = value;
    assert.equal(args[0], npmCli);
    return { status: 0 };
  } });
  assert.equal(command, execPath);
  assert.throws(() => runNpm({ cwd: '/temporary/plugin', args: ['install'], execPath: '/opt/mailbridge/node/bin/node', platform: 'linux', env: {}, existsSync: () => false, spawnSync() { assert.fail('must not use system npm'); } }), /npm.*unavailable|bundled npm|npm executable/i);
});

test('newly disabled releases can be tested through the CLI without activating them', async t => {
  const { root, manager } = fixture(t);
  manager.install('example-scanner@1.0.0', { npmRunner: fakeNpm() });
  const { run } = require('../scripts/plugins');
  let transcript = '';
  await run(['test', 'scanner'], { cwd: root, env: { MAILBRIDGE_BEHAVIOR_PROFILE: 'modern', MAILBRIDGE_PLUGIN_DIR: root, MAILBRIDGE_PLUGIN_LOCKFILE: manager.lockfilePath }, output: { write(value) { transcript += value; } } });
  assert.match(transcript, /health check passed/);
  assert.equal(manager.status()[0].enabled, false);
});

test('upgrading an old lock installation can roll back to its verified original snapshot', t => {
  const { root } = fixture(t);
  const directory = path.join(root, 'scanner');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'scanner', version: '0.9.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
  fs.writeFileSync(path.join(directory, 'index.js'), '// original release');
  fs.writeFileSync(path.join(root, 'plugins.lock.json'), JSON.stringify({ apiVersion: 1, plugins: { scanner: { package: 'example-scanner', version: '0.9.0', integrity: 'old-integrity' } } }));
  const manager = createPluginManager({ pluginDirectory: root });
  manager.upgrade('example-scanner@1.0.0', { npmRunner: fakeNpm() });
  manager.rollback('scanner');
  const restored = manager.find('scanner');
  assert.equal(restored.manifest.version, '0.9.0');
  assert.equal(fs.readFileSync(path.join(restored.directory, 'index.js'), 'utf8'), '// original release');
});

test('legacy npm bin links survive an immutable upgrade snapshot and rollback', t => {
  const { root } = fixture(t);
  const directory = path.join(root, 'scanner');
  const dependency = path.join(directory, 'node_modules', 'dependency');
  const binDirectory = path.join(directory, 'node_modules', '.bin');
  fs.mkdirSync(path.join(dependency, 'bin'), { recursive: true });
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(directory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'scanner', version: '0.9.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
  fs.writeFileSync(path.join(directory, 'index.js'), '// original release');
  fs.writeFileSync(path.join(dependency, 'value.js'), "module.exports='legacy-cli-worked';");
  fs.writeFileSync(path.join(dependency, 'bin', 'cli.js'), "process.stdout.write(require('../value'));");
  const binPath = path.join(binDirectory, 'legacy-cli');
  try { fs.symlinkSync(path.join('..', 'dependency', 'bin', 'cli.js'), binPath, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Host does not permit file symbolic links'); throw error; }
  fs.writeFileSync(path.join(root, 'plugins.lock.json'), JSON.stringify({ apiVersion: 1, plugins: { scanner: { package: 'example-scanner', version: '0.9.0', integrity: 'old-integrity' } } }));
  const manager = createPluginManager({ pluginDirectory: root });
  manager.upgrade('example-scanner@1.0.0', { npmRunner: fakeNpm() });
  manager.rollback('scanner');
  const restored = manager.find('scanner');
  const restoredBin = path.join(restored.directory, 'node_modules', '.bin', 'legacy-cli');
  assert.ok(fs.lstatSync(restoredBin).isSymbolicLink());
  assert.equal(path.isAbsolute(fs.readlinkSync(restoredBin)), false);
  const result = require('node:child_process').spawnSync(process.execPath, [restoredBin], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'legacy-cli-worked');
  assert.ok(manager.loadLockfile().plugins.scanner.files['node_modules/.bin/legacy-cli'].startsWith('symlink:'));
});

test('legacy upgrade snapshots reject escaping and unrelated symbolic links', t => {
  for (const scenario of ['escaping-bin', 'unrelated-file', 'directory-bin']) {
    const { root } = fixture(t);
    const directory = path.join(root, 'scanner');
    const binDirectory = path.join(directory, 'node_modules', '.bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'mailbridge-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'scanner', version: '0.9.0', type: 'scanner', failurePolicy: 'fail-closed', entrypoint: 'index.js', config: {}, secrets: {} }));
    fs.writeFileSync(path.join(directory, 'index.js'), '// original release');
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, 'outside-content');
    const link = scenario === 'unrelated-file' ? path.join(directory, 'unrelated.js') : path.join(binDirectory, 'tool');
    const target = scenario === 'directory-bin' ? directory : scenario === 'escaping-bin' ? outside : path.join(directory, 'index.js');
    try { fs.symlinkSync(target, link, scenario === 'directory-bin' ? 'dir' : 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Host does not permit symbolic links'); throw error; }
    const registry = JSON.stringify({ apiVersion: 1, plugins: { scanner: { package: 'example-scanner', version: '0.9.0', integrity: 'old-integrity' } } });
    fs.writeFileSync(path.join(root, 'plugins.lock.json'), registry);
    const manager = createPluginManager({ pluginDirectory: root });
    assert.throws(() => manager.upgrade('example-scanner@1.0.0', { npmRunner: fakeNpm() }), /symbolic|link|outside|escapes|regular/i, scenario);
    assert.equal(fs.readFileSync(manager.lockfilePath, 'utf8'), registry);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-content');
  }
});

module.exports = { fakeNpm };
