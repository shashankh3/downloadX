'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) downloadX/1.1';
const SENSITIVE_HEADERS = new Set(['cookie', 'cookie2', 'authorization', 'proxy-authorization']);

function bareHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function stripSensitive(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Raw HTTP(S) request with manual redirect following.
 * Resolve: { req, res, url } where url is the final URL after redirects.
 * The socket is destroyed on idle-timeout so stalled servers never hang a worker.
 *
 * opts: { headers, method, maxRedirects, timeoutMs, signal, userAgent }
 */
function request(urlStr, opts = {}) {
  const {
    headers = {},
    method = 'GET',
    maxRedirects = 12,
    timeoutMs = 30000,
    signal,
    userAgent = DEFAULT_UA,
  } = opts;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Invalid URL: ' + urlStr)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http/https URLs are supported'));
    const mod = u.protocol === 'https:' ? https : http;
    const dbg = process.env.DLX_DEBUG ? `${new Date().toISOString().slice(11, 23)} ${method} ${u.pathname.slice(-30)} ` : null;
    if (dbg && headers.range) console.error(dbg + 'RANGE ' + headers.range);

    let auth;
    if (u.username) {
      try { auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || ''); }
      catch { auth = u.username + ':' + (u.password || ''); }
    }

    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; reject(err); };
    const hostname = bareHost(u.hostname);
    const req = mod.request({
      method,
      hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      auth,
      signal,
      headers: {
        'user-agent': userAgent,
        'accept': '*/*',
        'accept-encoding': 'identity',
        ...headers,
      },
      servername: net.isIP(hostname) ? undefined : hostname,
    }, (res) => {
      if (dbg) console.error(dbg + '-> ' + res.statusCode + ' len=' + (res.headers['content-length'] || '?'));
      if (REDIRECTS.has(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u); }
        catch { res.destroy(); return fail(new Error('Bad redirect target')); }
        const nextHeaders = next.origin === u.origin ? { ...opts.headers } : stripSensitive(opts.headers);
        request(next.toString(), { ...opts, headers: nextHeaders, maxRedirects: maxRedirects - 1 }).then(
          (r) => { if (!settled) { settled = true; resolve(r); } },
          fail
        );
        return;
      }
      if (!settled) { settled = true; resolve({ req, res, url: u.toString() }); }
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      if (dbg) console.error(dbg + '!! TIMEOUT');
      req.destroy(new Error('Timed out waiting for response'));
    });
    req.end();
  });
}

function abortError() {
  const e = new Error('Aborted');
  e.code = 'ABORT_ERR';
  e.name = 'AbortError';
  return e;
}

class FatalError extends Error {
  constructor(msg) { super(msg); this.fatal = true; }
}

module.exports = { request, FatalError };
