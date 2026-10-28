// downloadX advanced engine test suite — webhooks, repairs, per-task schedule and quota.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine } = require('../lib/engine.js');
const { crc32: zipCrc32 } = require('../lib/zip.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-adv-'));
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

const BLOB = crypto.randomBytes(6 * 1024 * 1024 + 137);
const BLOB_HASH = sha256(BLOB);

function rangeHandler(req, res) {
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
    'ETag': '"advtest-v1"',
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
const URL_BASE = `http://127.0.0.1:${srv.address().port}`;

/* ---------------- webhooks ---------------- */
{
  const hits = [];
  const hook = await makeServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, type: req.headers['content-type'], body });
      res.writeHead(200);
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
