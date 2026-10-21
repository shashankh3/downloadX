'use strict';
/*
 * Which origins may talk to the local API.
 *
 * The server is local-only, so the interesting question is which pages in the
 * browser are allowed to reach it:
 *
 *  - loopback origins (the UI itself) are always allowed;
 *  - browser-extension origins are allowed, because the downloadX connector
 *    needs them;
 *  - everything else is rejected.
 *
 * A user who wants to pin the extension can list its ids
 * (`DLX_EXTENSION_IDS` or `extension.allowedIds` in installer/config.json).
 * Without a list every extension origin is accepted, because an unpacked
 * extension gets an id that depends on the folder it lives in and therefore
 * cannot be pinned ahead of time.
 */

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/([^/]+)$/i;

/** Turn a list or a comma separated string into lower case ids. */
function normalizeIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return list.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Build the origin check.
 * @param {{ allowedIds?: string[] | string }} options
 * @returns {(origin: string) => boolean}
 */
function createOriginCheck(options = {}) {
  const pinned = normalizeIds(options.allowedIds);
  return function isAllowedOrigin(origin) {
    if (!origin) return true;
    const ext = EXTENSION_ORIGIN.exec(origin);
    if (ext) {
      if (!pinned.length) return true;
      return pinned.includes(ext[2].toLowerCase());
    }
    return LOOPBACK_ORIGIN.test(origin);
  };
}

module.exports = { createOriginCheck, normalizeIds, LOOPBACK_ORIGIN, EXTENSION_ORIGIN };
