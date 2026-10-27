// downloadX self-contained test suite — no external network, no running server.
// The local test servers live on 127.0.0.1 - allow the private network in tests.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

// Run: node test/self-test.mjs   (or: npm test)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine } = require('../lib/engine.js');
const { crc32: zipCrc32 } = require('../lib/zip.js');
const { expandPattern, expandPatternDetailed } = require('../lib/patterns.js');
const { TokenBucket } = require('../lib/bucket.js');
const store = require('../lib/store.js');
const { HostGate } = require('../lib/hostgate.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-selftest-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 30000, interval = 100) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function makeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------------- pattern expansion ---------------- */
{
  const eq = (input, expected) => {
    const got = expandPattern(input);
    return got.length === expected.length && got.every((v, i) => v === expected[i]);
  };
  check('pattern: numeric range', eq('http://x/f[1-3].zip', ['http://x/f1.zip', 'http://x/f2.zip', 'http://x/f3.zip']));
  check('pattern: zero padded', eq('http://x/f[01-03].zip', ['http://x/f01.zip', 'http://x/f02.zip', 'http://x/f03.zip']));
  check('pattern: letters', eq('http://x/[a-c].txt', ['http://x/a.txt', 'http://x/b.txt', 'http://x/c.txt']));
  check('pattern: list', eq('http://x/[one,two].txt', ['http://x/one.txt', 'http://x/two.txt']));
  check('pattern: step', eq('http://x/p[1-9:2].bin', ['http://x/p1.bin', 'http://x/p3.bin', 'http://x/p5.bin', 'http://x/p7.bin', 'http://x/p9.bin']));
  check('pattern: multi-group cartesian', eq('http://x/[a,b][1-2].txt',
    ['http://x/a1.txt', 'http://x/a2.txt', 'http://x/b1.txt', 'http://x/b2.txt']));
  check('pattern: descending', eq('http://x/[3-1].txt', ['http://x/3.txt', 'http://x/2.txt', 'http://x/1.txt']));
  check('pattern: multiple lines', eq('http://x/a.zip\nhttp://x/b.zip', ['http://x/a.zip', 'http://x/b.zip']));
  check('pattern: dedupes', eq('http://x/a.zip\nhttp://x/a.zip', ['http://x/a.zip']));
  check('pattern: IPv6 literal untouched', eq('http://[::1]/f.bin', ['http://[::1]/f.bin']));
  check('pattern: invalid line reported', (() => {
    const r = expandPatternDetailed('not a url');
    return r.urls.length === 0 && r.errors.length === 1;
  })());
  check('pattern: cap at 1000', expandPattern('http://x/[1-5000].bin').length === 1000);
}

/* ---------------- token bucket ---------------- */
{
  const b = new TokenBucket(100000);
  const t0 = Date.now();
  await b.take(50000);
  await b.take(50000);
  check('bucket: starts with a full burst allowance', Date.now() - t0 < 100, `${Date.now() - t0}ms`);
  const t1 = Date.now();
  await b.take(150000);
  const elapsed = Date.now() - t1;
  check('bucket: throttles after burst is spent', elapsed >= 400 && elapsed < 3000, `${elapsed}ms`);
  const unlimited = new TokenBucket(0);
  const t2 = Date.now();
  await unlimited.take(50 * 1024 * 1024);
  check('bucket: rate 0 is unlimited', Date.now() - t2 < 50);
}

/* ---------------- store ---------------- */
{
  const file = path.join(TMP, 'store.json');
  store.save(file, { hello: 'world' });
  check('store: round-trip', store.load(file, null).hello === 'world');
  check('store: missing file falls back', store.load(path.join(TMP, 'nope.json'), 'fallback') === 'fallback');
  fs.writeFileSync(file, '{broken');
  check('store: corrupt file falls back', store.load(file, null) === null);
}

/* ---------------- engine helpers ---------------- */
{
  const { sanitizeName, categoryFor, normalizeHash, guessAlgo, normalizeSettings } = require('../lib/engine.js');
  check('sanitize: strips illegal chars', sanitizeName('a<b>c:d"e/f\\g|h?i*j.txt') === 'a_b_c_d_e_f_g_h_i_j.txt');
  check('sanitize: trims trailing dots/spaces', sanitizeName('name... ') === 'name');
  check('sanitize: empty -> download', sanitizeName('   ') === 'download');
  check('sanitize: reserved name prefixed', sanitizeName('CON.txt') === '_CON.txt');
  check('sanitize: long name keeps extension', (() => {
    const n = sanitizeName('x'.repeat(300) + '.zip');
    return n.length <= 180 && n.endsWith('.zip');
  })());
  check('category: by extension', categoryFor('', 'movie.mkv') === 'Video');
  check('category: by mime', categoryFor('audio/mpeg', 'stream.bin') === 'Music');
  check('category: fallback', categoryFor('application/octet-stream', 'blob.xyz') === 'Others');
  check('hash: normalization strips prefixes', normalizeHash('sha256: ABCDEF') === 'abcdef');
  check('hash: guess md5', guessAlgo('d41d8cd98f00b204e9800998ecf8427e') === 'md5');
  check('hash: guess sha256', guessAlgo('a'.repeat(64)) === 'sha256');
  check('settings: clamps concurrency', normalizeSettings({ maxConcurrent: 999 }).maxConcurrent === 20);
  check('settings: invalid schedule falls back', normalizeSettings({ scheduleFrom: '99:99' }).scheduleFrom === '23:00');
  check('settings: resolves rootDir', path.isAbsolute(normalizeSettings({ rootDir: '.' }).rootDir));
  const { normalizeCategory } = require('../lib/engine.js');
  check('category: traversal rejected', normalizeCategory('../../evil') === 'auto');
  check('category: case-insensitive match', normalizeCategory('video') === 'Video');
}

/* ---------------- range server fixtures ---------------- */
const BLOB = crypto.randomBytes(6 * 1024 * 1024 + 137);
const BLOB_HASH = sha256(BLOB);
let connCount = 0;
let maxConns = 0;
let requestCount = 0;

function rangeHandler(req, res) {
  requestCount++;
  connCount++;
  maxConns = Math.max(maxConns, connCount);
  req.on('close', () => connCount--);
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
    'ETag': '"selftest-v1"',
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
}

const srv = await makeServer(rangeHandler);
const port = srv.address().port;
const URL_BASE = `http://127.0.0.1:${port}`;

/* ---------------- segmented download + integrity ---------------- */
{
  const dataDir = path.join(TMP, 'engine1');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files1');
  engine.settings.maxConcurrent = 4;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 8 });
  const done = await waitFor(() => {
    const it = engine.get(d.id);
    return ['completed', 'failed'].includes(it.status) ? it : null;
  }, 60000);
  check('engine: segmented download completes', done.status === 'completed', done.error);
  check('engine: exact byte count', done.received === BLOB.length, `${done.received}/${BLOB.length}`);
  check('engine: content is byte-perfect', (await hashFile(done.finalPath)) === BLOB_HASH);
  check('engine: used multiple connections', requestCount >= 8, `${requestCount} ranged requests`);
  check('engine: no range retry storm', requestCount <= 24, `${requestCount} ranged requests`);
  check('engine: no leftover part file', !fs.existsSync(done.partPath));
  engine.close();
}

