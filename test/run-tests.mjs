// downloadX integration test driver — spawns the server and uses local fixtures.
// Run: node test/run-tests.mjs   (or: npm run test:integration)
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-int-'));
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

/* ---------------- local fixtures ---------------- */
const RANGE_BLOB = crypto.randomBytes(10 * 1024 * 1024);
const RANGE_HASH = crypto.createHash('sha256').update(RANGE_BLOB).digest('hex');

const rangeServer = http.createServer((req, res) => {
  if (req.url.includes('missing')) { res.writeHead(404); return res.end('nope'); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = RANGE_BLOB.length - 1;
  if (m) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), RANGE_BLOB.length - 1);
    if (start >= RANGE_BLOB.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${RANGE_BLOB.length}` });
      return res.end();
    }
  }
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'ETag': '"int-v1"',
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${RANGE_BLOB.length}` } : {}),
  });
  let pos = start;
  const iv = setInterval(() => {
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(16 * 1024, end - pos + 1);
    res.write(RANGE_BLOB.subarray(pos, pos + n));
    pos += n;
  }, 40);
  req.on('close', () => clearInterval(iv));
});
await new Promise((r) => rangeServer.listen(0, '127.0.0.1', r));
const rangeBase = `http://127.0.0.1:${rangeServer.address().port}`;

const NO_RANGE_BLOB = crypto.randomBytes(5 * 1024 * 1024);
const NO_RANGE_HASH = crypto.createHash('sha256').update(NO_RANGE_BLOB).digest('hex');
const noRangeServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Length': String(NO_RANGE_BLOB.length), 'Content-Type': 'application/octet-stream' });
  res.end(NO_RANGE_BLOB);
});
await new Promise((r) => noRangeServer.listen(0, '127.0.0.1', r));
const noRangeBase = `http://127.0.0.1:${noRangeServer.address().port}`;

const LIMITED_BLOB = crypto.randomBytes(8 * 1024 * 1024);
const limitedServer = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = LIMITED_BLOB.length - 1;
  if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), LIMITED_BLOB.length - 1); }
  res.writeHead(m ? 206 : 200, {
    'Content-Length': String(end - start + 1),
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${LIMITED_BLOB.length}` } : {}),
  });
  let pos = start;
  const iv = setInterval(() => {
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(64 * 1024, end - pos + 1);
    res.write(LIMITED_BLOB.subarray(pos, pos + n));
    pos += n;
  }, 5);
  req.on('close', () => clearInterval(iv));
});
await new Promise((r) => limitedServer.listen(0, '127.0.0.1', r));
const limitedBase = `http://127.0.0.1:${limitedServer.address().port}`;

/* ---------------- server ---------------- */
const port = await freePort();
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, DLX_PORT: String(port), DLX_DATA_DIR: path.join(TMP, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

const BASE = `http://127.0.0.1:${port}`;
async function api(p, opts = {}) {
  const payload = opts.body ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: payload,
  });
  return res.json();
}
const state = async () => (await api('/api/state')).items;
const find = async (id) => (await state()).find((i) => i.id === id);

function pct(it) {
  return `${it.status.padEnd(11)} ${(it.received / 1048576).toFixed(1)}/${((it.total || 0) / 1048576).toFixed(1)}MB ` +
    `${Math.round(it.speed / 1024)}KB/s active:${it.activeConnections || 0}/${it.segments.length}`;
}

async function waitStatus(id, statuses, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const it = await find(id);
    if (!it) throw new Error('item vanished');
    if (statuses.includes(it.status)) return it;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + statuses + ' (now: ' + it.status + ' ' + it.error + ')');
    await sleep(300);
  }
}

async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { await api('/api/health'); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start:\n' + logs);
}

