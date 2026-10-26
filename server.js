'use strict';
/*
 * downloadX — server.js
 * Local API + static UI + SSE live updates. Binds 127.0.0.1 only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Engine } = require('./lib/engine');
const { InstanceLock, writePortFile, removePortFile } = require('./lib/instance');
const httpget = require('./lib/httpget');
const { createOriginCheck } = require('./lib/origin');
const { createApiRouter } = require('./lib/http-api');
const { createStaticHandlers, SECURITY_HEADERS } = require('./lib/http-static');
const { openPath } = require('./lib/open');
const { destroyAgents } = require('./lib/agents');
const { version: VERSION } = require('./lib/version');

const DEBUG = !!process.env.DLX_DEBUG;

/* ---------------- update check ---------------- */
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
let updateCache = { url: '', at: 0, data: null };

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function readLimited(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error('Update manifest is too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function checkForUpdate() {
  const url = String(engine.settings.updateUrl || '').trim();
  const base = { configured: !!url, current: VERSION, latest: VERSION, updateAvailable: false, url: '', notes: '' };
  if (!url) return base;
  const at = Date.now();
  if (updateCache.url === url && updateCache.data && at - updateCache.at < UPDATE_TTL_MS) return updateCache.data;
  const r = await httpget.request(url, {
    timeoutMs: 8000,
    headers: { accept: 'application/json' },
    proxy: engine.settings.proxy,
    rejectUnauthorized: !engine.settings.allowInvalidTls,
  });
  if (r.res.statusCode !== 200) throw new Error('Update check failed: HTTP ' + r.res.statusCode);
  const body = await readLimited(r.res, 262144);
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new Error('Update manifest is not valid JSON'); }
  const latest = String(data.version || '').trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(latest)) throw new Error('Update manifest has no valid version');
  const result = {
    configured: true,
    current: VERSION,
    latest,
    updateAvailable: compareVersions(latest, VERSION) > 0,
    url: /^https?:\/\//i.test(String(data.url || '')) ? String(data.url) : '',
    notes: String(data.notes || '').slice(0, 500),
    checkedAt: at,
  };
  updateCache = { url, at, data: result };
  return result;
}
const HOST = process.env.DLX_HOST || '127.0.0.1';
const PORT = parseInt(process.env.DLX_PORT, 10) || 9765;
const PORT_TRIES = process.env.DLX_PORT_TRIES !== undefined
  ? Math.max(0, parseInt(process.env.DLX_PORT_TRIES, 10) || 0)
  : null;
const MAX_PORT_TRIES = PORT_TRIES !== null ? PORT_TRIES : (process.env.DLX_PORT ? 0 : 10);
const INSTANCE_ID = crypto.randomUUID();
const IS_PKG = !!process.pkg;
const ROOT = __dirname;
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : ROOT;
const PUBLIC = path.join(ROOT, 'public');
const EXT_DIR = process.env.DLX_EXT_DIR ? path.resolve(process.env.DLX_EXT_DIR) : path.join(EXE_DIR, 'extension');
const DATA_DIR = process.env.DLX_DATA_DIR ? path.resolve(process.env.DLX_DATA_DIR) : path.join(EXE_DIR, 'data');
if (IS_PKG && process.env.DLX_OPEN === undefined && process.env.DLX_NO_OPEN !== '1') process.env.DLX_OPEN = '1';

function copyExtensionFiles(src, dst, overwrite) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyExtensionFiles(from, to, false);
    } else if (entry.isFile() && (overwrite || !fs.existsSync(to))) {
      fs.copyFileSync(from, to);
    }
  }
}

