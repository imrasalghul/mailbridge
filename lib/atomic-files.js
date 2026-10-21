// Copyright (c) 2026 Ra's al Ghul

const fs = require('node:fs');
const path = require('node:path');

function readOptionalFile(filePath, encoding = 'utf8') {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    // Windows does not expose O_NOFOLLOW. Reads still use the opened descriptor;
    // all writes replace directory entries and never follow an existing link.
    if (!fs.constants.O_NOFOLLOW && fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filePath}`);
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    return fs.readFileSync(descriptor, encoding);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeFileAtomic(filePath, contents, mode = 0o600) {
  const staging = fs.mkdtempSync(path.join(path.dirname(filePath), '.mailbridge-write-'));
  const temporaryPath = path.join(staging, 'contents');
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', mode);
    try {
      fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Same-filesystem rename publishes the complete file without opening or
    // chmodding a destination that could have been exchanged for a link.
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { readOptionalFile, writeFileAtomic };
