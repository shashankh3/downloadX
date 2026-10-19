// In-process engine debug: local range server, pause at ~4MB, resume, watch every request.
// Run: node test/debug-resume.mjs
process.env.DLX_DEBUG = '1';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine } = require('../lib/engine.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-dbg-'));
const BLOB = crypto.randomBytes(12 * 1024 * 1024);
const srv = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1); }
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
    'ETag': '"dbg-v1"',
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
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
console.log('== range server up, engine starting ==');

const engine = new Engine(path.join(TMP, 'data'));
engine.settings.rootDir = path.join(TMP, 'files');
engine.settings.maxConcurrent = 1;

const d = engine.add({ urls: [`${base}/blob.bin`], segments: 6 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let it;
for (let i = 0; i < 100; i++) {
  await sleep(400);
  it = engine.get(d.id);
  if (it.received > 4 * 1048576) break;
}
console.log(`\n== PAUSE at ${(it.received / 1048576).toFixed(1)}MB ==`);
await d.pause('user');
await sleep(1000);
console.log(`\n== RESUME (kept ${(it.received / 1048576).toFixed(1)}MB) ==`);
d.resume();
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const x = engine.get(d.id);
  const segs = x.segments.map((s) => `${(s.downloaded / 1048576).toFixed(2)}/${((s.end - s.start + 1) / 1048576).toFixed(2)}`).join(' ');
  console.log(`t+${i}s ${x.status} rec=${(x.received / 1048576).toFixed(2)}MB spd=${(x.speed / 1024).toFixed(0)}KB/s w=${x.workers} lk=${x._lockedSegs.size} err=${x.error || '-'}`);
  console.log('   segs:', segs);
  if (['completed', 'failed'].includes(x.status)) break;
}
const fin = engine.get(d.id);
console.log('FINAL:', fin.status, fin.error || '');
engine.close();
srv.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
process.exit(fin.status === 'completed' ? 0 : 1);
