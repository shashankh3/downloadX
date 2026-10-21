'use strict';
/*
 * Small shared helpers used across downloadX.
 * Kept dependency-free on purpose: the whole app must run with zero npm packages.
 */
const fs = require('fs');
const path = require('path');

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

module.exports = {
  sleep,
  clampInt,
  cleanPathStr,
  isFatalDiskError,
  freeSpaceFor,
  dirExists,
  backoffDelay,
  FATAL_DISK_CODES,
};
