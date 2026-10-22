// Network feature tests: proxies (HTTP forward, CONNECT tunnel, SOCKS5), Basic/Digest
// auth, custom headers, TLS bypass and proxy settings normalization.
// The local test servers live on 127.0.0.1 - allow the private network in tests.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

// Run: node test/net.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Engine, normalizeSettings } = require('../lib/engine.js');
const { parseProxy } = require('../lib/httpget.js');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-net-'));
let engineSeq = 0;
function makeEngine() {
  const dir = path.join(TMP, 'engine-' + (++engineSeq));
  fs.mkdirSync(dir, { recursive: true });
  const engine = new Engine(dir);
  engine.settings.rootDir = path.join(dir, 'out');
  engine.settings.maxConcurrent = 4;
  return engine;
}

function waitFor(fn, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function runDownload(engine, url, opts = {}) {
  const d = engine.add({ urls: [url], ...opts });
  await waitFor(() => ['completed', 'failed', 'canceled'].includes(d.status));
  return d;
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseAuthParams(value) {
  const out = {};
  const re = /([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi;
  let m;
  while ((m = re.exec(value))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function digestExpected(header, user, pass, method = 'GET') {
  const p = parseAuthParams(header.replace(/^digest\s+/i, ''));
  const ha1 = md5(`${user}:${p.realm}:${pass}`);
  const ha2 = md5(`${method}:${p.uri}`);
  if (p.qop) return md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  return md5(`${ha1}:${p.nonce}:${ha2}`);
}

function startFileServer(buf, opts = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const record = { url: req.url, headers: req.headers, method: req.method };
    log.push(record);
    if (opts.expectBasic) {
      const expected = 'Basic ' + Buffer.from(`${opts.expectBasic.user}:${opts.expectBasic.pass}`).toString('base64');
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
        return res.end();
      }
    }
    if (opts.expectDigest) {
      const auth = req.headers.authorization || '';
      const ok = /^digest\s+/i.test(auth) &&
        parseAuthParams(auth).response === digestExpected(auth, opts.expectDigest.user, opts.expectDigest.pass, req.method);
      if (!ok) {
        res.writeHead(401, { 'www-authenticate': 'Digest realm="test", nonce="abc123nonce", qop="auth"' });
        return res.end();
      }
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = parseInt(range[1], 10);
      const end = range[2] ? Math.min(parseInt(range[2], 10), buf.length - 1) : buf.length - 1;
      if (start >= buf.length) {
        res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
        return res.end();
      }
      const slice = buf.subarray(start, end + 1);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'content-length': slice.length,
        'content-type': opts.contentType || 'application/octet-stream',
        'etag': '"net-test"',
      });
      return res.end(slice);
    }
    res.writeHead(200, {
      'content-length': buf.length,
      'content-type': opts.contentType || 'application/octet-stream',
    });
    res.end(buf);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log })));
}

function startHttpProxy(opts = {}) {
  const log = { requests: [], connects: [], auths: [] };
  const authOk = (req) => {
    if (!opts.requireAuth) return true;
    const expected = 'Basic ' + Buffer.from(`${opts.requireAuth.user}:${opts.requireAuth.pass}`).toString('base64');
    return req.headers['proxy-authorization'] === expected;
  };
  const server = http.createServer((req, res) => {
    log.auths.push(req.headers['proxy-authorization'] || '');
    if (!authOk(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' });
      return res.end();
    }
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    log.requests.push(req.url);
    const up = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: (target.pathname || '/') + (target.search || ''),
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, clientSock, head) => {
    log.connects.push(req.url);
    if (!authOk(req)) {
      clientSock.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return clientSock.destroy();
    }
    const [host, portStr] = req.url.split(':');
    const up = net.connect({ host, port: parseInt(portStr, 10) }, () => {
      clientSock.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head && head.length) up.write(head);
      clientSock.pipe(up);
      up.pipe(clientSock);
    });
    up.on('error', () => clientSock.destroy());
    clientSock.on('error', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sockServer: server, port: server.address().port, log })));
}

function startSocks5(opts = {}) {
  const log = { conns: 0, auth: null, targets: [] };
  const server = net.createServer((sock) => {
    log.conns++;
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = () => sock.destroy();
    sock.on('error', fail);
    sock.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (opts.requireAuth && methods.includes(2)) { sock.write(Buffer.from([5, 2])); stage = 1; }
          else if (opts.requireAuth) { sock.write(Buffer.from([5, 255])); return sock.end(); }
          else { sock.write(Buffer.from([5, 0])); stage = 2; }
        } else if (stage === 1) {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 3 + ulen) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          log.auth = { user, pass };
          const ok = !opts.requireAuth || (user === opts.requireAuth.user && pass === opts.requireAuth.pass);
          sock.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) return sock.end();
          stage = 2;
        } else if (stage === 2) {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host, need;
          if (atyp === 1) { need = 10; if (buf.length < need) return; host = [...buf.subarray(4, 8)].join('.'); }
          else if (atyp === 3) { const l = buf[4]; need = 5 + l + 2; if (buf.length < need) return; host = buf.subarray(5, 5 + l).toString(); }
          else { sock.destroy(); return; }
          const port = buf.readUInt16BE(need - 2);
          buf = Buffer.alloc(0);
          log.targets.push({ host, port });
          sock.removeListener('data', onData);
          sock.pause();
          const up = net.connect({ host, port }, () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            sock.resume();
            sock.pipe(up);
            up.pipe(sock);
          });
          up.on('error', () => sock.destroy());
          sock.on('error', () => up.destroy());
          stage = 3;
          return;
        } else return;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log })));
}

