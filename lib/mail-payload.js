// Copyright (c) 2026 Ra's al Ghul

function hasRequiredMailFields({ from, to, raw } = {}, { allowBuffer = false } = {}) {
  const rawIsValid = typeof raw === 'string' || (allowBuffer && Buffer.isBuffer(raw));
  return typeof from === 'string'
    && from.trim().length > 0
    && typeof to === 'string'
    && to.trim().length > 0
    && rawIsValid
    && raw.length > 0;
}

module.exports = {
  hasRequiredMailFields
};
