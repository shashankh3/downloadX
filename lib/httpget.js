'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const ftp = require('./ftp');
const { URL } = require('url');
const { agentFor } = require('./agents');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const { version: VERSION } = require('./version');
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) downloadX/' + VERSION;
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
 * Parse "http://user:pass@host:port", "socks5://host:port", "host:port" into
 * {type, host, port, auth}.
 * @param {unknown} value
 * @returns {{ type: string, host: string, port: number, auth: { user: string, pass: string }|null, secure: boolean }|null}
 */
function parseProxy(value) {
  if (!value || typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  let type = null;
  if (scheme === 'http' || scheme === 'https') type = 'http';
  else if (scheme === 'socks5' || scheme === 'socks5h') type = 'socks5';
  if (!type || !u.hostname) return null;
  const port = parseInt(u.port, 10) || (type === 'http' ? (scheme === 'https' ? 443 : 80) : 1080);
  let auth = null;
  if (u.username) {
    try { auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password || '') }; }
    catch { auth = { user: u.username, pass: u.password || '' }; }
  }
  return { type, host: bareHost(u.hostname), port, auth, secure: scheme === 'https' };
}

function basicHeader(auth) {
  return 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
}

function parseAuthParams(value) {
  const out = {};
  const re = /([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi;
  let m;
  while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

/** Build an Authorization header value for a Basic/Digest WWW-Authenticate challenge. */
function buildAuthorization(header, creds, method, uri) {
  const h = String(header || '').trim();
  if (/^basic\b/i.test(h)) return basicHeader(creds);
  if (!/^digest\b/i.test(h)) return '';
  const p = parseAuthParams(h.replace(/^digest\s+/i, ''));
  if (!p.nonce || !p.realm) return '';
  const algoRaw = (p.algorithm || 'MD5').toUpperCase();
  const sess = algoRaw.endsWith('-SESS');
  const algo = algoRaw.replace(/-SESS$/, '');
  if (algo !== 'MD5' && algo !== 'SHA-256' && algo !== 'SHA-512-256') return '';
  const H = algo === 'SHA-256' ? (x) => crypto.createHash('sha256').update(x).digest('hex')
    : algo === 'SHA-512-256' ? (x) => crypto.createHash('sha512-256').update(x).digest('hex')
      : (x) => crypto.createHash('md5').update(x).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  let ha1 = H(`${creds.user}:${p.realm}:${creds.pass}`);
  if (sess) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qopList = (p.qop || '').split(',').map((s) => s.trim().toLowerCase());
  const qop = qopList.includes('auth') ? 'auth' : '';
  const response = qop
    ? H(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${p.nonce}:${ha2}`);
  const parts = [
    `username="${creds.user.replace(/"/g, '')}"`,
    `realm="${p.realm}"`,
    `nonce="${p.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${p.algorithm || 'MD5'}`,
  ];
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return 'Digest ' + parts.join(', ');
}

/* ---------------- low-level socket helpers ---------------- */

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Proxy connect timeout (${host}:${port})`)); }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.on('error', () => {});
      resolve(sock);
    });
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Read from a paused socket. Any bytes beyond `n` are kept in `sock._dlxRead`
 * and returned by subsequent calls (or flushed into the stream before handoff).
 * Uses 'readable' (not 'data') so nothing is emitted into the void between reads.
 */
function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let acc = sock._dlxRead || Buffer.alloc(0);
    sock._dlxRead = null;
    let done = false;
    const settle = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener('readable', onReadable);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      if (err) reject(err); else resolve(val);
    };
    const deliver = () => {
      if (acc.length < n) return false;
      const out = acc.subarray(0, n);
      const extra = acc.subarray(n);
      sock._dlxRead = extra.length ? extra : null;
      settle(null, out);
      return true;
    };
    const onReadable = () => {
      let chunk;
      while (!done && (chunk = sock.read()) !== null) {
        acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
        if (deliver()) return;
      }
    };
    const timer = setTimeout(() => settle(new Error('Proxy read timeout')), timeoutMs);
    const onError = (e) => settle(e);
    const onClose = () => settle(new Error('Proxy closed the connection'));
    sock.on('readable', onReadable);
    sock.on('error', onError);
    sock.on('close', onClose);
    if (!deliver()) onReadable();
  });
}

function readAvailable(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (sock._dlxRead && sock._dlxRead.length) {
      const data = sock._dlxRead;
      sock._dlxRead = null;
      return resolve(data);
    }
    let done = false;
    const settle = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener('readable', onReadable);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      if (err) reject(err); else resolve(val);
    };
    const onReadable = () => {
      const chunk = sock.read();
      if (chunk) settle(null, chunk);
    };
    const timer = setTimeout(() => settle(new Error('Proxy read timeout')), timeoutMs);
    const onError = (e) => settle(e);
    const onClose = () => settle(new Error('Proxy closed the connection'));
    sock.on('readable', onReadable);
    sock.on('error', onError);
    sock.on('close', onClose);
    onReadable();
  });
}

/** Return any buffered protocol bytes to the socket before handing it to TLS/HTTP. */
function flushBuffered(sock) {
  if (sock._dlxRead && sock._dlxRead.length) {
    sock.unshift(sock._dlxRead);
    sock._dlxRead = null;
  }
}

function ip6ToBuf(addr) {
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => { if (i < 8) buf.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2); });
  return buf;
}

/** Minimal SOCKS5 CONNECT (with optional username/password auth). Resolves with a ready socket. */
async function socks5Connect(proxy, targetHost, targetPort, timeoutMs) {
  const sock = await tcpConnect(proxy.host, proxy.port, timeoutMs);
  try {
    const methods = proxy.auth ? [0x02, 0x00] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const greet = await readExact(sock, 2, timeoutMs);
    if (greet[0] !== 0x05) throw new Error('SOCKS5 proxy: unexpected version');
    if (greet[1] === 0xff) throw new Error('SOCKS5 proxy: no acceptable auth method');
    if (greet[1] === 0x02) {
      if (!proxy.auth) throw new Error('SOCKS5 proxy requires authentication');
      const u = Buffer.from(proxy.auth.user);
      const p = Buffer.from(proxy.auth.pass);
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const authReply = await readExact(sock, 2, timeoutMs);
      if (authReply[1] !== 0x00) throw new Error('SOCKS5 proxy: authentication failed');
    }
    const isV6 = net.isIPv6(targetHost);
    const isV4 = net.isIP(targetHost) === 4;
    let addrPart;
    let atyp;
    if (isV4) { atyp = 0x01; addrPart = Buffer.from(targetHost.split('.').map(Number)); }
    else if (isV6) { atyp = 0x04; addrPart = ip6ToBuf(targetHost); }
    else {
      atyp = 0x03;
      const b = Buffer.from(targetHost);
      addrPart = Buffer.concat([Buffer.from([b.length]), b]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addrPart, portBuf]));
    const head = await readExact(sock, 4, timeoutMs);
    if (head[1] !== 0x00) {
      const msgs = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
      throw new Error('SOCKS5 proxy: ' + (msgs[head[1]] || 'error code ' + head[1]));
    }
    const len = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : (await readExact(sock, 1, timeoutMs))[0];
    await readExact(sock, len + 2, timeoutMs);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

/** Establish an HTTP CONNECT tunnel through an HTTP proxy. */
async function httpProxyTunnel(proxy, targetHost, targetPort, timeoutMs) {
  const sock = await tcpConnect(proxy.host, proxy.port, timeoutMs);
  try {
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
    ];
    if (proxy.auth) lines.push('Proxy-Authorization: ' + basicHeader(proxy.auth));
    sock.write(lines.join('\r\n') + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    while (true) {
      const chunk = await readAvailable(sock, timeoutMs);
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        const head = buf.subarray(0, idx).toString('latin1');
        const rest = buf.subarray(idx + 4);
        const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(head);
        if (!m) throw new Error('HTTP proxy: malformed CONNECT response');
        const code = parseInt(m[1], 10);
        if (code !== 200) throw new Error('HTTP proxy CONNECT failed: HTTP ' + code);
        if (rest.length) sock._dlxRead = rest;
        flushBuffered(sock);
        return sock;
      }
      if (buf.length > 65536) throw new Error('HTTP proxy: CONNECT response too large');
    }
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

function waitSecure(sock) {
  return new Promise((resolve, reject) => {
    sock.once('secureConnect', resolve);
    sock.once('error', reject);
  });
}

/** Agent that hands an already-connected socket to a single request. */
function singleUseAgent(mod, sock) {
  const agent = new mod.Agent({ keepAlive: false });
  agent.createConnection = () => sock;
  return agent;
}

/**
 * Open the TCP/TLS connection for a request, honouring proxy configuration.
 * Returns { mod, options } ready for mod.request().
 */
async function openConnection(u, opts, proxy) {
  const isHttps = u.protocol === 'https:';
  const targetHost = bareHost(u.hostname);
  const targetPort = parseInt(u.port, 10) || (isHttps ? 443 : 80);
  const originPath = (u.pathname || '/') + (u.search || '');
  const sni = net.isIP(targetHost) ? undefined : targetHost;
  const rejectUnauthorized = opts.rejectUnauthorized !== undefined ? opts.rejectUnauthorized : true;
  const timeoutMs = opts.timeoutMs || 30000;
  /*
   * The address guard: the first request of a download may point at a private
   * host (the user asked for it), every following hop must not.
   */
  const lookup = opts.lookup;

  if (!proxy) {
    const requestOpts = {
      hostname: targetHost,
      port: targetPort,
      path: originPath,
      servername: sni,
      agent: agentFor(u.protocol),
    };
    if (lookup) requestOpts.lookup = lookup;
    if (!rejectUnauthorized) requestOpts.rejectUnauthorized = false;
    return { mod: isHttps ? https : http, requestOpts, extraHeaders: null };
  }

  if (proxy.type === 'http') {
    if (!isHttps) {
      return {
        mod: proxy.secure ? https : http,
        requestOpts: {
          hostname: proxy.host,
          port: proxy.port,
          path: u.toString(),
          agent: false,
          ...(proxy.secure ? { rejectUnauthorized } : {}),
        },
        extraHeaders: {
          host: u.host,
          ...(proxy.auth ? { 'proxy-authorization': basicHeader(proxy.auth) } : {}),
        },
      };
    }
    const tunnel = await httpProxyTunnel(proxy, targetHost, targetPort, timeoutMs);
    const tlsSock = tls.connect({ socket: tunnel, servername: sni, rejectUnauthorized });
    await waitSecure(tlsSock);
    return {
      mod: https,
      requestOpts: { hostname: targetHost, port: targetPort, path: originPath, agent: singleUseAgent(https, tlsSock), servername: sni },
      extraHeaders: null,
    };
  }

  // SOCKS5
  const sock = await socks5Connect(proxy, targetHost, targetPort, timeoutMs);
  if (!isHttps) {
    return {
      mod: http,
      requestOpts: { hostname: targetHost, port: targetPort, path: originPath, agent: singleUseAgent(http, sock) },
      extraHeaders: null,
    };
  }
  const tlsSock = tls.connect({ socket: sock, servername: sni, rejectUnauthorized });
  await waitSecure(tlsSock);
  return {
    mod: https,
    requestOpts: { hostname: targetHost, port: targetPort, path: originPath, agent: singleUseAgent(https, tlsSock), servername: sni },
    extraHeaders: null,
  };
}

/**
 * Raw HTTP(S) request with manual redirect following, proxy support
 * (HTTP/HTTPS CONNECT and SOCKS5) and Basic/Digest authentication retry.
 *
 * Resolve: { req, res, url } where url is the final URL after redirects.
 *
 * @param {string} urlStr
 * @param {{ headers?: Record<string, string>, method?: string, body?: string|Buffer, maxRedirects?: number,
 *   timeoutMs?: number, signal?: AbortSignal, userAgent?: string, proxy?: string,
 *   credentials?: { user: string, pass: string }, rejectUnauthorized?: boolean }} [opts]
 * @returns {Promise<{ req: object, res: object, url: string }>}
 */
function request(urlStr, opts = {}) {
  const method = opts.method || 'GET';
  const userAgent = opts.userAgent || DEFAULT_UA;
  const proxy = parseProxy(opts.proxy);
  let scheme;
  try { scheme = new URL(urlStr).protocol; } catch { return Promise.reject(new Error('Invalid URL: ' + urlStr)); }
  if (scheme === 'ftp:' || scheme === 'ftps:') return ftp.request(urlStr, opts);

  const state = { authAttempted: false };

  async function fire(targetUrl, extraHeaders, redirects, lookup) {
    let u;
    try { u = new URL(targetUrl); } catch { throw new Error('Invalid URL: ' + targetUrl); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s), ftp(s) URLs are supported');
    const dbg = process.env.DLX_DEBUG ? `${new Date().toISOString().slice(11, 23)} ${method} ${u.pathname.slice(-30)} ` : null;
    if (dbg && extraHeaders.range) console.error(dbg + 'RANGE ' + extraHeaders.range);

    let creds = opts.credentials || null;
    let auth;
    if (u.username) {
      try {
        const user = decodeURIComponent(u.username);
        const pass = decodeURIComponent(u.password || '');
        auth = user + ':' + pass;
        if (!creds) creds = { user, pass };
      } catch { auth = u.username + ':' + (u.password || ''); }
    }
    let conn;
    try {
      conn = await openConnection(u, { ...opts, lookup: lookup || opts.lookup }, proxy);
    } catch (e) {
      throw new Error(e.message);
    }
    const headers = {
      'user-agent': userAgent,
      'accept': '*/*',
      'accept-encoding': 'identity',
      ...(conn.extraHeaders || {}),
      ...extraHeaders,
    };
    let body = null;
    if (opts.body !== undefined && opts.body !== null) {
      body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
      if (!headers['content-length']) headers['content-length'] = String(body.length);
    }
    const result = await new Promise((resolve, reject) => {
      const req = conn.mod.request(
        { method, signal: opts.signal, auth, headers, ...conn.requestOpts },
        (res) => resolve({ req, res })
      );
      req.on('error', reject);
      req.setTimeout(opts.timeoutMs || 30000, () => req.destroy(new Error('Timed out waiting for response')));
      req.end(body || undefined);
    });
    const { req, res } = result;
    if (dbg) console.error(dbg + '-> ' + res.statusCode + ' len=' + (res.headers['content-length'] || '?'));

    if (res.statusCode === 401 && creds && !state.authAttempted && res.headers['www-authenticate']) {
      const value = buildAuthorization(res.headers['www-authenticate'], creds, method, (u.pathname || '/') + (u.search || ''));
      if (value) {
        state.authAttempted = true;
        res.resume();
        return fire(targetUrl, { ...extraHeaders, authorization: value }, redirects, lookup);
      }
    }
    if (REDIRECTS.has(res.statusCode) && res.headers.location && redirects > 0) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, u); } catch { res.destroy(); throw new Error('Bad redirect target'); }
      if (next.origin !== u.origin) state.authAttempted = false;
      const nextHeaders = next.origin === u.origin ? { ...extraHeaders } : stripSensitive(extraHeaders);
      /*
       * A redirect is followed with the strict address guard: a remote document
       * must not be able to bounce the download into the private network.
       */
      return fire(next.toString(), nextHeaders, redirects - 1, opts.redirectLookup || lookup);
    }
    return { req, res, url: u.toString() };
  }

  return new Promise((resolve, reject) => {
    if (opts.signal && opts.signal.aborted) return reject(abortError());
    fire(urlStr, opts.headers || {}, opts.maxRedirects !== undefined ? opts.maxRedirects : 12, opts.lookup).then(resolve, reject);
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

module.exports = { request, FatalError, parseProxy, DEFAULT_UA, VERSION };
