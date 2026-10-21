// downloadX API + security test suite — spawns the real server on a free port.
// Run: node test/api.test.mjs   (or: npm run test:api)
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-api-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function rawRequest(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const BLOB = crypto.randomBytes(2 * 1024 * 1024);
const BLOB_HASH = crypto.createHash('sha256').update(BLOB).digest('hex');

const fileServer = http.createServer((req, res) => {
  if (req.url.includes('missing')) { res.writeHead(404); return res.end('nope'); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1);
    if (start >= BLOB.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${BLOB.length}` });
      return res.end();
    }
  }
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'ETag': '"api-v1"',
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
  });
  res.end(BLOB.subarray(start, end + 1));
});
await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
const fileBase = `http://127.0.0.1:${fileServer.address().port}`;

const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const updateServer = http.createServer((req, res) => {
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  if (req.url === '/newer.json') return send({ version: '99.0.0', url: 'https://example.com/downloadx-99.exe', notes: 'test release' });
  if (req.url === '/same.json') return send({ version: PKG_VERSION });
  if (req.url === '/bad.json') return send('not json');
  res.writeHead(404);
  res.end('no');
});
await new Promise((r) => updateServer.listen(0, '127.0.0.1', r));
const updateBase = `http://127.0.0.1:${updateServer.address().port}`;

const port = await freePort();
const dataDir = path.join(TMP, 'data');
const extDir = path.join(TMP, 'ext');
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, 'updates.xml'), "<?xml version='1.0'?><gupdate protocol='2.0'></gupdate>\n");
fs.writeFileSync(path.join(extDir, 'downloadx.crx'), 'Cr24-test-package');
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DLX_PORT: String(port),
    DLX_DATA_DIR: dataDir,
    DLX_EXT_DIR: extDir,
    DLX_NO_OPEN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await rawRequest(port, { path: '/api/health' });
      if (r.status === 200) return;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start:\n' + logs);
}

async function api(p, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await rawRequest(port, {
    method,
    path: p,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
    body: payload,
  });
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, body: r.body, json };
}

