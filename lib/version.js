'use strict';
/*
 * Single source of truth for the application version.
 * Read from package.json so the UI, the HTTP user agent, the installer and the
 * extension can never drift apart.
 */
let version = '0.0.0';
try {
  const pkg = require('../package.json');
  if (pkg && pkg.version) version = String(pkg.version);
} catch { /* keep the fallback */ }

module.exports = { version, VERSION: version };