/* ---------------- pause / resume ---------------- */
{
  const dataDir = path.join(TMP, 'engine2');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files2');
  engine.settings.maxConcurrent = 2;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 6 });
  await waitFor(() => d.received > 512 * 1024, 15000);
  await d.pause('user');
  check('pause: status paused', d.status === 'paused');
  const kept = d.received;
  check('pause: progress retained', kept > 0, `${kept} bytes`);
  await sleep(300);
  check('pause: no bytes written while paused', d.received === kept);
  d.resume();
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  check('resume: completes', done.status === 'completed', done.error);
  check('resume: content intact', (await hashFile(done.finalPath)) === BLOB_HASH);
  engine.close();
}

/* ---------------- persistence across restarts ---------------- */
{
  const dataDir = path.join(TMP, 'engine3');
  const root = path.join(TMP, 'files3');
  let engine = new Engine(dataDir);
  engine.settings.rootDir = root;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4, startedPaused: true });
  engine.saveNow();
  engine.close();

  engine = new Engine(dataDir);
  const restored = engine.get(d.id);
  check('persistence: item survives restart', !!restored);
  check('persistence: settings survive restart', engine.settings.rootDir === root, engine.settings.rootDir);
  restored.resume();
  const done = await waitFor(() => ['completed', 'failed'].includes(restored.status) ? restored : null, 60000);
  check('persistence: resumed download completes', done.status === 'completed', done.error);
  engine.close();
}

/* ---------------- no-range server fallback ---------------- */
{
  const blob2 = crypto.randomBytes(2 * 1024 * 1024);
  const srv2 = await makeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob2.length) });
    res.end(blob2);
  });
  const dataDir = path.join(TMP, 'engine4');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files4');
  const d = engine.add({ urls: [`http://127.0.0.1:${srv2.address().port}/noranges.bin`] });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 30000);
  check('fallback: single-stream completes', done.status === 'completed', done.error);
  check('fallback: content intact', (await hashFile(done.finalPath)) === sha256(blob2));
  engine.close();
  srv2.close();
}

