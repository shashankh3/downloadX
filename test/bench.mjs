// Benchmark: same 25MB file, 1 connection vs 16 connections (1.25 MB/s per-connection cap).
// Spawns its own downloadX server on a free port — no external network needed.
// Run: node test/bench.mjs   (or: npm run bench)
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-bench-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const BLOB = crypto.randomBytes(25 * 1024 * 1024);
const fileServer = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1); }
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
  });
  let pos = start;
  const iv = setInterval(() => {
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(128 * 1024, end - pos + 1);
    res.write(BLOB.subarray(pos, pos + n));
    pos += n;
  }, 100);
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
    headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: payload,
  });
  return res.json();
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { await api('/api/health'); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start:\n' + logs);
}

async function run(name, segments) {
  const d = await api('/api/downloads', {
    method: 'POST',
    body: { url: `${fileBase}/bench.bin`, segments, dir: TMP, filename: `${name.replace(/\s+/g, '-')}.bin` },
  });
  const t0 = Date.now();
  for (;;) {
    await sleep(300);
    const it = await api(`/api/downloads/${d.id}`);
    if (['completed', 'failed'].includes(it.status)) {
      const secs = (Date.now() - t0) / 1000;
      const mbps = 25 / secs;
      return { name, secs, mbps, status: it.status, segs: it.segments.length, error: it.error };
    }
  }
}

try {
  await waitUp();
  const single = await run('1 connection', 1);
  const multi = await run('16 connections', 16);
  console.log(`${single.name}: 25 MB in ${single.secs.toFixed(1)}s = ${single.mbps.toFixed(2)} MB/s (${single.status})`);
  console.log(`${multi.name}: 25 MB in ${multi.secs.toFixed(1)}s = ${multi.mbps.toFixed(2)} MB/s (${multi.status})`);
  console.log(`speedup: ${(multi.mbps / single.mbps).toFixed(1)}x`);
  if (single.status !== 'completed' || multi.status !== 'completed') process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try { fileServer.close(); } catch { /* gone */ }
  try { child.kill(); } catch { /* already exited */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
}
process.exit(process.exitCode || 0);
