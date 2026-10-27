'use strict';
/*
 * Small shared helpers used across downloadX.
 * Kept dependency-free on purpose: the whole app must run with zero npm packages.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/* Part files above this size are marked sparse on Windows. */
const SPARSE_THRESHOLD = 64 * 1024 * 1024;

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse an integer and clamp it into [min, max]; falls back when not a number.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Strip NUL bytes and surrounding whitespace from a user supplied path.
 * @param {unknown} v
 * @returns {string}
 */
function cleanPathStr(v) {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : '';
}

/** Disk errors that must abort a transfer instead of being retried.
 * @type {Set<string>}
 */
const FATAL_DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
/** True when the error is a disk error that must not be retried.
 * @param {{ code?: string } | null | undefined} e
 * @returns {boolean}
 */
function isFatalDiskError(e) {
  return !!e && FATAL_DISK_CODES.has(e.code);
}

/**
 * Free bytes on the volume that holds `dir` (or its closest existing parent).
 * @param {string} dir
 * @returns {number|null} null when the platform cannot report it
 */
function freeSpaceFor(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  let target = dir;
  for (let i = 0; i < 8; i++) {
    try {
      const st = fs.statfsSync(target);
      const available = st.bavail * st.bsize;
      return Number.isFinite(available) && available >= 0 ? available : null;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null;
      const parent = path.dirname(target);
      if (parent === target) return null;
      target = parent;
    }
  }
  return null;
}

/**
 * True when `dir` (or its nearest parent) exists and is a directory.
 * @param {string} dir
 * @returns {boolean}
 */
function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Exponential back-off with full jitter, capped at `maxMs`.
 * @param {number} attempt
 * @param {number} [maxMs]
 * @returns {number} milliseconds
 */
function backoffDelay(attempt, maxMs = 30000) {
  const exp = Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(50, Math.round(exp * (0.5 + Math.random() * 0.5)));
}

/**
 * Mark a file as sparse on Windows.
 *
 * A sparse file does not allocate clusters for the holes, so a write at a high
 * offset does not force NTFS to zero-fill everything in front of it - which
 * would block the file system thread pool for seconds.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>} true when the file is sparse afterwards
 */
function markFileSparse(filePath) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('fsutil.exe', ['sparse', 'setflag', filePath, '1'],
      { windowsHide: true, timeout: 15000 },
      (err) => resolve(!err));
  });
}

/**
 * Remove the sparse attribute again (the file is complete and fully used).
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
function unmarkFileSparse(filePath) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('fsutil.exe', ['sparse', 'setflag', filePath, '0'],
      { windowsHide: true, timeout: 15000 },
      (err) => resolve(!err));
  });
}

/* link(2) is not available on every volume (FAT, some network shares). */
const LINK_FALLBACK_CODES = new Set([
  'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK',
]);

/**
 * Move a completed part file into place without ever overwriting a file that
 * appeared in the meantime.
 *
 * `fs.rename` replaces the destination on POSIX, so a file the user created
 * between the name check and finalisation would be silently destroyed. A hard
 * link is an atomic no-clobber operation on NTFS and POSIX; the part file is
 * unlinked only after the link exists. On volumes without hard links the
 * fallback renames after an existence check, so the common case is still safe
 * while the rare filesystem keeps the old behaviour.
 *
 * @param {string} from completed part file
 * @param {string} to final path
 * @returns {boolean} false when the destination already exists (source kept)
 */
function promoteFile(from, to) {
  try {
    fs.linkSync(from, to);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!LINK_FALLBACK_CODES.has(e.code)) throw e;
    if (fs.existsSync(to)) return false;
    fs.renameSync(from, to);
    return true;
  }
  try {
    fs.unlinkSync(from);
  } catch (e) {
    // Do not leave two names for the same bytes behind.
    try { fs.unlinkSync(to); } catch { /* best effort */ }
    throw e;
  }
  return true;
}

module.exports = {
  sleep,
  clampInt,
  cleanPathStr,
  isFatalDiskError,
  freeSpaceFor,
  dirExists,
  backoffDelay,
  markFileSparse,
  unmarkFileSparse,
  promoteFile,
  SPARSE_THRESHOLD,
  FATAL_DISK_CODES,
};
