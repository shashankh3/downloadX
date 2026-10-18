'use strict';
const fs = require('fs');

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// atomic write: tmp file + rename so a crash never corrupts state
function save(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { load, save };
