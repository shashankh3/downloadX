'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Raw HTTP(S) request with manual redirect following.
 * Resolve: { req, res, url } where url is the final URL after redirects.
 * The socket is destroyed on idle-timeout so stalled servers never hang a worker.
 */
function request(urlStr, opts = {}) {
  const { headers = {}, method = 'GET', maxRedirects = 12, timeoutMs = 30000 } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Invalid URL: ' + urlStr)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http/https URLs are supported'));
    const mod = u.protocol === 'https:' ? https : http;
    const dbg = process.env.DLX_DEBUG ? `${new Date().toISOString().slice(11, 23)} ${method} ${u.pathname.slice(-30)} ` : null;
    if (dbg && headers.range) console.error(dbg + 'RANGE ' + headers.range);
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: { 'user-agent': 'Mozilla/5.0 downloadX/1.0', 'accept-encoding': 'identity', ...headers },
      servername: u.hostname,
    }, (res) => {
      if (dbg) console.error(dbg + '-> ' + res.statusCode + ' len=' + (res.headers['content-length'] || '?'));
      if (REDIRECTS.has(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); }
        catch { res.destroy(); return reject(new Error('Bad redirect target')); }
        request(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      resolve({ req, res, url: u.toString() });
    });
    req.on('socket', (s) => { if (dbg) console.error(dbg + 'socket assigned (wasFree=' + !s.pending + ')'); });
    req.on('error', (e) => { if (dbg) console.error(dbg + '!! ' + e.message); reject(e); });
    req.setTimeout(timeoutMs, () => { if (dbg) console.error(dbg + '!! TIMEOUT'); req.destroy(new Error('Timed out waiting for response')); });
    req.end();
  });
}

class FatalError extends Error {
  constructor(msg) { super(msg); this.fatal = true; }
}

module.exports = { request, FatalError };