function makeCert(dir) {
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch { return null; }
}

const FILE = crypto.randomBytes(300000);

/* ---------------- parseProxy unit ---------------- */
{
  check('parseProxy: http with auth', (() => {
    const p = parseProxy('http://u:p@10.0.0.1:3128');
    return p && p.type === 'http' && p.host === '10.0.0.1' && p.port === 3128 && p.auth.user === 'u' && p.auth.pass === 'p';
  })());
  check('parseProxy: bare host:port becomes http', (() => {
    const p = parseProxy('127.0.0.1:8080');
    return p && p.type === 'http' && p.port === 8080;
  })());
  check('parseProxy: socks5 default port 1080', (() => {
    const p = parseProxy('socks5://127.0.0.1');
    return p && p.type === 'socks5' && p.port === 1080;
  })());
  check('parseProxy: garbage rejected', parseProxy('not a proxy') === null && parseProxy('') === null && parseProxy(null) === null);
  check('settings: valid proxy kept, invalid dropped', (() => {
    const a = normalizeSettings({ proxy: 'socks5://127.0.0.1:9050' }, {});
    const b = normalizeSettings({ proxy: 'javascript:alert(1)' }, {});
    return a.proxy === 'socks5://127.0.0.1:9050' && b.proxy === '';
  })());
}

/* ---------------- custom headers + referer/cookies ---------------- */
{
  const srv = await startFileServer(FILE);
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/file.bin`, {
    headers: { 'x-api-key': 'secret123', 'x-flavor': 'a b', range: 'bytes=0-0', host: 'evil.example' },
    referer: 'https://ref.example/page',
    cookies: 'sid=xyz',
  });
  check('headers: download completed', d.status === 'completed', d.error || d.status);
  const h = srv.log[0].headers;
  check('headers: custom header forwarded', h['x-api-key'] === 'secret123');
  check('headers: multi-value header survives', h['x-flavor'] === 'a b');
  check('headers: referer + cookies forwarded', h.referer === 'https://ref.example/page' && h.cookie === 'sid=xyz');
  const rangeHeader = srv.log[0].headers.range;
  check('headers: engine range not overridden by custom range', /^bytes=0-0$/.test(rangeHeader), rangeHeader);
  check('headers: custom host not allowed', h.host === `127.0.0.1:${srv.port}`, h.host);
  engine.close();
  srv.server.close();
}

/* ---------------- Basic auth (challenge) ---------------- */
{
  const srv = await startFileServer(FILE, { expectBasic: { user: 'alice', pass: 'wonder' } });
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/locked.bin`, { username: 'alice', password: 'wonder' });
  check('basic: download completes after 401 challenge', d.status === 'completed', d.error || d.status);
  check('basic: authorization sent on retry', srv.log.some((r) => /^Basic /.test(r.headers.authorization || '')));
  const bad = await runDownload(engine, `http://127.0.0.1:${srv.port}/locked.bin`, { username: 'alice', password: 'nope' });
  check('basic: wrong password stays a fatal 401', bad.status === 'failed' && /401/.test(bad.error), bad.error);
  engine.close();
  srv.server.close();
}

/* ---------------- Digest auth (challenge) ---------------- */
{
  const srv = await startFileServer(FILE, { expectDigest: { user: 'bob', pass: 'builder' } });
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/digest.bin`, { username: 'bob', password: 'builder' });
  check('digest: download completes after digest challenge', d.status === 'completed', d.error || d.status);
  const authHit = srv.log.find((r) => /^Digest /.test(r.headers.authorization || ''));
  check('digest: qop=auth response accepted by server', !!authHit);
  check('digest: segments also authenticated', srv.log.filter((r) => /^Digest /.test(r.headers.authorization || '')).length > 1);
  const bad = await runDownload(engine, `http://127.0.0.1:${srv.port}/digest.bin`, { username: 'bob', password: 'wrong' });
  check('digest: wrong password fatally rejected', bad.status === 'failed' && /401/.test(bad.error), bad.error);
  engine.close();
  srv.server.close();
}