function ensurePortableExtension() {
  if (!IS_PKG || process.env.DLX_EXT_DIR) return;
  try {
    const src = path.join(ROOT, 'extension');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(EXT_DIR, { recursive: true });
    copyExtensionFiles(src, EXT_DIR, true);
  } catch (e) {
    console.error('[downloadX] could not prepare portable extension folder:', e.message);
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const EXT_CONFIG = (() => {
  const candidates = [
    process.env.DLX_EXT_CONFIG,
    path.join(ROOT, 'extension-config.json'),
    path.join(ROOT, 'installer', 'config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    const parsed = readJsonSafe(file);
    if (parsed) return parsed.extension || parsed;
  }
  return {};
})();
const EXT_MODE = process.env.DLX_EXT_MODE || EXT_CONFIG.mode || 'auto';
const CHROME_STORE_ID = process.env.DLX_CHROME_STORE_ID || EXT_CONFIG.chromeStoreId || '';
const EDGE_STORE_ID = process.env.DLX_EDGE_STORE_ID || EXT_CONFIG.edgeStoreId || '';
const FIREFOX_ID = process.env.DLX_FIREFOX_ID || EXT_CONFIG.firefoxAddonId || 'downloadx@local';

/*
 * Which browser origins may reach the API. The extension ids can be pinned
 * with DLX_EXTENSION_IDS or with "allowedIds" in installer/config.json; an
 * unpacked extension cannot be pinned because its id depends on the folder.
 */
const originCheck = createOriginCheck({
  allowedIds: process.env.DLX_EXTENSION_IDS || EXT_CONFIG.allowedIds || [],
});

function extensionFolder() {
  const built = path.join(EXT_DIR, 'chrome');
  return fs.existsSync(path.join(built, 'manifest.json')) ? built : EXT_DIR;
}

let engine = null;
let apiRouter = null;
let instanceLock = null;
let boundPort = 0;
let shuttingDown = false;

/* The static files (the web UI and the extension package). */
const staticHandlers = createStaticHandlers({ publicDir: PUBLIC, extDir: EXT_DIR, isPkg: IS_PKG });

function startEngine() {
  engine = new Engine(DATA_DIR);
  engine.on('shutdown-armed', ({ at }) => armShutdown(at));
  engine.on('shutdown-cancelled', () => disarmShutdown());
  apiRouter = createApiRouter({
    getEngine: () => engine,
    instanceId: INSTANCE_ID,
    version: VERSION,
    securityHeaders: SECURITY_HEADERS,
    sseClients,
    buildSnapshot,
    checkForUpdate,
    readLimited,
    openPath,
    extension: {
      mode: EXT_MODE,
      chromeStoreId: CHROME_STORE_ID,
      edgeStoreId: EDGE_STORE_ID,
      firefoxId: FIREFOX_ID,
      dir: EXT_DIR,
      folder: extensionFolder,
    },
    isAllowedOrigin: originCheck,
    quit: (code) => shutdown(code),
  });
}



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



/* ---------------- SSE ---------------- */
const sseClients = new Set();
let lastPing = 0;
const MAX_SSE_PAYLOAD = 2 * 1024 * 1024;

/**
 * Build the live snapshot, shrinking it when it would be too large to push to
 * every connected browser. Segment tables are only needed for live progress,
 * so finished items lose them first.
 */
function buildSnapshot() {
  const snap = engine.snapshot();
  let json = JSON.stringify(snap);
  if (json.length <= MAX_SSE_PAYLOAD) return json;
  // The snapshots may be cached and shared, so they are never modified in
  // place - the items are replaced by copies instead.
  const trimmed = { ...snap, items: snap.items.map((item) => (
    item.status !== 'downloading' && item.status !== 'probing'
      ? { ...item, segments: [] }
      : item
  )) };
  json = JSON.stringify(trimmed);
  if (json.length <= MAX_SSE_PAYLOAD) return json;
  trimmed.items = trimmed.items.map((item) => ({ ...item, segments: [] }));
  return JSON.stringify(trimmed);
}

setInterval(() => {
  if (!engine || !sseClients.size) return;
  let payload = null;
  try {
    if (engine.dirty) {
      engine.dirty = false;
      payload = `event: snapshot\ndata: ${buildSnapshot()}\n\n`;
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


function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === HOST;
}

const server = http.createServer((req, res) => {
  res.__origin = req.headers.origin;
  if (DEBUG) {
    const started = Date.now();
    res.on('finish', () => {
      console.error(`[downloadX] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
  }
  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    return res.end('Forbidden host');
  }
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    const headers = apiRouter.corsHeaders(req.headers.origin);
    if (!headers['Access-Control-Allow-Origin']) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Origin not allowed');
    }
    res.writeHead(204, { ...headers, ...SECURITY_HEADERS });
    return res.end();
  }
  if (pathname === '/ext/updates.xml' || pathname === '/ext/downloadx.crx') {
    staticHandlers.serveExtensionFile(req, res, pathname);
    return;
  }
  if (pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !originCheck(origin)) {
      return apiRouter.json(res, 403, { error: 'Origin not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const hasBody = (parseInt(req.headers['content-length'], 10) || 0) > 0 || !!req.headers['transfer-encoding'];
      const type = String(req.headers['content-type'] || '');
      if (hasBody && !type.includes('application/json')) {
        return apiRouter.json(res, 415, { error: 'Content-Type must be application/json' });
      }
    }
    apiRouter.handleApi(req, res, pathname, u.searchParams).catch((e) => {
      console.error('[downloadX] API error:', e.message);
      try { apiRouter.json(res, e.status || 500, { error: e.message }); } catch { /* response gone */ }
    });
    return;
  }
  staticHandlers.serveStatic(req, res, pathname);
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
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (engine) {
      engine.saveNow();
      engine.close();
    }
  } catch (e) {
    console.error('[downloadX] shutdown save failed:', e.message);
  }
  try { destroyAgents(); } catch { /* already gone */ }
  if (boundPort) removePortFile(DATA_DIR, boundPort);
  if (instanceLock) instanceLock.release();
  for (const c of sseClients) { try { c.end(); } catch { /* gone */ } }
  sseClients.clear();
  process.exitCode = code;
  if (server.listening) {
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => {
  console.error('[downloadX] Uncaught exception:', e);
  try { if (engine) engine.saveNow(); } catch { /* best effort */ }
});
process.on('unhandledRejection', (e) => {
  console.error('[downloadX] Unhandled rejection:', e && e.message ? e.message : e);
});
process.on('exit', () => {
  if (instanceLock) instanceLock.release();
});

/*
 * The desktop window starts this server as a child process. If the window is
 * killed instead of exiting cleanly, take the server down too so it cannot
 * linger in the background. A normal exit uses /api/quit and never reaches the
 * ESRCH branch.
 */
if (process.env.DLX_PARENT_WATCH === '1') {
  const parent = process.ppid;
  if (parent > 0) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch (e) {
        if (e.code === 'ESRCH') shutdown(0);
      }
    }, 5000).unref();
  }
}

async function start() {
  const lock = new InstanceLock({ dataDir: DATA_DIR, host: HOST, port: PORT, instance: INSTANCE_ID });
  let claim;
  try {
    claim = await lock.acquire();
  } catch (e) {
    console.error('[downloadX] ' + e.message);
    process.exit(1);
  }

  if (!claim.acquired) {
    if (claim.starting) {
      console.log('[downloadX] downloadX is already starting — give it a moment and try again.');
      if (process.env.DLX_OPEN === '1') openPath('http://127.0.0.1:' + (claim.port || PORT) + '/', false);
      return;
    }
    const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    const ui = `http://${shown.includes(':') ? `[${shown}]` : shown}:${claim.port}/`;
    console.log(`[downloadX] Already running at ${ui}`);
    if (process.env.DLX_OPEN === '1') openPath(ui, false);
    return;
  }
  if (shuttingDown) {
    lock.release();
    return;
  }

  instanceLock = lock;
  ensurePortableExtension();
  startEngine();
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    boundPort = addr && typeof addr === 'object' ? addr.port : PORT;
    instanceLock.update(boundPort);
    try {
      writePortFile(DATA_DIR, boundPort);
    } catch (e) {
      console.error('[downloadX] could not write port file:', e.message);
    }
    const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    const ui = `http://${shown.includes(':') ? `[${shown}]` : shown}:${boundPort}`;
    console.log('');
    console.log(`  downloadX v${VERSION} is running`);
    console.log(`  UI  ->  ${ui}`);
    console.log(`  Files -> ${engine.settings.rootDir}`);
    console.log('');
    if (process.env.DLX_OPEN === '1') openPath(ui, false);
  });
}

start().catch((e) => {
  console.error('[downloadX] startup failed:', e && e.message ? e.message : e);
  if (instanceLock) instanceLock.release();
  process.exit(1);
});
