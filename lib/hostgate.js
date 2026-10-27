'use strict';
/*
 * Per-origin cooldown for 429/503 responses.
 *
 * A segmented download can have dozens of workers talking to the same server.
 * If that server asks for a pause, independent exponential back-off makes
 * every worker retry at a slightly different time and the server still gets a
 * burst. The gate keeps one deadline per origin: every worker waits for the
 * same deadline before it opens another request.
 *
 * The class is deliberately tiny and clock-injectable so it can be unit
 * tested without sleeping. It is not a rate limiter; it only handles the
 * "server said not now" signal.
 */

const DEFAULT_COOLDOWN_MS = 2000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * @param {string} url
 * @returns {string} the origin, or '' when the URL is invalid
 */
function originOf(url) {
  try {
    const u = new URL(String(url));
    return u.origin && u.origin !== 'null' ? u.origin : '';
  } catch {
    return '';
  }
}

class HostGate {
  /**
   * @param {{ now?: () => number, defaultCooldownMs?: number, maxCooldownMs?: number }} [options]
   */
  constructor(options = {}) {
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    this._default = Math.max(1, options.defaultCooldownMs || DEFAULT_COOLDOWN_MS);
    this._max = Math.max(this._default, options.maxCooldownMs || MAX_COOLDOWN_MS);
    this._until = new Map();
  }

  /**
   * Put an origin on hold. A longer existing deadline is never shortened.
   * @param {string} url
   * @param {number} [delayMs] server hint, or the default cooldown when 0/missing
   * @returns {number} the applied delay in milliseconds (0 when the URL is invalid)
   */
  penalize(url, delayMs) {
    const origin = originOf(url);
    if (!origin) return 0;
    const delay = Math.max(1, Math.min(this._max, Number(delayMs) || this._default));
    const until = this._now() + delay;
    const current = this._until.get(origin) || 0;
    if (until > current) this._until.set(origin, until);
    return delay;
  }

  /**
   * Milliseconds left before the origin may be contacted again.
   * @param {string} url
   * @returns {number}
   */
  remaining(url) {
    const origin = originOf(url);
    if (!origin) return 0;
    const until = this._until.get(origin) || 0;
    const left = Math.max(0, until - this._now());
    if (until && left <= 0) this._until.delete(origin);
    return left;
  }

  /** Forget every deadline (used by tests and a clean shutdown). */
  clear() {
    this._until.clear();
  }
}

module.exports = { HostGate, originOf, DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS };
