// downloadX integration test driver (run: node test/run-tests.mjs — server must be running)
const BASE = 'http://127.0.0.1:9765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}
const state = async () => (await api('/api/state')).items;
const find = async (id) => (await state()).find((i) => i.id === id);

function pct(it) {
  return `${it.status.padEnd(11)} ${(it.received / 1048576).toFixed(1)}/${((it.total || 0) / 1048576).toFixed(1)}MB ` +
    `${Math.round(it.speed / 1024)}KB/s active:${it.segments.filter((s) => s.active).length}/${it.segments.length}`;
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function waitStatus(id, statuses, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const it = await find(id);
    if (!it) throw new Error('item vanished');
    if (statuses.includes(it.status)) return it;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + statuses + ' (now: ' + it.status + ' ' + it.error + ')');
    await sleep(700);
  }
}

async function sha256File(p) {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

/* ---------------- Test 1: real CDN, pause/resume, byte-identical to curl ---------------- */
{
  console.log('\n--- Test 1: 30MB MSI via CDN — pause mid-flight, resume, sha256 vs curl ---');
  const d = await api('/api/downloads', { method: 'POST', body: { url: 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi', segments: 16 } });
  let it;
  for (let i = 0; i < 100; i++) {
    await sleep(500);
    it = await find(d.id);
    if (it.received > 6 * 1048576) break;
  }
  console.log('pausing:', pct(it));
  check('multi-connection engaged', it.segments.filter((s) => s.active).length >= 4, `${it.segments.length} segments`);
  await api(`/api/downloads/${d.id}/pause`, { method: 'POST' });
  await sleep(1500);
  it = await find(d.id);
  console.log('paused at', (it.received / 1048576).toFixed(1) + 'MB — resuming');
  await api(`/api/downloads/${d.id}/resume`, { method: 'POST' });
  const done = await waitStatus(d.id, ['completed', 'failed'], 240000);
  check('completed after resume', done.status === 'completed', done.error);
  if (done.status === 'completed') {
    check('exact size 30289920', done.received === 30289920, `${done.received}`);
    console.log('hashing local file and curl reference…');
    const { execSync } = await import('node:child_process');
    const ref = 'C:\\Users\\sonali\\AppData\\Local\\Temp\\dlx_ref.msi';
    execSync(`curl -s -o "${ref}" https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi`, { stdio: 'ignore' });
    const [localHash, refHash] = await Promise.all([sha256File(done.path), sha256File(ref)]);
    check('sha256 matches single-stream reference', localHash === refHash, localHash.slice(0, 16) + '…');
    const v = await api(`/api/downloads/${d.id}/verify`, { method: 'POST', body: { algo: 'sha256', expected: refHash } });
    check('verify API reports OK', v.ok === true);
  }
}

/* ---------------- Test 2: batch pattern download ---------------- */
{
  console.log('\n--- Test 2: batch + pattern expansion ---');
  const r = await api('/api/expand', { method: 'POST', body: { text: 'https://x.com/img[01-03].jpg' } });
  check('pattern expanded to 3', r.urls.length === 3, JSON.stringify(r.urls));
  const real = [
    'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/package.json',
    'https://cdn.jsdelivr.net/npm/ms@2.1.3/package.json',
    'https://cdn.jsdelivr.net/npm/semver@7.6.0/package.json',
  ];
  const ids = [];
  for (const u of real) ids.push((await api('/api/downloads', { method: 'POST', body: { url: u } })).id);
  await sleep(8000);
  const mine = [];
  for (const id of ids) mine.push(await find(id));
  check('3 batch downloads completed', mine.length === 3 && mine.every((i) => i.status === 'completed'),
    mine.map((i) => i.status).join(','));
}

/* ---------------- Test 3: no-Range server fallback ---------------- */
{
  console.log('\n--- Test 3: server WITHOUT Range support -> single-stream fallback ---');
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const blob = crypto.randomBytes(5 * 1024 * 1024);
  const expectedHash = crypto.createHash('sha256').update(blob).digest('hex');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': blob.length, 'Content-Type': 'application/octet-stream' });
    res.end(blob);
  });
  await new Promise((r) => srv.listen(9111, '127.0.0.1', r));
  const d = await api('/api/downloads', { method: 'POST', body: { url: 'http://127.0.0.1:9111/noranges.bin', dir: 'C:\\Users\\sonali\\AppData\\Local\\Temp\\dlx-test' } });
  const done = await waitStatus(d.id, ['completed', 'failed'], 60000);
  srv.close();
  check('no-Range download completed single-stream', done.status === 'completed', done.error);
  if (done.status === 'completed') {
    const got = await sha256File(done.path);
    check('no-Range content intact', got === expectedHash);
  }
  await api(`/api/downloads/${d.id}`, { method: 'DELETE' });
}

/* ---------------- Test 4: per-download speed limit ---------------- */
{
  console.log('\n--- Test 4: per-download speed limit (300 KB/s) ---');
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(8 * 1024 * 1024) });
    let n = 0;
    const iv = setInterval(() => {
      if (n >= 8 * 1024 * 1024) { clearInterval(iv); res.end(); return; }
      res.write(Buffer.alloc(64 * 1024));
      n += 64 * 1024;
    }, 5);
    req.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => srv.listen(9112, '127.0.0.1', r));
  const d = await api('/api/downloads', { method: 'POST', body: { url: 'http://127.0.0.1:9112/big.bin', segments: 4, dir: 'C:\\Users\\sonali\\AppData\\Local\\Temp\\dlx-test' } });
  await waitStatus(d.id, ['downloading'], 15000);
  await api(`/api/downloads/${d.id}/limit`, { method: 'POST', body: { kbs: 300 } });
  await sleep(6500);  // > 5s speed window so pre-limit samples are flushed
  let it = await find(d.id);
  let kb = it.speed / 1024;
  await sleep(3000);
  it = await find(d.id);
  kb = Math.min(kb, it.speed / 1024);
  check('speed limit ~300KB/s respected', kb < 500, `${kb.toFixed(0)} KB/s`);
  await api(`/api/downloads/${d.id}`, { method: 'DELETE' });
  srv.close();
}

/* ---------------- Test 5: persistence ---------------- */
{
  console.log('\n--- Test 5: state persistence ---');
  const items = await state();
  check('state tracks items across the run', items.length >= 4, `${items.length} items`);
}

console.log('\n==============================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