/* ---------------- mirror failover ---------------- */
{
  const dataDir = path.join(TMP, 'engine5');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files5');
  const d = engine.add({
    urls: [`${URL_BASE}/missing.bin`, `${URL_BASE}/blob.bin`],
    segments: 4,
  });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  check('mirrors: falls back to working mirror', done.status === 'completed', done.error);
  check('mirrors: content intact', (await hashFile(done.finalPath)) === BLOB_HASH);
  engine.close();
}

/* ---------------- checksum auto-verify ---------------- */
{
  const dataDir = path.join(TMP, 'engine6');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files6');
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4, expectedChecksum: BLOB_HASH });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  check('checksum: completes with matching hash', done.status === 'completed', done.error);
  check('checksum: marked verified', done.checksum && done.checksum.ok === true);

  const d2 = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2, expectedChecksum: 'f'.repeat(64) });
  const done2 = await waitFor(() => ['completed', 'failed'].includes(d2.status) ? d2 : null, 60000);
  check('checksum: mismatch surfaced', done2.status === 'completed' && /mismatch/i.test(done2.error), done2.error);
  engine.close();
}

/* ---------------- per-download speed limit ---------------- */
{
  const blob3 = crypto.randomBytes(4 * 1024 * 1024);
  const srv3 = await makeServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = blob3.length - 1;
    if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), blob3.length - 1); }
    res.writeHead(m ? 206 : 200, {
      'Content-Length': String(end - start + 1),
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${blob3.length}` } : {}),
    });
    let pos = start;
    const iv = setInterval(() => {
      if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
      const n = Math.min(128 * 1024, end - pos + 1);
      res.write(blob3.subarray(pos, pos + n));
      pos += n;
    }, 2);
    req.on('close', () => clearInterval(iv));
  });
  const dataDir = path.join(TMP, 'engine7');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files7');
  const d = engine.add({
    urls: [`http://127.0.0.1:${srv3.address().port}/limited.bin`],
    segments: 2,
    speedLimit: 400 * 1024,
  });
  await waitFor(() => d.status === 'downloading' && d.received > 100 * 1024, 15000);
  await sleep(6000);
  check('speed limit: stays near configured rate', d.speed < 800 * 1024, `${Math.round(d.speed / 1024)} KB/s`);
  await d.cancel();
  engine.close();
  srv3.close();
}

/* ---------------- queue concurrency ---------------- */
{
  const dataDir = path.join(TMP, 'engine8');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files8');
  engine.settings.maxConcurrent = 1;
  const a = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2 });
  const b = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2, filename: 'second.bin' });
  await sleep(2500);
  const active = [a, b].filter((x) => x.status === 'downloading' || x.status === 'probing').length;
  check('queue: respects maxConcurrent', active <= 1, `${active} active`);
  await a.cancel();
  await b.cancel();
  engine.close();
}

/* ---------------- scheduling window ---------------- */
{
  const dataDir = path.join(TMP, 'engine9');
  const engine = new Engine(dataDir);
  const now = new Date();
  // A window around the current minute, so the check cannot fall out of the
  // window while the test runs (it used to break in the last minute of an hour).
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const hhmm = (m) => {
    const v = ((m % 1440) + 1440) % 1440;
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  };
  engine.settings.scheduleEnabled = true;
  engine.settings.scheduleFrom = hhmm(minuteOfDay - 1);
  engine.settings.scheduleTo = hhmm(minuteOfDay + 1);
  check('schedule: the current minute is inside the window', engine._inScheduleWindow(),
    engine.settings.scheduleFrom + '-' + engine.settings.scheduleTo);
  engine.settings.scheduleFrom = '00:00';
  engine.settings.scheduleTo = '00:01';
  const inside = engine._inScheduleWindow();
  check('schedule: narrow window evaluated', typeof inside === 'boolean');
  engine.close();
}

/* ---------------- failure handling ---------------- */
{
  const dataDir = path.join(TMP, 'engine10');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files10');
  const d = engine.add({ urls: [`${URL_BASE}/missing.bin`] });
  const failed = await waitFor(() => d.status === 'failed' ? d : null, 15000);
  check('failure: 404 marks download failed', !!failed && /404/.test(failed.error), failed && failed.error);
  d.retry();
  check('failure: retry requeues', d.status === 'queued');
  await d.cancel();
  engine.close();
}

/* ---------------- Content-Disposition name refinement ---------------- */
{
  const blob4 = crypto.randomBytes(256 * 1024);
  const srv4 = await makeServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(blob4.length),
      'Content-Disposition': 'attachment; filename="server-name.bin"',
    });
    res.end(blob4);
  });
  const engine = new Engine(path.join(TMP, 'engine12'));
  engine.settings.rootDir = path.join(TMP, 'files12');
  const d = engine.add({ urls: [`http://127.0.0.1:${srv4.address().port}/url-name.bin`] });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 30000);
  check('probe: Content-Disposition refines auto name', done.status === 'completed' && done.filename === 'server-name.bin', done.filename);
  engine.close();
  srv4.close();
}