async function waitStatus(id, statuses, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(`/api/downloads/${id}`);
    if (r.json && statuses.includes(r.json.status)) return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${statuses} (now ${r.json && r.json.status})`);
    await sleep(150);
  }
}

try {
  await waitUp();

  /* ---------------- health / state ---------------- */
  {
    const h = await api('/api/health');
    check('api: health responds', h.status === 200 && h.json.ok === true);
    const s = await api('/api/state');
    check('api: state exposes items and settings', s.status === 200 && Array.isArray(s.json.items) && !!s.json.settings);
    check('api: security headers present', h.headers['x-content-type-options'] === 'nosniff' && h.headers['x-frame-options'] === 'DENY');
  }

  /* ---------------- host / origin protection ---------------- */
  {
    const badHost = await rawRequest(port, { path: '/api/state', headers: { Host: 'evil.example' } });
    check('security: foreign Host rejected', badHost.status === 403, String(badHost.status));
    const badOrigin = await api('/api/downloads', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { url: fileBase + '/blob.bin' },
    });
    check('security: foreign Origin rejected', badOrigin.status === 403, String(badOrigin.status));
    const goodOrigin = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/downloads',
      headers: { Origin: 'chrome-extension://abcdef', 'Access-Control-Request-Method': 'POST' },
    });
    check('security: extension origin allowed', goodOrigin.status === 204 && goodOrigin.headers['access-control-allow-origin'] === 'chrome-extension://abcdef');
    const preflightEvil = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/downloads',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    check('security: foreign preflight rejected', preflightEvil.status === 403);
  }

  /* ---------------- static path containment ---------------- */
  {
    const trav = await rawRequest(port, { path: '/..%2fserver.js' });
    check('security: static traversal blocked', trav.status === 403 || trav.status === 404, String(trav.status));
    const trav2 = await rawRequest(port, { path: '/%2e%2e/package.json' });
    check('security: encoded traversal blocked', trav2.status === 403 || trav2.status === 404, String(trav2.status));
    const index = await rawRequest(port, { path: '/' });
    check('static: index served with CSP', index.status === 200 && !!index.headers['content-security-policy']);
  }

  /* ---------------- extension hosting / install ---------------- */
  {
    const xml = await rawRequest(port, { path: '/ext/updates.xml' });
    check('ext: updates.xml served', xml.status === 200 && xml.body.includes('<gupdate') && String(xml.headers['content-type']).startsWith('text/xml'));
    const crx = await rawRequest(port, { path: '/ext/downloadx.crx' });
    check('ext: crx served', crx.status === 200 && crx.headers['content-type'] === 'application/x-chrome-extension' && crx.body.length > 0);
    const install = await api('/api/extension/install', { method: 'POST', body: {} });
    check('ext: install endpoint', install.status === 200 && install.json.ok === true && install.json.mode === 'folder' && install.json.folder === extDir);
    const portFile = path.join(dataDir, 'port');
    check('ext: port file written', fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim() === String(port));
  }

  /* ---------------- single instance lock ---------------- */
  {
    const health = await api('/api/health');
    const lockFile = path.join(dataDir, '.server.lock');
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* missing */ }
    check('instance: lock written', !!lock && lock.port === port && lock.instance === health.json.instance);
    check('instance: lock records pid', !!lock && lock.pid === health.json.pid);

    let secondLog = '';
    const second = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DLX_PORT: String(port),
        DLX_DATA_DIR: dataDir,
        DLX_EXT_DIR: extDir,
        DLX_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    second.stdout.on('data', (d) => { secondLog += d; });
    second.stderr.on('data', (d) => { secondLog += d; });
    const secondExit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { second.kill(); } catch { /* gone */ }
        resolve({ code: null, timedOut: true });
      }, 15000);
      second.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
    check('instance: second launch exits cleanly', !secondExit.timedOut && secondExit.code === 0, secondLog.trim());
    check('instance: second launch reports existing server', /already running/i.test(secondLog), secondLog.trim());
    check('instance: port file unchanged by second launch', fs.readFileSync(path.join(dataDir, 'port'), 'utf8').trim() === String(port));
  }

  /* ---------------- body validation ---------------- */
  {
    const noType = await rawRequest(port, {
      method: 'POST',
      path: '/api/downloads',
      headers: { 'Content-Length': '2' },
      body: '{}',
    });
    check('api: POST requires JSON content type', noType.status === 415, String(noType.status));
    const badJson = await rawRequest(port, {
      method: 'POST',
      path: '/api/downloads',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '5' },
      body: '{oops',
    });
    check('api: invalid JSON rejected', badJson.status === 400, String(badJson.status));
    const tooBig = await rawRequest(port, {
      method: 'POST',
      path: '/api/downloads',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    check('api: oversized body rejected', tooBig.status === 413, String(tooBig.status));
  }

  /* ---------------- add / download / verify ---------------- */
  let downloadId = null;
  {
    const add = await api('/api/downloads', {
      method: 'POST',
      body: {
        urls: [fileBase + '/blob.bin'],
        filename: 'api-test.bin',
        category: 'Video',
        segments: 4,
        expectedChecksum: BLOB_HASH,
        dir: path.join(TMP, 'files'),
      },
    });
    check('api: add returns 201 snapshot', add.status === 201 && !!add.json.id, add.body);
    downloadId = add.json.id;
    const done = await waitStatus(downloadId, ['completed', 'failed']);
    check('api: download completes', done.status === 'completed', done.error);
    check('api: checksum verified on completion', done.checksum && done.checksum.ok === true);
    check('api: file exists on disk', fs.existsSync(done.path));
    const verify = await api(`/api/downloads/${downloadId}/verify`, {
      method: 'POST',
      body: { algo: 'sha256', expected: BLOB_HASH },
    });
    check('api: verify endpoint ok', verify.status === 200 && verify.json.ok === true);
    fs.unlinkSync(done.path);
    const missing = await api(`/api/downloads/${downloadId}/open-file`, { method: 'POST' });
    check('api: open-file reports missing file', missing.status === 404);
  }

  /* ---------------- delete ---------------- */
  {
    const del = await api(`/api/downloads/${downloadId}?file=1`, { method: 'DELETE' });
    check('api: delete with file', del.status === 200 && del.json.ok === true);
    const gone = await api(`/api/downloads/${downloadId}`);
    check('api: deleted item is gone', gone.status === 404);
    downloadId = null;
  }

  /* ---------------- expand / batch ---------------- */
  {
    const ex = await api('/api/expand', { method: 'POST', body: { text: 'http://x/f[01-03].bin' } });
    check('api: expand pattern', ex.status === 200 && ex.json.urls.length === 3);
    const batch = await api('/api/downloads', {
      method: 'POST',
      body: { text: `${fileBase}/a[1-3].bin`, segments: 2, dir: path.join(TMP, 'batch') },
    });
    check('api: batch add creates 3', batch.status === 201 && batch.json.count === 3, batch.body.slice(0, 120));
    check('api: batch items have unique names', new Set(batch.json.batch.map((b) => b.filename)).size === 3);
    for (const b of batch.json.batch) {
      const it = await waitStatus(b.id, ['completed', 'failed']);
      check(`api: batch item ${b.filename} completes`, it.status === 'completed', it.error);
    }
    await api('/api/clear-finished', { method: 'POST', body: { deleteFiles: true } });
  }

  /* ---------------- settings validation ---------------- */
  {
    const bad = await api('/api/settings', {
      method: 'PUT',
      body: { maxConcurrent: 999, defaultSegments: -5, globalSpeedLimit: -1, scheduleFrom: '99:99' },
    });
    check('settings: values clamped', bad.status === 200 && bad.json.maxConcurrent === 20 && bad.json.defaultSegments === 1 && bad.json.globalSpeedLimit === 0);
    check('settings: invalid time falls back', bad.json.scheduleFrom === '23:00');
    const root = path.join(TMP, 'newroot');
    const ok = await api('/api/settings', { method: 'PUT', body: { rootDir: root } });
    check('settings: rootDir applied', ok.status === 200 && ok.json.rootDir === path.resolve(root));
    check('settings: rootDir created', fs.existsSync(root));
    await api('/api/settings', { method: 'PUT', body: { rootDir: path.join(TMP, 'files') } });
  }

  /* ---------------- connection budget + free space ---------------- */
  {
    const set = await api('/api/settings', { method: 'PUT', body: { maxConnections: 8, maxRetries: 5 } });
    check('settings: connection limit stored', set.status === 200 && set.json.maxConnections === 8, JSON.stringify(set.json.maxConnections));
    check('settings: retry count stored', set.json.maxRetries === 5, JSON.stringify(set.json.maxRetries));
    const clamped = await api('/api/settings', { method: 'PUT', body: { maxConnections: 100000 } });
    check('settings: connection limit clamped', clamped.json.maxConnections === 512, JSON.stringify(clamped.json.maxConnections));
    const state = await api('/api/state');
    check('state: connection limit reported', state.json.connectionLimit === 512, JSON.stringify(state.json.connectionLimit));
    const space = await api('/api/free-space');
    check('api: free space reported', space.status === 200 && space.json.ok === true && (space.json.free === null || space.json.free > 0), JSON.stringify(space.json));
    await api('/api/settings', { method: 'PUT', body: { maxConnections: 64 } });
  }

  /* ---------------- mirrors are de-duplicated ---------------- */
  {
    const add = await api('/api/downloads', {
      method: 'POST',
      body: { url: `${fileBase}/blob.bin`, mirrors: [`${fileBase}/blob.bin`, `${fileBase}/mirror.bin`] },
    });
    check('api: duplicate mirror removed', add.status === 201 && add.json.urls.length === 2 && add.json.urls[0] !== add.json.urls[1], JSON.stringify(add.json.urls));
    await api(`/api/downloads/${add.json.id}`, { method: 'DELETE' });
  }

  /* ---------------- update check ---------------- */
  {
    const none = await api('/api/update-check');
    check('update: unconfigured reports no update', none.status === 200 && none.json.configured === false && none.json.updateAvailable === false);
    const set = await api('/api/settings', { method: 'PUT', body: { updateUrl: updateBase + '/newer.json' } });
    check('update: manifest URL accepted', set.status === 200 && set.json.updateUrl === updateBase + '/newer.json');
    const newer = await api('/api/update-check');
    check('update: newer version detected', newer.status === 200 && newer.json.updateAvailable === true && newer.json.latest === '99.0.0', JSON.stringify(newer.json));
    check('update: download link and current version reported',
      newer.json.url === 'https://example.com/downloadx-99.exe' && newer.json.current === PKG_VERSION);
    const cached = await api('/api/update-check');
    check('update: result cached', cached.json.checkedAt === newer.json.checkedAt);
    await api('/api/settings', { method: 'PUT', body: { updateUrl: updateBase + '/same.json' } });
    const same = await api('/api/update-check');
    check('update: same version is not an update', same.status === 200 && same.json.updateAvailable === false && same.json.latest === PKG_VERSION);
    await api('/api/settings', { method: 'PUT', body: { updateUrl: updateBase + '/bad.json' } });
    const badManifest = await api('/api/update-check');
    check('update: invalid manifest reported cleanly',
      badManifest.status === 502 && badManifest.json.ok === false && /valid JSON/.test(badManifest.json.error));
    await api('/api/settings', { method: 'PUT', body: { updateUrl: '' } });
  }

  /* ---------------- actions / errors ---------------- */
  {
    const notFound = await api('/api/downloads/nope');
    check('api: unknown id 404', notFound.status === 404);
    const unknown = await api('/api/downloads/nope/pause', { method: 'POST', body: {} });
    check('api: unknown action target 404', unknown.status === 404);
    const paused = await api('/api/downloads', {
      method: 'POST',
      body: { url: fileBase + '/paused.bin', startedPaused: true, dir: path.join(TMP, 'files') },
    });
    const badAction = await api(`/api/downloads/${paused.json.id}/frobnicate`, { method: 'POST', body: {} });
    check('api: unknown action 400', badAction.status === 400);
    const pause = await api('/api/pause-all', { method: 'POST', body: {} });
    check('api: pause-all responds', pause.status === 200);
    const resume = await api('/api/resume-all', { method: 'POST', body: {} });
    check('api: resume-all responds', resume.status === 200);
    const noShutdown = await api('/api/cancel-shutdown', { method: 'POST', body: {} });
    check('api: cancel-shutdown responds', noShutdown.status === 200);
    const retry = await api('/api/retry-failed', { method: 'POST', body: {} });
    check('api: retry-failed responds', retry.status === 200 && retry.json.retried === 0);
  }

  /* ---------------- SSE ---------------- */
  {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    check('sse: streams snapshot event', res.ok && text.includes('event: snapshot') && text.includes('"items"'));
    // Close the stream properly before aborting: tearing the socket down while
    // the abort is in flight upsets libuv on Windows.
    await reader.cancel().catch(() => {});
    controller.abort();
    await sleep(50);
  }

  /* ---------------- graceful shutdown ---------------- */
  {
    const quit = await api('/api/quit', { method: 'POST', body: {} });
    check('api: quit responds', quit.status === 200);
    const exited = await Promise.race([
      new Promise((r) => child.once('exit', () => r(true))),
      sleep(5000).then(() => false),
    ]);
    check('api: server exits gracefully', exited);
    const stateFile = path.join(dataDir, 'state.json');
    check('api: state persisted', fs.existsSync(stateFile) && !!JSON.parse(fs.readFileSync(stateFile, 'utf8')).settings);
    check('ext: port file removed on quit', !fs.existsSync(path.join(dataDir, 'port')));
    check('instance: lock removed on quit', !fs.existsSync(path.join(dataDir, '.server.lock')));
  }
} catch (e) {
  console.error('\nTEST ERROR:', e.message);
  console.error(logs);
  results.push({ name: 'suite completed without throwing', ok: false });
} finally {
  for (const srv of [fileServer, updateServer]) {
    try { if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); } catch { /* gone */ }
    try { srv.close(); } catch { /* gone */ }
  }
  try { child.kill(); } catch { /* already exited */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
// Give the sockets a moment to settle — closing them twice upserts libuv on Windows.
await sleep(150);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
