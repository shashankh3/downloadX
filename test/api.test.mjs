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

const port = await freePort();
const dataDir = path.join(TMP, 'data');
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, DLX_PORT: String(port), DLX_DATA_DIR: dataDir },
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
    controller.abort();
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
  }
} catch (e) {
  console.error('\nTEST ERROR:', e.message);
  console.error(logs);
  results.push({ name: 'suite completed without throwing', ok: false });
} finally {
  try { fileServer.close(); } catch { /* gone */ }
  try { child.kill(); } catch { /* already exited */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