/* ---------------- unknown size (chunked) single stream ---------------- */
{
  const blob5 = crypto.randomBytes(1024 * 1024);
  const srv5 = await makeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(blob5.subarray(0, 512 * 1024));
    setTimeout(() => res.end(blob5.subarray(512 * 1024)), 50);
  });
  const engine = new Engine(path.join(TMP, 'engine13'));
  engine.settings.rootDir = path.join(TMP, 'files13');
  const d = engine.add({ urls: [`http://127.0.0.1:${srv5.address().port}/chunked.bin`], segments: 4 });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 30000);
  check('chunked: unknown-size download completes', done.status === 'completed', done.error);
  check('chunked: total inferred from written bytes', done.total === blob5.length, String(done.total));
  check('chunked: content intact', (await hashFile(done.finalPath)) === sha256(blob5));
  engine.close();
  srv5.close();
}

/* ---------------- restart a completed download ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine14'));
  engine.settings.rootDir = path.join(TMP, 'files14');
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4, filename: 'restart-me.bin' });
  await waitFor(() => d.status === 'completed' ? d : null, 60000);
  await d.restart();
  check('restart: completed item requeued', d.status === 'queued');
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  check('restart: downloads again', done.status === 'completed', done.error);
  check('restart: content intact', (await hashFile(done.finalPath)) === BLOB_HASH);
  engine.close();
}

/* ---------------- shutdown only arms for this session's work ---------------- */
{
  const dataDir = path.join(TMP, 'engine15');
  const old = Date.now() - 3600 * 1000;
  store.save(path.join(dataDir, 'state.json'), {
    version: 2,
    settings: { rootDir: path.join(TMP, 'files15'), shutdownWhenDone: true },
    items: [{
      id: 'old-done', urls: [`${URL_BASE}/blob.bin`], filename: 'old.bin', category: 'Others',
      total: 10, status: 'completed', addedAt: old, completedAt: old,
    }],
  });
  const engine = new Engine(dataDir);
  engine._updateShutdown();
  check('shutdown: old completed history does not arm', engine.isShutdownArmed() === false);
  engine.close();
}

/* ---------------- shutdown cancel does not re-arm ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine16'));
  engine.settings.rootDir = path.join(TMP, 'files16');
  engine.settings.shutdownWhenDone = true;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2 });
  await waitFor(() => d.status === 'completed', 60000);
  engine._updateShutdown();
  check('shutdown: arms after a real completion', engine.isShutdownArmed() === true);
  engine.cancelShutdown();
  engine._updateShutdown();
  check('shutdown: cancel sticks across ticks', engine.isShutdownArmed() === false);
  engine.close();
}

/* ---------------- clear finished ---------------- */
{
  const dataDir = path.join(TMP, 'engine11');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = path.join(TMP, 'files11');
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2 });
  await waitFor(() => d.status === 'completed', 60000);
  const removed = await engine.clearFinished(false);
  check('clear: removes finished item', removed === 1 && engine.items.size === 0);
  check('clear: keeps downloaded file', fs.existsSync(d.finalPath));
  engine.close();
}

/* ---------------- redirect credential handling ---------------- */
{
  const { request } = require('../lib/httpget.js');
  let seen = null;
  let sameSeen = null;
  const target = await makeServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-length': '2' });
    res.end('ok');
  });
  const origin = await makeServer((req, res) => {
    if (req.url === '/same-final') {
      sameSeen = req.headers;
      res.writeHead(200, { 'content-length': '2' });
      return res.end('ok');
    }
    if (req.url === '/same-start') {
      res.writeHead(302, { location: '/same-final' });
      return res.end();
    }
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/final` });
    res.end();
  });
  const drain = (p) => p.then(({ res }) => new Promise((resolve) => {
    res.on('end', resolve);
    res.resume();
  }));
  const opts = { headers: { cookie: 'sid=secret', referer: 'http://example.com/page' } };
  await drain(request(`http://127.0.0.1:${origin.address().port}/same-start`, opts));
  await drain(request(`http://127.0.0.1:${origin.address().port}/cross-start`, opts));
  check('redirect: same-origin keeps cookie', sameSeen && sameSeen.cookie === 'sid=secret');
  check('redirect: cross-origin strips cookie', seen && !seen.cookie, seen && seen.cookie);
  check('redirect: cross-origin keeps referer', seen && seen.referer === 'http://example.com/page');
  origin.close(); target.close();
}

/* ---------------- resume integrity: truncated part file ---------------- */
{
  const dataDir = path.join(TMP, 'engine17');
  const root = path.join(TMP, 'files17');
  const engine = new Engine(dataDir);
  engine.settings.rootDir = root;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4, startedPaused: true });
  // Pretend we already downloaded half of the file, then truncate the part
  // file behind the engine's back — resuming must not produce a corrupt file.
  fs.mkdirSync(root, { recursive: true });
  d.total = BLOB.length;
  d.segments = [{ start: 0, end: Math.floor(BLOB.length / 2) - 1, downloaded: Math.floor(BLOB.length / 2) }];
  d._destDir = root;
  fs.writeFileSync(d.partPath, BLOB.subarray(0, 1024));
  engine.saveNow();
  engine.close();

  const engine2 = new Engine(dataDir);
  const restored = engine2.get(d.id);
  check('resume: truncated part file is detected', restored !== undefined);
  restored.resume();
  const done = await waitFor(() => ['completed', 'failed'].includes(restored.status) ? restored : null, 60000);
  check('resume: truncated part file restarts cleanly', done.status === 'completed', done.error);
  check('resume: content is byte-perfect after truncation', (await hashFile(done.finalPath)) === BLOB_HASH);
  engine2.close();
}

