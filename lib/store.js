'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Read a JSON file.
 * @param {string} file
 * @param {unknown} fallback returned when the file is missing or broken
 * @returns {unknown}
 */
function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Write a JSON file atomically: a temp file plus a rename, so a crash never
 * leaves a half written state behind.
 * @param {string} file
 * @param {unknown} data
 */
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { load, save };
