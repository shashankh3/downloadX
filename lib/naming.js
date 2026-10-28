'use strict';
/*
 * Filename, URL and checksum helpers.
 * Everything here ends up on the file system, so names are sanitized aggressively.
 */
const path = require('path');

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CHECKSUM_ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];

/**
 * Make an arbitrary string safe to use as a file name on Windows and POSIX.
 * @param {unknown} name
 * @returns {string}
 */
function sanitizeName(name) {
  let n = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  n = n.replace(/^\.+/, '_').replace(/[. ]+$/, '');
  if (n.length > 180) {
    const ext = path.extname(n);
    n = n.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  if (!n) return 'download';
  const stem = n.split('.')[0];
  if (RESERVED_NAMES.test(stem)) n = '_' + n;
  return n;
}

/**
 * Derive a file name from the last path segment of a URL.
 * @param {string} urlStr
 * @returns {string}
 */
function nameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    let base = path.basename(u.pathname || '');
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    base = base.split(/[?#]/)[0];
    return sanitizeName(base);
  } catch { return 'download'; }
}

/**
 * Prefer the server supplied name (Content-Disposition) and fall back to the URL.
 * Handles RFC 5987 `filename*` as well as quoted and bare `filename` parameters.
 * @param {Record<string, string>} headers
 * @param {string} finalUrl
 * @returns {string}
 */
function nameFromHeaders(headers, finalUrl) {
  const cdRaw = headers && headers['content-disposition'];
  const cd = Array.isArray(cdRaw) ? cdRaw.join('; ') : (cdRaw || '');
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[2].trim().replace(/^"|"$/g, ''));
      if (decoded) return sanitizeName(decoded);
    } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(cd);
  if (m) return sanitizeName(m[1].replace(/\\(.)/g, '$1'));
  m = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) return sanitizeName(m[1].trim().replace(/^"|"$/g, ''));
  return nameFromUrl(finalUrl);
}

/**
 * Lower-case a hash and drop any `sha256:`/`0x` prefix and non-hex characters.
 * @param {unknown} expected
 * @returns {string}
 */
function normalizeHash(expected) {
  return String(expected || '').trim().toLowerCase()
    .replace(/^0x/, '')
    .replace(/^[a-z0-9]+:/, '')
    .replace(/[^a-f0-9]/g, '');
}

/**
 * Guess the hash algorithm from the digest length (md5 / sha1 / sha256 / sha512).
 * @param {unknown} expected
 * @returns {string} the algorithm name or an empty string
 */
function guessAlgo(expected) {
  const len = normalizeHash(expected).length;
  if (len === 32) return 'md5';
  if (len === 40) return 'sha1';
  if (len === 64) return 'sha256';
  if (len === 128) return 'sha512';
  return '';
}

/**
 * Keep only headers that are safe and useful to forward to the origin server.
 * @param {unknown} input
 * @returns {Record<string, string>|null}
 */
function sanitizeHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n >= 50) break;
    const key = String(k).trim();
    if (!key || key.length > 100 || /[\r\n:]/u.test(key)) continue;
    if (/^(range|if-range|host|content-length|transfer-encoding|connection|upgrade|te)$/i.test(key)) continue;
    const val = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (!val || val.length > 2000) continue;
    out[key] = val;
    n++;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  RESERVED_NAMES,
  CHECKSUM_ALGOS,
  sanitizeName,
  nameFromUrl,
  nameFromHeaders,
  normalizeHash,
  guessAlgo,
  sanitizeHeaders,
};