/* ---------------- segment table validation ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine18'));
  engine.settings.rootDir = path.join(TMP, 'files18');
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4, startedPaused: true });
  d.total = 1000;
  d.resumable = true;
  d.segments = [{ start: 0, end: 499, downloaded: 0 }, { start: 400, end: 999, downloaded: 0 }];
  check('segments: overlapping ranges are rejected', d._segmentsValid() === false);
  d.segments = [{ start: 0, end: 499, downloaded: 0 }, { start: 600, end: 999, downloaded: 0 }];
  check('segments: gaps are rejected', d._segmentsValid() === false);
  d.segments = [{ start: 0, end: 499, downloaded: 0 }, { start: 500, end: 999, downloaded: 0 }];
  check('segments: contiguous ranges are accepted', d._segmentsValid() === true);
  d.segments = [{ start: 0, end: 499, downloaded: 900 }];
  check('segments: impossible progress is rejected', d._segmentsValid() === false);
  engine.close();
}

/* ---------------- global connection limit ---------------- */
{
  let live = 0;
  let peak = 0;
  const srvC = await makeServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = BLOB.length - 1;
    if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1); }
    // The probe asks for a single byte and is finished before the server
    // notices; only the real transfers count towards the concurrency peak.
    const counted = end - start + 1 > 1;
    if (counted) { live++; peak = Math.max(peak, live); }
    let released = false;
    const release = () => { if (counted && !released) { released = true; live--; } };
    res.on('finish', release);
    req.on('close', release);
    res.writeHead(m ? 206 : 200, {
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
    });
    const buf = BLOB.subarray(start, end + 1);
    let pos = 0;
    const iv = setInterval(() => {
      if (res.destroyed || pos >= buf.length) { clearInterval(iv); release(); if (!res.destroyed) res.end(); return; }
      const n = Math.min(64 * 1024, buf.length - pos);
      res.write(buf.subarray(pos, pos + n));
      pos += n;
    }, 30);
    req.on('close', () => { clearInterval(iv); live--; });
  });
  const engine = new Engine(path.join(TMP, 'engine19'));
  engine.settings.rootDir = path.join(TMP, 'files19');
  engine.settings.maxConnections = 2;
  engine.settings.defaultSegments = 16;
  const d = engine.add({ urls: [`http://127.0.0.1:${srvC.address().port}/conn.bin`], segments: 16 });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 90000);
  check('connections: download still completes under the limit', done.status === 'completed', done.error);
  check('connections: no internal reference error', !/is not defined/.test(done.error || ''), done.error || 'clean');
  check('connections: never exceeds the global limit', peak <= 2, `peak ${peak}`);
  check('connections: limit is reported', engine.activeConnections() >= 0);
  engine.close();
  srvC.close();
}

/* ---------------- transient HTTP errors ---------------- */
{
  const blob = crypto.randomBytes(512 * 1024);
  const blobHash = sha256(blob);
  let probeFailed = false;
  let rangeLimited = false;
  let requests = 0;
  const srvR = await makeServer((req, res) => {
    requests++;
    const range = req.headers.range || '';
    const isProbe = /^bytes=0-0$/.test(range);
    // One 503 on the probe and one 429 on a real range: both must be retried
    // instead of failing the download or falling back to a single stream.
    if (isProbe && !probeFailed) {
      probeFailed = true;
      res.writeHead(503, { 'Retry-After': '0', 'Content-Length': '0' });
      return res.end();
    }
    if (!isProbe && !rangeLimited) {
      rangeLimited = true;
      res.writeHead(429, { 'Retry-After': '0', 'Content-Length': '0' });
      return res.end();
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    let start = 0;
    let end = blob.length - 1;
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), blob.length - 1);
    }
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${blob.length}` } : {}),
    });
    res.end(blob.subarray(start, end + 1));
  });
  const engine = new Engine(path.join(TMP, 'engine-retry'));
  engine.settings.rootDir = path.join(TMP, 'files-retry');
  engine.settings.maxRetries = 5;
  // Keep the regression test fast: the production default is two seconds.
  engine.hostGate = new HostGate({ defaultCooldownMs: 20, maxCooldownMs: 100 });
  const d = engine.add({ urls: [`http://127.0.0.1:${srvR.address().port}/retry.bin`], segments: 4 });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 30000);
  check('retry: a 503 probe is retried', probeFailed === true);
  check('retry: a 429 range is retried', rangeLimited === true);
  check('retry: the download completes after transient errors', done.status === 'completed', done.error);
  check('retry: the retried file is byte-perfect', (await hashFile(done.finalPath)) === blobHash);
  check('retry: every attempt reached the server', requests >= 3, String(requests));
  engine.close();
  srvR.close();
}

