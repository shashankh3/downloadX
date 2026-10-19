'use strict';
/*
 * downloadX — server.js
 * Local API + static UI + SSE live updates. Binds 127.0.0.1 only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Engine, normalizeSettings } = require('./lib/engine');
const { expandPatternDetailed } = require('./lib/patterns');

const VERSION = require('./package.json').version;
const HOST = process.env.DLX_HOST || '127.0.0.1';
const PORT = parseInt(process.env.DLX_PORT, 10) || 9765;
const MAX_PORT_TRIES = process.env.DLX_PORT ? 0 : 10;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DLX_DATA_DIR ? path.resolve(process.env.DLX_DATA_DIR) : path.join(ROOT, 'data');

const engine = new Engine(DATA_DIR);
engine.on('shutdown-armed', ({ at }) => armShutdown(at));
engine.on('shutdown-cancelled', () => disarmShutdown());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/* ---------------- shutdown-when-done ---------------- */
let shutdownTimer = null;
function armShutdown(at) {
  disarmShutdown(false);
  if (process.platform !== 'win32') {
    console.log('[downloadX] All downloads finished — automatic shutdown is only supported on Windows');
    return;
  }
  const seconds = Math.max(15, Math.round((at - Date.now()) / 1000) || 60);
  const proc = spawn('shutdown', ['/s', '/t', String(seconds)], { stdio: 'ignore' });
  proc.on('error', (e) => console.error('[downloadX] could not arm shutdown:', e.message));
  proc.unref();
  shutdownTimer = setTimeout(() => { shutdownTimer = null; }, seconds * 1000);
  shutdownTimer.unref();
  console.log(`[downloadX] All downloads finished — system shutdown in ${seconds}s (POST /api/cancel-shutdown to abort)`);
}
function disarmShutdown(notify = true) {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  if (!notify) return;
  if (process.platform !== 'win32') return;
  const proc = spawn('shutdown', ['/a'], { stdio: 'ignore' });
  proc.on('error', () => { /* no shutdown pending */ });
  proc.unref();
}

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...corsHeaders(res.__origin),
  });
  res.end(body);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^(chrome-extension|moz-extension):\/\//i.test(origin)) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin);
}

function corsHeaders(origin) {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
      req.resume();
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > 1024 * 1024) return fail(Object.assign(new Error('Body too large'), { status: 413 }));
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    return res.end('Method not allowed');
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/\\/g, '/').replace(/\0/g, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!isPathInside(PUBLIC, file)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    return res.end('Forbidden');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
      return res.end();
    }
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString(),
      ...SECURITY_HEADERS,
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ');
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
  });
}

/* ---------------- SSE ---------------- */
const sseClients = new Set();
let lastPing = 0;

setInterval(() => {
  if (!sseClients.size) return;
  let payload = null;
  try {
    if (engine.dirty) {
      engine.dirty = false;
      payload = `event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`;
    }
  } catch (e) {
    console.error('[downloadX] snapshot failed:', e.message);
  }
  if (!payload && Date.now() - lastPing < 20000) return;
  if (!payload) lastPing = Date.now();
  for (const c of sseClients) {
    if (c.writableEnded || c.destroyed) { sseClients.delete(c); continue; }
    if (c.writableLength > 4 * 1024 * 1024) continue;
    c.write(payload || ': ping\n\n');
  }
}, 700).unref();

