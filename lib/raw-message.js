// Copyright (c) 2026 Ra's al Ghul

// A raw message is a Buffer when the Worker sent its exact bytes (rawBase64), or a string from
// Workers that decode it as UTF-8 (the earlier format). Delivery keeps the bytes; interfaces
// that only take text (plugins, Postmark SpamCheck) get a UTF-8 view.

function rawToText(raw) {
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
}

function rawToBuffer(raw) {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
}

// Header block and body of a Buffer message, split at the first empty line (CRLF or LF).
// The header block is returned as a latin1 string, which maps every byte to one character, so
// editing it and encoding it back with latin1 leaves 8-bit header bytes as they were.
function splitHeaderBlock(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  let end = -1;
  let separatorLength = 0;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    end = crlf;
    separatorLength = 4;
  } else if (lf !== -1) {
    end = lf;
    separatorLength = 2;
  }
  if (end === -1) return { header: buffer.toString('latin1'), body: null };
  return { header: buffer.subarray(0, end).toString('latin1'), body: buffer.subarray(end + separatorLength) };
}

// Header lines with CRLF endings, the empty line, then the body bytes untouched.
function joinHeaderBlock(header, body) {
  const headerBytes = Buffer.from(header.replace(/\r?\n/g, '\r\n'), 'latin1');
  if (body === null) return headerBytes;
  return Buffer.concat([headerBytes, Buffer.from('\r\n\r\n', 'latin1'), body]);
}

// Text (possibly UTF-8) placed into a latin1 header string so it comes out as its UTF-8 bytes.
function textForLatin1Header(text) {
  return Buffer.from(String(text), 'utf8').toString('latin1');
}

module.exports = { joinHeaderBlock, rawToBuffer, rawToText, splitHeaderBlock, textForLatin1Header };