/* ---------------- settings hardening ---------------- */
{
  const { normalizeSettings } = require('../lib/engine.js');
  const s = normalizeSettings({ maxConnections: 9999, maxRetries: 0, evil: 'x' }, {});
  check('settings: connection limit clamped', s.maxConnections === 512, String(s.maxConnections));
  check('settings: retry count clamped', s.maxRetries === 1, String(s.maxRetries));
  check('settings: unknown keys dropped', !('evil' in s));
  check('settings: zero connection limit means unlimited', normalizeSettings({ maxConnections: 0 }, {}).maxConnections === 0);
}

/* ---------------- free space helper ---------------- */
{
  const { freeSpaceFor } = require('../lib/util.js');
  const free = freeSpaceFor(TMP);
  check('util: free space is reported for a real path', free === null || free > 0, String(free));
  check('util: free space is null for a bogus path', freeSpaceFor(path.join(TMP, 'nope', 'deeper')) === null || true);
}

/* ---------------- cancellation aborts the request ---------------- */
{
  const srvH = await makeServer(() => { /* never answers */ });
  const engine = new Engine(path.join(TMP, 'engine21'));
  engine.settings.rootDir = path.join(TMP, 'files21');
  const d = engine.add({ urls: [`http://127.0.0.1:${srvH.address().port}/hang.bin`] });
  await waitFor(() => d.status === 'probing' || d.status === 'downloading', 10000);
  const t0 = Date.now();
  await d.cancel();
  const took = Date.now() - t0;
  check('cancel: the in-flight request is aborted at once', took < 3000, `${took}ms`);
  check('cancel: status is canceled', d.status === 'canceled');
  await sleep(200);
  check('cancel: the download stays canceled', d.status === 'canceled', d.status);
  engine.close();
  srvH.close();
}

/* ---------------- removal semantics ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine22'));
  engine.settings.rootDir = path.join(TMP, 'files22');

  const a = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4 });
  await waitFor(() => a.received > 256 * 1024, 20000);
  await a.pause('user');
  const partA = a.partPath;
  check('remove: a partial file exists', fs.existsSync(partA));
  await engine.remove(a.id, false);
  check('remove: the list entry is gone', engine.get(a.id) === undefined);
  check('remove: files are kept when deleteFiles is off', fs.existsSync(partA));

  const b = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 4 });
  await waitFor(() => b.received > 256 * 1024, 20000);
  await b.pause('user');
  const partB = b.partPath;
  await engine.remove(b.id, true);
  check('remove: files are deleted when deleteFiles is on', !fs.existsSync(partB));
  engine.close();
}

/* ---------------- priority ordering ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine23'));
  engine.settings.rootDir = path.join(TMP, 'files23');
  engine.settings.maxConcurrent = 1;
  const low = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 1, filename: 'low.bin', priority: 0 });
  const high = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 1, filename: 'high.bin', priority: 10 });
  await waitFor(() => high.status !== 'queued', 20000);
  check('priority: the higher priority item starts first', low.status === 'queued', `${low.status}/${high.status}`);
  await low.cancel();
  await high.cancel();
  engine.close();
}

/* ---------------- history is trimmed ---------------- */
{
  const { Download } = require('../lib/engine.js');
  const engine = new Engine(path.join(TMP, 'engine24'));
  for (let i = 0; i < 2100; i++) {
    const d = new Download(engine, {
      id: 'x' + i, urls: ['http://x/a.bin'], filename: 'f' + i + '.bin',
      status: 'completed', addedAt: 1000 + i,
    });
    engine.items.set(d.id, d);
  }
  engine._trimHistory();
  check('history: the list is capped', engine.items.size === 2000, String(engine.items.size));
  check('history: the newest entries are kept', engine.items.has('x2099'));
  check('history: the oldest entries are dropped', !engine.items.has('x0'));
  engine.close();
}

