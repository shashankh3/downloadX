// Controlled experiment: range-aware local server + pause/resume + integrity.
// Runs entirely against a spawned downloadX server — no external network needed.
// The local test servers live on 127.0.0.1 - allow the private network in tests.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

// Run: node test/local-test.mjs   (or: npm run test:local)
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-local-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const BLOB = crypto.randomBytes(12 * 1024 * 1024);
const BLOB_HASH = crypto.createHash('sha256').update(BLOB).digest('hex');
let openConns = 0;
let maxConns = 0;

const fileServer = http.createServer((req, res) => {
  openConns++;
  maxConns = Math.max(maxConns, openConns);
  req.on('close', () => openConns--);
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1);
  }
  const len = end - start + 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(len),
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
    'ETag': '"controlled-test-v1"',
    'Accept-Ranges': 'bytes',
  });
  let pos = start;
  const iv = setInterval(() => {
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(64 * 1024, end - pos + 1);
    res.write(BLOB.subarray(pos, pos + n));
    pos += n;
  }, 25);
  req.on('close', () => clearInterval(iv));
});
await new Promise((r) => fileServer.listen(0, '127.0.0.1', r));
const fileBase = `http://127.0.0.1:${fileServer.address().port}`;

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
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    body: payload,
  });
  return res.json();
}
const find = async (id) => (await api('/api/state')).items.find((x) => x.id === id);

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { await api('/api/health'); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start:\n' + logs);
}

try {
  await waitUp();
  console.log(`local range server — blob ${(BLOB.length / 1048576).toFixed(0)}MB, hash ${BLOB_HASH.slice(0, 12)}…`);

  /* --- Test A: 12-connection segmented download, pause at ~4MB, resume, verify hash --- */
  {
    console.log('\n--- Test A: 12 connections, pause mid-flight, resume, sha256 ---');
    const d = await api('/api/downloads', { method: 'POST', body: { url: `${fileBase}/blobA.bin`, segments: 12, dir: TMP } });
    let it;
    for (let i = 0; i < 100; i++) {
      await sleep(400);
      it = await find(d.id);
      if (it && it.received > 4 * 1048576) break;
    }
    console.log('pausing at', (it.received / 1048576).toFixed(1) + 'MB, active segs:', it.segments.filter((s) => s.active).length);
    check('multi-connection engaged', it.segments.filter((s) => s.active).length >= 4, `${maxConns} max server conns seen`);
    await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
    await sleep(1200);
    const pausedAt = (await find(d.id)).received;
    console.log('paused, kept bytes:', (pausedAt / 1048576).toFixed(1) + 'MB');
    await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      it = await find(d.id);
      if (['completed', 'failed'].includes(it.status)) break;
    }
    check('completed after resume', it.status === 'completed', it.error);
    check('exact size', it.received === BLOB.length, `${it.received}/${BLOB.length}`);
    const fileHash = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(it.path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    check('sha256 EXACT MATCH (byte-perfect segmented assembly)', fileHash === BLOB_HASH, fileHash.slice(0, 12) + '…');
  }

  /* --- Test B: rapid pause/resume cycles don't corrupt anything --- */
  {
    console.log('\n--- Test B: pause/resume stress (5 rapid cycles) ---');
    const d = await api('/api/downloads', { method: 'POST', body: { url: `${fileBase}/blobB.bin`, segments: 6, dir: TMP } });
    for (let cycle = 0; cycle < 5; cycle++) {
      await sleep(900);
      await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
      await sleep(400);
      await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
    }
    let it;
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      it = await find(d.id);
      if (['completed', 'failed'].includes(it.status)) break;
    }
    check('survived 5 pause/resume cycles', it.status === 'completed', it.error);
    if (it.status === 'completed') {
      const fileHash = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(it.path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      check('content intact after stress', fileHash === BLOB_HASH, fileHash.slice(0, 12) + '…');
    }
  }

  console.log(`\nmax simultaneous server connections observed: ${maxConns}`);
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
