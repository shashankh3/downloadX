'use strict';
/*
 * downloadX — server.js
 * Local API + static UI + SSE live updates. Binds 127.0.0.1 only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Engine } = require('./lib/engine');
const { expandPattern } = require('./lib/patterns');

const PORT = parseInt(process.env.DLX_PORT, 10) || 9765;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const engine = new Engine(DATA_DIR);
engine.on('shutdown-armed', () => armShutdown());
engine.on('shutdown-cancelled', () => disarmShutdown());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/* ---------------- shutdown-when-done ---------------- */
let shutdownProc = null;
function armShutdown() {
  if (process.platform !== 'win32') return;   // windows-only for now
  shutdownProc = spawn('shutdown', ['/s', '/t', '60'], { stdio: 'ignore' });
  console.log('[downloadX] All downloads finished — system shutdown in 60s (POST /api/cancel-shutdown to abort)');
}
function disarmShutdown() {
  if (process.platform !== 'win32') return;
  spawn('shutdown', ['/a'], { stdio: 'ignore' });
  shutdownProc = null;
}

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\\/g, '/');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------------- SSE ---------------- */
const sseClients = new Set();
setInterval(() => {
  let payload = null;
  try {
    if (engine.dirty) {
      engine.dirty = false;
      payload = `event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`;
    }
  } catch (e) {
    console.error('[downloadX] snapshot failed:', e.message);
  }
  if (payload) {
    for (const c of sseClients) c.write(payload);
  } else {
    for (const c of sseClients) c.write(': ping\n\n');
  }
}, 700).unref();

/* ---------------- API router ---------------- */
async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/health') return json(res, 200, { ok: true, version: '1.0.0' });

  if (pathname === '/api/state') return json(res, 200, engine.snapshot());

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
    engine.dirty = false;
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/api/expand' && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { urls: expandPattern(body.text || body.url || '') });
  }

  if (pathname === '/api/downloads' && method === 'POST') {
    const body = await readBody(req);
    let urls = [];
    if (Array.isArray(body.urls)) urls = body.urls;
    else if (typeof body.url === 'string') urls = [body.url];
    else if (typeof body.text === 'string') urls = expandPattern(body.text);
    urls = urls.filter((u) => /^https?:\/\//i.test(String(u).trim())).map((u) => String(u).trim());
    if (!urls.length) return json(res, 400, { error: 'No valid http(s) URL supplied' });
    if (!body.filename && urls.length === 1 && typeof body.url === 'string') {
      // allow a client-suggested filename (used by the browser extension)
    }
    const mirrors = Array.isArray(body.mirrors) ? body.mirrors.filter((u) => /^https?:\/\//i.test(u)) : [];
    try {
      // multiple URLs = batch (one download each); mirrors always attach per-download
      if (urls.length > 1) {
        const created = urls.map((u) => engine.add({
          urls: [u, ...mirrors],
          filename: body.filename || '',
          category: body.category,
          segments: body.segments,
          speedLimitKBs: body.speedLimitKBs ? body.speedLimitKBs * 1024 : body.speedLimit,
          referer: body.referer,
          cookies: body.cookies,
          dir: body.dir,
          startedPaused: !!body.startedPaused,
        }));
        return json(res, 201, { batch: created.map((d) => d.snapshot()), count: created.length });
      }
      const d = engine.add({
        urls: [urls[0], ...mirrors],
        filename: body.filename || '',
        category: body.category,
        segments: body.segments,
        speedLimitKBs: body.speedLimitKBs ? body.speedLimitKBs * 1024 : body.speedLimit,
        referer: body.referer,
        cookies: body.cookies,
        dir: body.dir,
        startedPaused: !!body.startedPaused,
      });
      return json(res, 201, d.snapshot());
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  let m = /^\/api\/downloads\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) {
    const [, id, action] = m;
    const d = engine.get(id);
    if (!d) return json(res, 404, { error: 'Download not found' });
    if (method === 'POST') {
      const body = action.includes('open') ? {} : await readBody(req).catch(() => ({}));
      switch (action) {
        case 'pause': d.pause('user'); return json(res, 200, d.snapshot());
        case 'resume': d.resume(); engine.markDirty(); return json(res, 200, d.snapshot());
        case 'retry': d.retry(); return json(res, 200, d.snapshot());
        case 'restart': d.restart(); return json(res, 200, d.snapshot());
        case 'cancel': await d.cancel(); return json(res, 200, d.snapshot());
        case 'priority': d.priority = parseInt(body.value, 10) || 0; engine.saveNow(); return json(res, 200, d.snapshot());
        case 'limit': d.setSpeedLimit((parseInt(body.kbs, 10) || 0) * 1024); engine.saveNow(); return json(res, 200, d.snapshot());
        case 'verify': {
          try { const result = await d.verifyChecksum(body.algo || 'sha256', body.expected || ''); return json(res, 200, result); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        case 'open-file': {
          if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', d.finalPath], { detached: true, stdio: 'ignore' });
          else spawn('xdg-open', [d.finalPath], { detached: true, stdio: 'ignore' });
          return json(res, 200, { ok: true });
        }
        case 'open-folder': {
          if (process.platform === 'win32') spawn('explorer', [`/select,${d.finalPath}`], { detached: true, stdio: 'ignore' });
          else spawn('xdg-open', [d.destDir], { detached: true, stdio: 'ignore' });
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
    for (const k of allowed) if (k in body) engine.settings[k] = body[k];
    engine.settings.maxConcurrent = Math.max(1, Math.min(20, parseInt(engine.settings.maxConcurrent, 10) || 3));
    engine.settings.defaultSegments = Math.max(1, Math.min(64, parseInt(engine.settings.defaultSegments, 10) || 16));
    engine.settings.globalSpeedLimit = Math.max(0, parseInt(engine.settings.globalSpeedLimit, 10) || 0);
    engine.bucket.setRate(engine.settings.globalSpeedLimit);
    engine.saveNow();
    return json(res, 200, engine.settings);
  }

  if (pathname === '/api/pause-all' && method === 'POST') { engine.pauseAll('user'); return json(res, 200, { ok: true }); }
  if (pathname === '/api/resume-all' && method === 'POST') { engine.resumeAll(); return json(res, 200, { ok: true }); }
  if (pathname === '/api/cancel-shutdown' && method === 'POST') { engine.cancelShutdown(); return json(res, 200, { ok: true }); }

  return json(res, 404, { error: 'Unknown API route' });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, u.searchParams).catch((e) => {
      try { json(res, 500, { error: e.message }); } catch { /* response gone */ }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

process.on('SIGINT', () => { engine.saveNow(); process.exit(0); });
process.on('SIGTERM', () => { engine.saveNow(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  downloadX is running');
  console.log(`  UI  ->  http://${HOST}:${PORT}`);
  console.log(`  Files -> ${engine.settings.rootDir}`);
  console.log('');
});
