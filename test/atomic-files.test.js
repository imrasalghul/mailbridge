const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readOptionalFile, writeFileAtomic } = require('../lib/atomic-files');

test('legacy linked configuration is read and atomically updated without replacing its link', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbridge-linked-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  fs.writeFileSync(target, 'before');
  try { fs.symlinkSync(target, link); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Host does not permit symbolic links'); throw error; }
  assert.equal(readOptionalFile(link, 'utf8', { allowSymlinks: true }), 'before');
  assert.throws(() => readOptionalFile(link));
  writeFileAtomic(link, 'after', 0o600, { followSymlinks: true });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
});