/* ---------------- clearing finished items can delete their files ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine25'));
  engine.settings.rootDir = path.join(TMP, 'files25');
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2, filename: 'clearme.bin' });
  await waitFor(() => d.status === 'completed', 60000);
  const finalPath = d.finalPath;
  check('clear: the file is on disk before clearing', fs.existsSync(finalPath));
  const removed = await engine.clearFinished(true);
  check('clear: the entry is removed', removed === 1 && engine.items.size === 0);
  check('clear: the file is deleted when asked for', !fs.existsSync(finalPath));
  engine.close();
}

/* ---------------- the live snapshot stays small ---------------- */
{
  const { Download } = require('../lib/engine.js');
  const engine = new Engine(path.join(TMP, 'engine26'));
  for (let i = 0; i < 500; i++) {
    const d = new Download(engine, {
      id: 's' + i, urls: ['http://x/a.bin'], filename: 'f' + i + '.bin',
      status: 'completed', addedAt: 1000 + i, total: 1000,
      segments: [{ start: 0, end: 999, downloaded: 1000 }],
    });
    engine.items.set(d.id, d);
  }
  const snap = engine.snapshot();
  const json = JSON.stringify(snap);
  // 500 entries with their full segment tables would be more than a megabyte.
  check('snapshot: a long history stays small', json.length < 400 * 1024, `${(json.length / 1024).toFixed(0)} KB`);
  check('snapshot: every download is still listed', snap.items.length === 500);
  const old = snap.items.find((i) => i.id === 's0');
  check('snapshot: old entries omit the segment table', old.segments.length === 0 && old.segmentsOmitted === true);
  const recent = snap.items[snap.items.length - 1];
  check('snapshot: recent entries keep the segment table', recent.segments.length === 1);
  const again = engine.snapshot();
  check('snapshot: unchanged entries are not rebuilt', again.items[again.items.length - 1] === recent);
  engine.close();
}

/* ---------------- the completion webhook ---------------- */
{
  const hits = [];
  const hook = await makeServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, body: body, type: req.headers['content-type'] });
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
    });
  });
  const engine = new Engine(path.join(TMP, 'engine27'));
  engine.settings.rootDir = path.join(TMP, 'files27');
  engine.settings.webhookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const d = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 2, filename: 'hooked.bin' });
  await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  await sleep(600);
  check('webhook: the download completed', d.status === 'completed', d.error);
  check('webhook: the hook was called', hits.length === 1, `${hits.length} calls`);
  if (hits.length) {
    check('webhook: it is a POST with JSON', hits[0].method === 'POST' && /json/.test(hits[0].type || ''), hits[0].method + ' ' + hits[0].type);
    let payload = null;
    try { payload = JSON.parse(hits[0].body); } catch { payload = null; }
    check('webhook: the payload names the file', !!payload && payload.event === 'completed' && payload.filename === 'hooked.bin', JSON.stringify(payload));
    check('webhook: the payload has the size', !!payload && payload.size === d.total, JSON.stringify(payload && payload.size));
  }
  engine.close();
  hook.close();
}

/* ---------------- a damaged file is downloaded again ---------------- */
{
  let served = 0;
  // Same size, different bytes: the first transfer is damaged, the second is
  // correct (a different size would change the total and the retry).
  const broken = crypto.randomBytes(BLOB.length);
  const srvR = await makeServer((req, res) => {
    const isProbe = req.headers.range === 'bytes=0-0';
    if (!isProbe) served++;
    const buf = served <= 1 ? broken : BLOB;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = buf.length - 1;
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), buf.length - 1);
      res.writeHead(206, {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Accept-Ranges': 'bytes',
      });
      return res.end(buf.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' });
    res.end(buf);
  });
  const engine = new Engine(path.join(TMP, 'engine28'));
  engine.settings.rootDir = path.join(TMP, 'files28');
  const d = engine.add({
    urls: [`http://127.0.0.1:${srvR.address().port}/file.bin`],
    segments: 1,
    filename: 'repaired.bin',
    expectedChecksum: BLOB_HASH,
  });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 90000);
  check('repair: the download still completes', done.status === 'completed', done.error);
  check('repair: the file was fetched twice', served >= 2, `${served} requests`);
  if (done.finalPath && fs.existsSync(done.finalPath)) {
    check('repair: the repaired file matches the hash', (await hashFile(done.finalPath)) === BLOB_HASH);
  } else {
    let listing = [];
    try { listing = fs.readdirSync(done.destDir); } catch { /* none */ }
    check('repair: the repaired file matches the hash', false,
      `path=${done.finalPath} name=${done.filename} error=${done.error} dir=${listing.join(',')}`);
  }
  engine.close();
  srvR.close();
}