/* ---------------- API router ---------------- */
async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true, version: VERSION, uptime: Math.round(process.uptime()),
      pid: process.pid, platform: process.platform, node: process.version,
    });
  }

  if (pathname === '/api/state') return json(res, 200, engine.snapshot());

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
      ...corsHeaders(req.headers.origin),
    });
    res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
    engine.dirty = false;
    sseClients.add(res);
    const cleanup = () => sseClients.delete(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  if (pathname === '/api/expand' && method === 'POST') {
    const body = await readBody(req);
    const result = expandPatternDetailed(body.text || body.url || '');
    return json(res, 200, result);
  }

  if (pathname === '/api/downloads' && method === 'POST') {
    const body = await readBody(req);
    let urls = [];
    if (Array.isArray(body.urls)) urls = body.urls;
    else if (typeof body.url === 'string') urls = [body.url];
    else if (typeof body.text === 'string') urls = expandPatternDetailed(body.text).urls;
    urls = urls.filter((u) => /^https?:\/\//i.test(String(u).trim())).map((u) => String(u).trim());
    urls = [...new Set(urls)];
    if (!urls.length) return json(res, 400, { error: 'No valid http(s) URL supplied' });
    const mirrors = Array.isArray(body.mirrors)
      ? body.mirrors.filter((u) => /^https?:\/\//i.test(String(u))).map((u) => String(u).trim())
      : [];
    const base = {
      filename: typeof body.filename === 'string' ? body.filename : '',
      category: typeof body.category === 'string' ? body.category : undefined,
      segments: body.segments,
      speedLimitKBs: body.speedLimitKBs ? body.speedLimitKBs * 1024 : body.speedLimit,
      referer: body.referer,
      cookies: body.cookies,
      dir: body.dir,
      startedPaused: !!body.startedPaused,
      expectedChecksum: body.expectedChecksum || body.checksum || '',
      checksumAlgo: body.checksumAlgo || body.algo || '',
      priority: body.priority,
    };
    try {
      if (urls.length > 1) {
        const created = urls.map((u) => engine.add({
          urls: [u, ...mirrors],
          ...base,
          filename: '',
          skipSave: true,
        }));
        engine.saveNow();
        return json(res, 201, { batch: created.map((d) => d.snapshot()), count: created.length });
      }
      const d = engine.add({ urls: [urls[0], ...mirrors], ...base });
      return json(res, 201, d.snapshot());
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  let m = /^\/api\/downloads\/([^/]+)$/.exec(pathname);
  if (m && method === 'GET') {
    const d = engine.get(m[1]);
    return d ? json(res, 200, d.snapshot()) : json(res, 404, { error: 'Download not found' });
  }

  m = /^\/api\/downloads\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) {
    const [, id, action] = m;
    const d = engine.get(id);
    if (!d) return json(res, 404, { error: 'Download not found' });
    if (method === 'POST') {
      const body = action.includes('open') ? {} : await readBody(req).catch(() => ({}));
      switch (action) {
        case 'pause': await d.pause('user'); return json(res, 200, d.snapshot());
        case 'resume': d.resume(); engine.markDirty(); return json(res, 200, d.snapshot());
        case 'retry': d.retry(); return json(res, 200, d.snapshot());
        case 'restart': await d.restart(); return json(res, 200, d.snapshot());
        case 'cancel': await d.cancel(); return json(res, 200, d.snapshot());
        case 'priority':
          d.priority = Math.max(-100, Math.min(100, parseInt(body.value, 10) || 0));
          engine.saveNow();
          return json(res, 200, d.snapshot());
        case 'limit':
          d.setSpeedLimit((parseInt(body.kbs, 10) || 0) * 1024);
          engine.saveNow();
          return json(res, 200, d.snapshot());
        case 'segments':
          if (!['queued', 'paused', 'failed'].includes(d.status)) {
            return json(res, 409, { error: 'Pause the download before changing connections' });
          }
          d.segmentsWanted = Math.max(1, Math.min(64, parseInt(body.value, 10) || d.segmentsWanted));
          engine.saveNow();
          return json(res, 200, d.snapshot());
        case 'verify': {
          try {
            const result = await d.verifyChecksum(body.algo || d.checksumAlgo, body.expected || d.expectedChecksum || '');
            return json(res, 200, result);
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        case 'open-file': {
          if (!fs.existsSync(d.finalPath)) return json(res, 404, { error: 'File not found on disk' });
          openPath(d.finalPath, false);
          return json(res, 200, { ok: true });
        }
        case 'open-folder': {
          if (!fs.existsSync(d.destDir)) return json(res, 404, { error: 'Folder not found on disk' });
          openPath(d.finalPath, true);
          return json(res, 200, { ok: true });
        }
        default: return json(res, 400, { error: 'Unknown action' });
      }
    }
  }

  m = /^\/api\/downloads\/([^/]+)$/.exec(pathname);
  if (m && method === 'DELETE') {
    const ok = await engine.remove(m[1], query.get('file') === '1');
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
  }

  if (pathname === '/api/settings' && method === 'GET') return json(res, 200, engine.settings);
  if (pathname === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const body = await readBody(req);
    const allowed = ['rootDir', 'maxConcurrent', 'defaultSegments', 'globalSpeedLimit', 'organizeByCategory', 'scheduleEnabled', 'scheduleFrom', 'scheduleTo', 'shutdownWhenDone'];
    const patch = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    engine.settings = normalizeSettings(patch, engine.settings);
    engine.bucket.setRate(engine.settings.globalSpeedLimit);
    try { fs.mkdirSync(engine.settings.rootDir, { recursive: true }); } catch { /* best effort */ }
    engine.saveNow();
    return json(res, 200, engine.settings);
  }

  if (pathname === '/api/pause-all' && method === 'POST') { engine.pauseAll('user'); return json(res, 200, { ok: true }); }
  if (pathname === '/api/resume-all' && method === 'POST') { engine.resumeAll(); return json(res, 200, { ok: true }); }
  if (pathname === '/api/cancel-shutdown' && method === 'POST') { engine.cancelShutdown(); return json(res, 200, { ok: true }); }
  if (pathname === '/api/retry-failed' && method === 'POST') { return json(res, 200, { retried: engine.retryAllFailed() }); }
  if (pathname === '/api/clear-finished' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const removed = await engine.clearFinished(!!body.deleteFiles);
    return json(res, 200, { removed });
  }
  if (pathname === '/api/quit' && method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(() => { engine.saveNow(); process.exit(0); }, 100);
    return;
  }

  return json(res, 404, { error: 'Unknown API route' });
}

function openPath(target, select) {
  const child = (() => {
    if (process.platform === 'win32') {
      return select
        ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' })
        : spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
    }
    if (process.platform === 'darwin') {
      return spawn('open', [select ? path.dirname(target) : target], { detached: true, stdio: 'ignore' });
    }
    return spawn('xdg-open', [select ? path.dirname(target) : target], { detached: true, stdio: 'ignore' });
  })();
  child.on('error', () => { /* opener unavailable */ });
  child.unref();
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === HOST;
}

const server = http.createServer((req, res) => {
  res.__origin = req.headers.origin;
  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    return res.end('Forbidden host');
  }
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    const headers = corsHeaders(req.headers.origin);
    if (!headers['Access-Control-Allow-Origin']) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Origin not allowed');
    }
    res.writeHead(204, { ...headers, ...SECURITY_HEADERS });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      return json(res, 403, { error: 'Origin not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const hasBody = (parseInt(req.headers['content-length'], 10) || 0) > 0 || !!req.headers['transfer-encoding'];
      const type = String(req.headers['content-type'] || '');
      if (hasBody && !type.includes('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }
    }
    handleApi(req, res, pathname, u.searchParams).catch((e) => {
      console.error('[downloadX] API error:', e.message);
      try { json(res, e.status || 500, { error: e.message }); } catch { /* response gone */ }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && PORT + 1 <= 65535) {
    console.error(`[downloadX] Port ${PORT} is busy — trying ${PORT + 1}…`);
    if (server.__tries === undefined) server.__tries = 0;
    if (server.__tries++ < MAX_PORT_TRIES) {
      server.listen(PORT + server.__tries, HOST);
      return;
    }
    console.error(`[downloadX] No free port found. Set DLX_PORT to choose one.`);
  } else {
    console.error('[downloadX] Server error:', e.message);
  }
  process.exit(1);
});

function shutdown(code = 0) {
  engine.saveNow();
  engine.close();
  for (const c of sseClients) { try { c.end(); } catch { /* gone */ } }
  sseClients.clear();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => {
  console.error('[downloadX] Uncaught exception:', e);
  try { engine.saveNow(); } catch { /* best effort */ }
});
process.on('unhandledRejection', (e) => {
  console.error('[downloadX] Unhandled rejection:', e && e.message ? e.message : e);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : PORT;
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  const ui = `http://${shown.includes(':') ? `[${shown}]` : shown}:${boundPort}`;
  console.log('');
  console.log(`  downloadX v${VERSION} is running`);
  console.log(`  UI  ->  ${ui}`);
  console.log(`  Files -> ${engine.settings.rootDir}`);
  console.log('');
  if (process.env.DLX_OPEN === '1') openPath(ui, false);
});
