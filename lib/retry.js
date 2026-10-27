'use strict';
/*
 * Retry policy shared by the HTTP transfer, the stream capture and the probe.
 *
 * Only safe, idempotent requests are retried here: a download is a GET, so a
 * repeated request cannot create a second side effect. The status set follows
 * RFC 9110 and the guidance used by the AWS SDKs: transient client errors
 * (408, 421, 425, 429) and server/gateway errors that can clear by themselves
 * (500, 502, 503, 504). 501/505 and every other 4xx stay fatal because
 * retrying them only recreates the same failure.
 */

/** Statuses that are worth retrying for an idempotent request. */
const RETRYABLE_STATUS = new Set([408, 421, 425, 429, 500, 502, 503, 504]);

/** Statuses that announce server-side overload and can carry Retry-After. */
const RATE_LIMIT_STATUS = new Set([429, 503]);

/** Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const seconds = parseInt(text, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

/**
 * Turn an HTTP error status into an Error with retry metadata.
 *
 * `fatal` means "do not try the same URL again" (404, 403, ...). A retryable
 * error is never fatal. Rate-limit errors also expose `rateLimited` so the
 * caller can cool the whole origin down, not just this worker.
 *
 * @param {number} status
 * @param {Record<string, string>|undefined} headers
 * @param {string} [detail] optional context for the message
 * @returns {Error}
 */
function statusError(status, headers, detail) {
  const rateLimited = RATE_LIMIT_STATUS.has(status);
  const retryable = RETRYABLE_STATUS.has(status);
  const suffix = detail ? ' (' + detail + ')' : '';
  const err = new Error(
    'HTTP ' + status + (rateLimited ? ' (rate limited)' : '') + suffix
  );
  err.statusCode = status;
  err.rateLimited = rateLimited;
  err.retryable = retryable;
  if (!retryable) err.fatal = true;
  if (retryable) {
    const retryAfter = parseRetryAfter(headers && (headers['retry-after'] ?? headers['Retry-After']));
    if (retryAfter > 0) err.retryAfter = retryAfter;
  }
  return err;
}

/** True when the status is safe to retry for a GET/HEAD style request. */
function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Socket-level failures that commonly clear on the next attempt. DNS
 * `ENOTFOUND` is included because a flaky resolver is more common than a
 * permanently missing host during a long download.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Decide whether an error from a safe request is worth another attempt.
 * HTTP status errors carry `retryable`; transport errors are matched by code.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.cancelled || err.name === 'AbortError' || err.fatal) return false;
  if (err.retryable) return true;
  if (err.shortRead) return true;
  const code = String(err.code || '');
  return TRANSIENT_CODES.has(code) || code.startsWith('UND_ERR');
}

module.exports = {
  RETRYABLE_STATUS,
  RATE_LIMIT_STATUS,
  parseRetryAfter,
  statusError,
  isRetryableStatus,
  isTransientError,
};