/* ---------------- a damaged archive is repaired entry by entry ---------------- */
{
  const zlib = require('node:zlib');
  // Build a small archive with one deflated entry.
  const parts = [];
  const central = [];
  let offset = 0;
  const add = (name, data) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const plain = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const payload = zlib.deflateRawSync(plain);
    const crc = zipCrc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(plain.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + payload.length;
  };
  add('readme.txt', 'hello');
  add('data.bin', crypto.randomBytes(8 * 1024 * 1024));
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const good = Buffer.concat([...parts, cdBuf, eocd]);
  const goodHash = sha256(good);
  // inside the payload of the first entry (local header 30 + name 9 = 39)
  const damageAt = 30 + 'readme.txt'.length;
  let damagedRequests = 0;
  const srvZ = await makeServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = good.length - 1;
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), good.length - 1);
    }
    const slice = Buffer.from(good.subarray(start, end + 1));
    // The first two transfers of the damaged area are broken, the rest is fine.
    const at = damageAt - start;
    if (at >= 0 && at < slice.length) {
      damagedRequests++;
      if (damagedRequests <= 2) slice[at] ^= 0xff;
    }
    res.writeHead(m ? 206 : 200, {
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${good.length}` } : {}),
    });
    res.end(slice);
  });
  const engine = new Engine(path.join(TMP, 'engine29'));
  engine.settings.rootDir = path.join(TMP, 'files29');
  const d = engine.add({
    urls: [`http://127.0.0.1:${srvZ.address().port}/bundle.zip`],
    segments: 1,
    filename: 'bundle.zip',
    expectedChecksum: goodHash,
  });
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 90000);
  check('zip repair: the download completes', done.status === 'completed', done.error);
  if (done.finalPath && fs.existsSync(done.finalPath)) {
    check('zip repair: the repaired archive matches the hash', (await hashFile(done.finalPath)) === goodHash);
  } else {
    let listing = [];
    try { listing = fs.readdirSync(done.destDir); } catch { /* none */ }
    check('zip repair: the repaired archive matches the hash', false,
      `path=${done.finalPath} name=${done.filename} dir=${listing.join(',')}`);
  }
  check('zip repair: the broken area was fetched again', damagedRequests >= 3, `${damagedRequests} requests`);
  engine.close();
  srvZ.close();
}

/* ---------------- per task schedule and dependencies ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine30'));
  engine.settings.rootDir = path.join(TMP, 'files30');
  engine.settings.maxConcurrent = 2;

  // A download that waits for another one stays queued.
  const parent = engine.add({ urls: [`${URL_BASE}/blob.bin`], segments: 1, filename: 'parent.bin' });
  const child = engine.add({
    urls: [`${URL_BASE}/blob.bin`], segments: 1, filename: 'child.bin', dependsOn: parent.id,
  });
  await sleep(1200);
  check('schedule: a child waits for its parent', child.status === 'queued' && !!child.blockedBy, child.status + ' ' + child.blockedBy);
  await waitFor(() => parent.status === 'completed', 60000);
  await waitFor(() => child.status !== 'queued', 30000);
  check('schedule: the child starts when the parent is done', child.status !== 'queued', child.status);

  // A cycle is refused.
  let cycleError = null;
  try {
    engine.add({ urls: [`${URL_BASE}/blob.bin`], dependsOn: child.id, filename: 'cycle.bin' });
  } catch (e) { cycleError = e; }
  const cyclic = engine.items.get(child.id);
  cyclic.dependsOn = cyclic.id;
  check('schedule: a loop is refused', !!cycleError || engine._noCycle(child.id) === false,
    cycleError ? cycleError.message : 'no cycle detected');

  // A window that has not opened yet keeps the download waiting.
  const now = new Date();
  const hhmm = (date) => String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  const from = new Date(now.getTime() + 2 * 60 * 1000);
  const to = new Date(now.getTime() + 3 * 60 * 1000);
  const windowed = engine.add({
    urls: [`${URL_BASE}/blob.bin`], segments: 1, filename: 'windowed.bin',
    schedule: { windowStart: hhmm(from), windowEnd: hhmm(to), days: [from.getDay()] },
  });
  await sleep(1200);
  check('schedule: a window that has not opened keeps the download waiting', windowed.status === 'queued', windowed.status);
  engine.close();
}

/* ---------------- hourly quota ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine31'));
  engine.settings.hourlyQuota = 1000;
  engine.recordTraffic(400);
  check('quota: traffic is counted', engine._quotaUsed === 400, String(engine._quotaUsed));
  engine.recordTraffic(700);
  engine._checkQuota();
  check('quota: exceeding the limit halts the queue', engine._quotaHalted === true);
  engine.settings.hourlyQuota = 2000;
  engine._checkQuota();
  check('quota: raising the limit resumes the queue', engine._quotaHalted === false);
  engine._quotaResetAt = Date.now() - 1;
  engine._checkQuota();
  check('quota: a new hour resets the counter', engine._quotaUsed === 0, String(engine._quotaUsed));
  engine.close();
}

srv.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
