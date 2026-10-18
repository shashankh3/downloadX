// Controlled experiment: range-aware local server + pause/resume + integrity.
// Eliminates the network variable entirely — proves engine correctness.
const BASE = 'http://127.0.0.1:9765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = await import('node:http');
const crypto = await import('node:crypto');
const { createHash } = crypto;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

/* --- build a 25MB blob served WITH range support, throttled per connection --- */
const BLOB = crypto.randomBytes(25 * 1024 * 1024);
const BLOB_HASH = createHash('sha256').update(BLOB).digest('hex');
let openConns = 0; let maxConns = 0;

const srv = http.createServer((req, res) => {
  openConns++; maxConns = Math.max(maxConns, openConns);
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
  const iv = setInterval(() => {          // ~2.5 MB/s per connection, 64KB chunks
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(64 * 1024, end - pos + 1);
    res.write(BLOB.subarray(pos, pos + n));
    pos += n;
  }, 25);
  req.on('close', () => clearInterval(iv));
});
await new Promise((r) => srv.listen(9113, '127.0.0.1', r));
console.log('local range server on :9113 — blob', (BLOB.length / 1048576).toFixed(0) + 'MB, hash', BLOB_HASH.slice(0, 12) + '…');

const TMP = 'C:\\Users\\sonali\\AppData\\Local\\Temp\\dlx-test';

/* --- Test A: 12-connection segmented download, pause at ~8MB, resume, verify hash --- */
{
  console.log('\n--- Test A: 12 connections, pause mid-flight, resume, sha256 ---');
  const d = await api('/api/downloads', { method: 'POST', body: { url: 'http://127.0.0.1:9113/blobA.bin', segments: 12, dir: TMP } });
  // wait for ~8MB
  let it;
  for (let i = 0; i < 100; i++) {
    await sleep(400);
    it = (await api('/api/state')).items.find((x) => x.id === d.id);
    if (it && it.received > 8 * 1048576) break;
  }
  console.log('pausing at', (it.received / 1048576).toFixed(1) + 'MB, active segs:', it.segments.filter((s) => s.active).length);
  check('multi-connection engaged', it.segments.filter((s) => s.active).length >= 6, `${maxConns} max server conns seen`);
  await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
  await sleep(1500);
  const pausedAt = (await api('/api/state')).items.find((x) => x.id === d.id).received;
  console.log('paused, kept bytes:', (pausedAt / 1048576).toFixed(1) + 'MB');
  await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
  // wait for completion
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    it = (await api('/api/state')).items.find((x) => x.id === d.id);
    if (['completed', 'failed'].includes(it.status)) break;
  }
  check('completed after resume', it.status === 'completed', it.error);
  check('exact size', it.received === BLOB.length, `${it.received}/${BLOB.length}`);
  const { createReadStream } = await import('node:fs');
  const fileHash = await new Promise((res2) => {
    const h = createHash('sha256');
    createReadStream(it.path).on('data', (c) => h.update(c)).on('end', () => res2(h.digest('hex')));
  });
  check('sha256 EXACT MATCH (byte-perfect segmented assembly)', fileHash === BLOB_HASH, fileHash.slice(0, 12) + '…');
}

/* --- Test B: rapid pause/preview/pause cycles don't corrupt anything --- */
{
  console.log('\n--- Test B: pause/resume stress (5 rapid cycles) ---');
  const d = await api('/api/downloads', { method: 'POST', body: { url: 'http://127.0.0.1:9113/blobB.bin', segments: 6, dir: TMP } });
  for (let cycle = 0; cycle < 5; cycle++) {
    await sleep(1800);
    await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
    await sleep(700);
    await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
  }
  let it;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    it = (await api('/api/state')).items.find((x) => x.id === d.id);
    if (['completed', 'failed'].includes(it.status)) break;
  }
  check('survived 5 pause/resume cycles', it.status === 'completed', it.error);
  if (it.status === 'completed') {
    const { createReadStream } = await import('node:fs');
    const fileHash = await new Promise((res2) => {
      const h = createHash('sha256');
      createReadStream(it.path).on('data', (c) => h.update(c)).on('end', () => res2(h.digest('hex')));
    });
    check('content intact after stress', fileHash === BLOB_HASH, fileHash.slice(0, 12) + '…');
  }
}

console.log(`\nmax simultaneous server connections observed: ${maxConns}`);
srv.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