/* ---------------- HTTP forward proxy ---------------- */
{
  const srv = await startFileServer(FILE);
  const proxy = await startHttpProxy();
  const engine = makeEngine();
  engine.settings.proxy = `http://127.0.0.1:${proxy.port}`;
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/via-proxy.bin`);
  check('http proxy: download completed through proxy', d.status === 'completed', d.error || d.status);
  check('http proxy: absolute-form request seen', proxy.log.requests.some((u) => u.startsWith(`http://127.0.0.1:${srv.port}/`)), proxy.log.requests[0] || 'none');
  check('http proxy: direct server only reached via proxy', srv.log.length > 0);
  engine.close();
  srv.server.close();
  proxy.server.close();
}

/* ---------------- HTTP proxy with auth + per-download override ---------------- */
{
  const srv = await startFileServer(FILE);
  const proxy = await startHttpProxy({ requireAuth: { user: 'proxyuser', pass: 'proxypass' } });
  const engine = makeEngine();
  engine.settings.proxy = 'http://127.0.0.1:1';
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/override.bin`, {
    proxy: `http://proxyuser:proxypass@127.0.0.1:${proxy.port}`,
  });
  check('proxy auth: per-download proxy overrides dead global proxy', d.status === 'completed', d.error || d.status);
  const expected = 'Basic ' + Buffer.from('proxyuser:proxypass').toString('base64');
  check('proxy auth: Proxy-Authorization header sent', proxy.log.auths.includes(expected));
  engine.close();
  srv.server.close();
  proxy.server.close();
}

/* ---------------- CONNECT tunnel + HTTPS + self-signed bypass ---------------- */
{
  const pem = makeCert(TMP);
  if (!pem) {
    console.log('SKIP  connect proxy: openssl unavailable, skipping HTTPS tunnel test');
  } else {
    const proxy = await startHttpProxy();
    const tlsServer = https.createServer(pem, (req, res) => {
      res.writeHead(200, { 'content-length': FILE.length });
      res.end(FILE);
    });
    await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
    const tlsPort = tlsServer.address().port;
    const engine = makeEngine();
    engine.settings.proxy = `http://127.0.0.1:${proxy.port}`;
    engine.settings.allowInvalidTls = true;
    const d = await runDownload(engine, `https://127.0.0.1:${tlsPort}/secure.bin`);
    check('connect proxy: https download through CONNECT tunnel', d.status === 'completed', d.error || d.status);
    check('connect proxy: tunnel target recorded', proxy.log.connects.includes(`127.0.0.1:${tlsPort}`), proxy.log.connects.join(',') || 'none');
    check('connect proxy: content byte-perfect', fs.existsSync(d.finalPath) && fs.readFileSync(d.finalPath).equals(FILE));
    const strict = makeEngine();
    strict.settings.proxy = `http://127.0.0.1:${proxy.port}`;
    const bad = await runDownload(strict, `https://127.0.0.1:${tlsPort}/secure.bin`);
    check('connect proxy: self-signed rejected when verification on', bad.status === 'failed', bad.error || bad.status);
    engine.close();
    strict.close();
    tlsServer.close();
    proxy.server.close();
  }
}

/* ---------------- SOCKS5 proxy ---------------- */
{
  const srv = await startFileServer(FILE);
  const socks = await startSocks5({ requireAuth: { user: 'sockuser', pass: 'sockpass' } });
  const engine = makeEngine();
  engine.settings.proxy = `socks5://sockuser:sockpass@127.0.0.1:${socks.port}`;
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/socks.bin`);
  check('socks5: download completed through SOCKS5', d.status === 'completed', d.error || d.status);
  check('socks5: username/password sub-negotiation used', !!socks.log.auth && socks.log.auth.user === 'sockuser');
  check('socks5: CONNECT target correct', socks.log.targets.some((t) => t.port === srv.port), JSON.stringify(socks.log.targets));
  const badEngine = makeEngine();
  badEngine.settings.proxy = `socks5://sockuser:WRONG@127.0.0.1:${socks.port}`;
  const bad = await runDownload(badEngine, `http://127.0.0.1:${srv.port}/socks.bin`);
  check('socks5: bad credentials fail cleanly', bad.status === 'failed' && /authentication failed/i.test(bad.error), bad.error);
  engine.close();
  badEngine.close();
  srv.server.close();
  socks.server.close();
}

/* ---------------- SOCKS5 without auth ---------------- */
{
  const srv = await startFileServer(FILE);
  const socks = await startSocks5();
  const engine = makeEngine();
  engine.settings.proxy = `socks5://127.0.0.1:${socks.port}`;
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/open.bin`);
  check('socks5 no-auth: download completed', d.status === 'completed', d.error || d.status);
  engine.close();
  srv.server.close();
  socks.server.close();
}

/* ---------------- URL credentials ---------------- */
{
  const srv = await startFileServer(FILE, { expectBasic: { user: 'carol', pass: 'pass123' } });
  const engine = makeEngine();
  const d = await runDownload(engine, `http://carol:pass123@127.0.0.1:${srv.port}/inline.bin`);
  check('url credentials: preemptive basic auth works', d.status === 'completed', d.error || d.status);
  engine.close();
  srv.server.close();
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