try {
  await waitUp();

  /* ---------------- Test 1: pause mid-flight, resume, byte-identical ---------------- */
  {
    console.log('\n--- Test 1: 16 connections — pause mid-flight, resume, sha256 ---');
    const d = await api('/api/downloads', { method: 'POST', body: { url: `${rangeBase}/blob.bin`, segments: 16, dir: path.join(TMP, 'files') } });
    let it;
    for (let i = 0; i < 100; i++) {
      await sleep(250);
      it = await find(d.id);
      if (it.received > 2 * 1048576) break;
    }
    console.log('pausing:', pct(it));
    check('multi-connection engaged', (it.activeConnections || 0) >= 4, `${it.activeConnections} active`);
    await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
    await sleep(1000);
    it = await find(d.id);
    console.log('paused at', (it.received / 1048576).toFixed(1) + 'MB — resuming');
    await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
    const done = await waitStatus(d.id, ['completed', 'failed'], 120000);
    check('completed after resume', done.status === 'completed', done.error);
    if (done.status === 'completed') {
      check('exact size', done.received === RANGE_BLOB.length, `${done.received}`);
      const localHash = await sha256File(done.path);
      check('sha256 matches source', localHash === RANGE_HASH, localHash.slice(0, 16) + '…');
      const v = await api(`/api/downloads/${d.id}/verify`, { method: 'POST', body: { algo: 'sha256', expected: RANGE_HASH } });
      check('verify API reports OK', v.ok === true);
    }
  }

  /* ---------------- Test 2: batch pattern download ---------------- */
  {
    console.log('\n--- Test 2: batch + pattern expansion ---');
    const r = await api('/api/expand', { method: 'POST', body: { text: 'https://x.com/img[01-03].jpg' } });
    check('pattern expanded to 3', r.urls.length === 3, JSON.stringify(r.urls));
    const batch = await api('/api/downloads', {
      method: 'POST',
      body: { text: `${rangeBase}/img[01-03].bin`, dir: path.join(TMP, 'batch'), segments: 2 },
    });
    check('batch creates 3 downloads', batch.count === 3);
    const done = [];
    for (const b of batch.batch) done.push(await waitStatus(b.id, ['completed', 'failed'], 120000));
    check('3 batch downloads completed', done.every((i) => i.status === 'completed'),
      done.map((i) => i.status).join(','));
    check('batch contents intact', (await Promise.all(done.map((i) => sha256File(i.path)))).every((h) => h === RANGE_HASH));
  }

  /* ---------------- Test 3: no-Range server fallback ---------------- */
  {
    console.log('\n--- Test 3: server WITHOUT Range support -> single-stream fallback ---');
    const d = await api('/api/downloads', { method: 'POST', body: { url: `${noRangeBase}/noranges.bin`, dir: path.join(TMP, 'files') } });
    const done = await waitStatus(d.id, ['completed', 'failed'], 60000);
    check('no-Range download completed single-stream', done.status === 'completed', done.error);
    if (done.status === 'completed') {
      const got = await sha256File(done.path);
      check('no-Range content intact', got === NO_RANGE_HASH);
      check('no-Range reported as non-resumable', done.canResume === false);
    }
  }

  /* ---------------- Test 4: per-download speed limit ---------------- */
  {
    console.log('\n--- Test 4: per-download speed limit (300 KB/s) ---');
    const d = await api('/api/downloads', { method: 'POST', body: { url: `${limitedBase}/big.bin`, segments: 4, dir: path.join(TMP, 'files') } });
    await waitStatus(d.id, ['downloading'], 15000);
    await api(`/api/downloads/${d.id}/limit`, { method: 'POST', body: { kbs: 300 } });
    await sleep(6500);
    let it = await find(d.id);
    let kb = it.speed / 1024;
    await sleep(3000);
    it = await find(d.id);
    kb = Math.min(kb, it.speed / 1024);
    check('speed limit ~300KB/s respected', kb < 500, `${kb.toFixed(0)} KB/s`);
  }

  /* ---------------- Test 5: persistence ---------------- */
  {
    console.log('\n--- Test 5: state persistence ---');
    const items = await state();
    check('state tracks items across the run', items.length >= 6, `${items.length} items`);
    const s = await api('/api/settings', { method: 'PUT', body: { maxConcurrent: 2 } });
    check('settings endpoint updates live', s.maxConcurrent === 2);
  }
} catch (e) {
  console.error('\nTEST ERROR:', e.message);
  console.error(logs);
  results.push({ name: 'suite completed without throwing', ok: false });
} finally {
  try { rangeServer.close(); } catch { /* gone */ }
  try { noRangeServer.close(); } catch { /* gone */ }
  try { limitedServer.close(); } catch { /* gone */ }
  try { child.kill(); } catch { /* already exited */ }
}

console.log('\n==============================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
process.exit(0);
