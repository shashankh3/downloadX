'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request, FatalError } = require('./httpget');
const { TokenBucket } = require('./bucket');
const store = require('./store');

const CHUNK = 8 * 1024 * 1024;        // max bytes fetched per ranged request
const MIN_SPLIT = 4 * 1024 * 1024;    // never split a segment smaller than this
const MAX_BACKOFF = 30000;
const SPEED_WINDOW_MS = 5000;

const CATEGORIES = {
  Programs:  ['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appx'],
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab'],
  Music:     ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus'],
  Video:     ['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'ts', 'm4v'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'],
  Images:    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
};

function categoryFor(mime, filename) {
  const ext = (path.extname(filename || '').toLowerCase().replace('.', ''));
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  const m = (mime || '').split('/')[0];
  if (m === 'video') return 'Video';
  if (m === 'audio') return 'Music';
  if (m === 'image') return 'Images';
  return 'Others';
}

function sanitizeName(name) {
  let n = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  n = n.replace(/^\.+/, '_').replace(/[. ]+$/, '');
  if (n.length > 180) {
    const ext = path.extname(n);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || 'download';
}

function nameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    let base = path.basename(u.pathname || '');
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    base = base.split(/[?#]/)[0];
    return sanitizeName(base);
  } catch { return 'download'; }
}

function nameFromHeaders(headers, finalUrl) {
  const cd = headers['content-disposition'] || '';
  let m = /filename\*=(?:UTF-8|utf-8)''([^;]+)/i.exec(cd);
  if (m) { try { return sanitizeName(decodeURIComponent(m[1])); } catch { /* fall through */ } }
  m = /filename="?([^";]+)"?/i.exec(cd);
  if (m) return sanitizeName(m[1]);
  return nameFromUrl(finalUrl);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Download {
  constructor(engine, rec) {
    this.engine = engine;
    this.id = rec.id || crypto.randomUUID();
    this.urls = rec.urls && rec.urls.length ? rec.urls : [rec.url];
    this.filename = rec.filename || '';
    this.category = rec.category || 'auto';
    this.dirOverride = rec.dir || '';
    this.segmentsWanted = Math.max(1, Math.min(64, rec.segmentsWanted || rec.segments || engine.settings.defaultSegments));
    this.speedLimit = rec.speedLimit || 0;   // bytes/sec, 0 = unlimited
    this.referer = rec.referer || '';
    this.cookies = rec.cookies || '';
    this.total = rec.total || 0;
    this.status = rec.status || 'queued';
    this.addedAt = rec.addedAt || Date.now();
    this.completedAt = rec.completedAt || 0;
    this.error = rec.error || '';
    this.etag = rec.etag || '';
    this.resumable = rec.resumable !== false;
    this.priority = rec.priority || 0;
    this.checksum = rec.checksum || null;
    this.segments = Array.isArray(rec.segments) ? rec.segments : null;
    this.pausedBy = rec.pausedBy || '';
    // runtime only
    this.finalUrl = rec.finalUrl || this.urls[0];
    // true when the name came from the URL (add-time guess) and may be refined by Content-Disposition
    this._urlNamed = !rec.filename;
    this.speed = 0; this.eta = -1; this.workers = 0;
    this._fd = null; this._stop = false;
    this._samples = []; this._lockedSegs = new Set();
    this._activeReqs = new Set(); this._consecErrors = 0; this._urlIdx = 0;
    this._singleDone = !!rec._singleDone;
    this._restartedOnce = false;
    this._run = 0;
    this._bucket = this.speedLimit > 0 ? new TokenBucket(this.speedLimit) : null;
    if (this.status === 'downloading' || this.status === 'probing') this.status = 'queued';
  }

  get received() {
    if (!this.segments) return 0;
    return this.segments.reduce((a, s) => a + s.downloaded, 0);
  }
  get destDir() {
    if (this.dirOverride) return this.dirOverride;
    const root = this.engine.settings.rootDir;
    const cat = this.category && this.category !== 'auto' ? this.category : 'Others';
    return this.engine.settings.organizeByCategory ? path.join(root, cat) : root;
  }
  get finalPath() { return path.join(this.destDir, this.filename); }
  get partPath() { return this.finalPath + '.' + this.id.slice(0, 8) + '.dxpart'; }

  persistRec() {
    return {
      id: this.id, urls: this.urls, filename: this.filename, category: this.category,
      dir: this.dirOverride, segments: this.segments, total: this.total, status: this.status,
      addedAt: this.addedAt, completedAt: this.completedAt, error: this.error, etag: this.etag,
      resumable: this.resumable, priority: this.priority, checksum: this.checksum,
      segmentsWanted: this.segmentsWanted, speedLimit: this.speedLimit, referer: this.referer,
      cookies: this.cookies, pausedBy: this.pausedBy, finalUrl: this.finalUrl, _singleDone: this._singleDone,
    };
  }

  snapshot() {
    return {
      id: this.id, url: this.urls[0], urls: this.urls, filename: this.filename,
      category: this.category === 'auto' ? 'Others' : this.category,
      status: this.status, total: this.total, received: this.received,
      speed: this.speed, eta: this.eta, workers: this.workers,
      error: this.error, addedAt: this.addedAt, completedAt: this.completedAt,
      path: this.finalPath, segmentsWanted: this.segmentsWanted, checksum: this.checksum,
      speedLimit: this.speedLimit, priority: this.priority,
      segments: (this.segments || []).map((s) => ({
        start: s.start, end: s.end, downloaded: s.downloaded,
        active: this._lockedSegs.has(s) && this.status === 'downloading',
      })),
    };
  }

  _extraHeaders() {
    const h = {};
    if (this.referer) h.referer = this.referer;
    if (this.cookies) h.cookie = this.cookies;
    return h;
  }

  async _probe() {
    this.status = 'probing';
    const { res, url: finalUrl } = await request(this.urls[0], {
      headers: { range: 'bytes=0-0', ...this._extraHeaders() },
    });
    const st = res.statusCode;
    if (st >= 400) { res.destroy(); throw new FatalError('HTTP ' + st + ' (' + finalUrl + ')'); }
    this.etag = res.headers.etag || '';
    this.finalUrl = finalUrl;
    if (this._urlNamed || !this.filename) {
      this.filename = nameFromHeaders(res.headers, finalUrl);
      this._urlNamed = false;
    }
    if (this.category === 'auto') this.category = categoryFor(res.headers['content-type'], this.filename);
    if (st === 206) {
      const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(res.headers['content-range'] || '');
      res.destroy();
      if (m) { this.resumable = true; this.total = parseInt(m[1], 10); return; }
      this.resumable = false;
    } else {
      res.destroy();
      this.resumable = false;
    }
    this.total = parseInt(res.headers['content-length'], 10) || 0;
  }

  async start() {
    if (this._fd || this.status === 'downloading' || this.status === 'probing') return;
    const run = ++this._run;
    try {
      if (!this.segments) await this._probe();
    } catch (e) {
      return this._fail(e.fatal ? e.message : 'Probe failed: ' + e.message);
    }
    // a pause/cancel may have landed while we were probing or opening the file
    const invalidated = () => run !== this._run;
    try {
      const dir = this.destDir;
      fs.mkdirSync(dir, { recursive: true });
      this._dedupeName(dir);
      if (!this.segments) {
        if (this.resumable && this.total > 0) {
          const n = Math.max(1, Math.min(this.segmentsWanted, Math.ceil(this.total / MIN_SPLIT)));
          const size = Math.ceil(this.total / n);
          this.segments = [];
          for (let i = 0; ; i++) {
            const s = i * size;
            if (s >= this.total) break;
            this.segments.push({ start: s, end: Math.min(this.total - 1, s + size - 1), downloaded: 0 });
          }
        } else {
          this.segments = [{ start: 0, end: this.total > 0 ? this.total - 1 : -1, downloaded: 0 }];
        }
      }
      if (!this.resumable || this.total <= 0) {
        // single-stream downloads can never resume mid-body
        if (this.segments) this.segments[0].downloaded = 0;
        this._singleDone = false;
      }
      const partExists = fs.existsSync(this.partPath);
      if (!partExists && this.segments.some((s) => s.downloaded > 0)) {
        this.segments.forEach((s) => { s.downloaded = 0; });   // part file lost: start over
      }
      this._fd = await fsp.open(this.partPath, partExists ? 'r+' : 'w+');
      if (this.total > 0) await this._fd.truncate(this.total);
      if (invalidated()) {
        if (this._fd) { try { await this._fd.close(); } catch { /* ignore */ } this._fd = null; }
        return;
      }
    } catch (e) {
      return this._fail('Cannot write file: ' + e.message);
    }
    this._stop = false;
    this._consecErrors = 0;
    this.status = 'downloading';
    this.engine.markDirty();
    const workerCount = this.resumable && this.total > 0
      ? Math.max(1, Math.min(this.segmentsWanted, this.segments.length))
      : 1; // single-stream mode: one connection, no ranges
    const workers = Array.from({ length: workerCount }, () => this._workerLoop());
    Promise.allSettled(workers).then(() => this._onWorkersDone()).catch(() => {});
  }

  _dedupeName(dir) {
    if (fs.existsSync(this.partPath)) return; // resuming an existing part
    const taken = (name) => {
      if (fs.existsSync(path.join(dir, name))) return true;
      // another live download already claimed this final name (its final file may not exist yet)
      for (const other of this.engine.items.values()) {
        if (other.id === this.id) continue;
        if (other.destDir === dir && other.filename === name &&
            !['failed', 'canceled'].includes(other.status)) return true;
      }
      return false;
    };
    let f = this.filename;
    const ext = path.extname(f);
    const base = f.slice(0, f.length - ext.length);
    let n = 1;
    while (taken(f)) {
      f = `${base} (${n++})${ext}`;
      if (n > 9999) break;
    }
    this.filename = f;
  }

  _remaining(s) { return s.end < 0 ? Infinity : s.end - s.start + 1 - s.downloaded; }

  _pickSegment() {
    let best = null, bestRem = 0;
    for (const s of this.segments) {
      if (this._lockedSegs.has(s)) continue;
      const rem = this._remaining(s);
      if (rem > bestRem) { bestRem = rem; best = s; }
    }
    if (!best) return null;
    // dynamic splitting: keep dividing the biggest range until we have enough segments
    if (bestRem >= MIN_SPLIT * 2 && this.segments.length < this.segmentsWanted && best.end >= 0) {
      const mid = best.start + best.downloaded + Math.floor(bestRem / 2);
      this.segments.push({ start: mid, end: best.end, downloaded: 0 });
      best.end = mid - 1;
    }
    this._lockedSegs.add(best);
    return best;
  }
  _unlock(seg) { this._lockedSegs.delete(seg); }

  async _workerLoop() {
    this.workers++;
    try {
      while (!this._stop && this.status === 'downloading') {
        if (!this.resumable || this.total <= 0) {
          if (this._singleDone) break;
          try { await this._fetchSingle(); this._consecErrors = 0; }
          catch (e) {
            if (this._stop) break;
            if (e.fatal) return this._fail(e.message);
            this._consecErrors++;
            this.error = e.message;
            if (this._consecErrors >= 12) return this._fail('Too many errors: ' + e.message);
            if (this.urls.length > 1) this._urlIdx = (this._urlIdx + 1) % this.urls.length;
            await sleep(Math.min(1000 * 2 ** (this._consecErrors - 1), MAX_BACKOFF));
          }
          continue;
        }
        const seg = this._pickSegment();
        if (!seg) {
          if (this._isComplete()) break;
          await sleep(250);
          continue;
        }
        try {
          await this._fetchChunk(seg);
          this._consecErrors = 0;
        } catch (e) {
          if (this._stop) { this._unlock(seg); break; }
          if (e.shortRead) {
            // truncated response — retry the missing range right away, no backoff
            this._unlock(seg);
            continue;
          }
          if (e.restartNeeded && !this._restartedOnce) {
            this._unlock(seg);
            this._restartedOnce = true;
            this.status = 'queued';
            this.segments = null;
            this.total = 0;
            this._singleDone = false;
            this.engine.markDirty();
            return;   // workers exit; the engine tick will start() fresh
          }
          if (e.fatal) { this._unlock(seg); return this._fail(e.message); }
          this._consecErrors++;
          this.error = e.message;
          if (this._consecErrors >= 12) { this._unlock(seg); return this._fail('Too many errors: ' + e.message); }
          if (this.urls.length > 1) this._urlIdx = (this._urlIdx + 1) % this.urls.length;
          await sleep(Math.min(1000 * 2 ** (this._consecErrors - 1), MAX_BACKOFF));
        } finally {
          this._unlock(seg);
        }
      }
    } finally {
      this.workers--;
    }
  }

  _pump(res, seg, req, from, boundTotal) {
    // pos counts bytes within THIS chunk (0..boundTotal); write offset is from+pos.
    // Never seed pos from seg.downloaded — those are different coordinate systems
    // and mixing them made resumed segments "complete" without reading any data.
    const dbg = process.env.DLX_DEBUG;
    if (dbg) console.error(`  pump start from=${from} boundTotal=${boundTotal}`);
    return new Promise((resolve, reject) => {
      let pos = 0;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this._activeReqs.delete(req);
        if (dbg) console.error(`  pump done pos=${pos} boundTotal=${boundTotal} err=${err ? err.message : 'ok'}`);
        if (err) reject(err); else resolve();
      };
      res.on('data', async (chunkBuf) => {
        if (settled) return;
        try {
          res.pause();
          let buf = chunkBuf;
          if (boundTotal && pos + buf.length > boundTotal) {
            buf = buf.subarray(0, boundTotal - pos);  // server sent more than the range asked
          }
          if (buf.length > 0) {
            await this.engine.bucket.take(buf.length);
            if (this._bucket) await this._bucket.take(buf.length);
            if (this._stop || this.status !== 'downloading') { req.destroy(); return done(); }
            await this._fd.write(buf, 0, buf.length, from + pos);
            pos += buf.length;
            seg.downloaded = (from - seg.start) + pos;
            this._sample(buf.length);
          }
          if (boundTotal && pos >= boundTotal) { req.destroy(); return done(); }
          res.resume();
        } catch (e) {
          try { req.destroy(); } catch { /* already gone */ }
          done(e);
        }
      });
      res.on('end', () => {
        if (boundTotal && pos < boundTotal) {
          // Short read — servers truncate responses routinely (pools, proxies, tail races).
          // Not an error: the caller immediately re-requests the missing range.
          return done(Object.assign(new Error(`Short read: ${pos} of ${boundTotal} bytes`), { shortRead: true }));
        }
        if (!boundTotal) this._singleDone = true;
        done();
      });
      res.on('error', (e) => done(e));
      res.on('aborted', () => done(new Error('Connection aborted')));
    });
  }

  async _fetchChunk(seg) {
    const from = seg.start + seg.downloaded;
    if (seg.end >= 0 && from > seg.end) return;
    const hardEnd = seg.end >= 0 ? Math.min(from + CHUNK - 1, seg.end) : -1;
    const headers = { range: `bytes=${from}-${hardEnd}`, ...this._extraHeaders() };
    if (this.etag && this.resumable && this.received > 0) headers['if-range'] = this.etag;
    const { req, res } = await request(this.urls[this._urlIdx] || this.urls[0], { headers });
    this._activeReqs.add(req);
    try {
      if (res.statusCode === 206) {
        const m = /bytes\s+(\d+)-/i.exec(res.headers['content-range'] || '');
        if (m && parseInt(m[1], 10) !== from) {
          res.destroy();
          throw new Error('Server returned wrong range offset');
        }
      } else if (res.statusCode === 200) {
        if (this.received > 0 || this.segments.length > 1) {
          // If-Range mismatch: the file changed on the server, our progress is invalid
          res.destroy();
          throw Object.assign(new Error('File changed on server — restarting from scratch'), { restartNeeded: true });
        }
        // server ignores Range on a fresh download: stream the whole body from byte 0
        this.resumable = false;
        seg.end = -1;
        await this._pump(res, seg, req, from, 0);
        return;
      } else {
        res.destroy();
        throw new Error('HTTP ' + res.statusCode);
      }
      const boundTotal = hardEnd >= 0 ? hardEnd - from + 1 : 0;
      await this._pump(res, seg, req, from, boundTotal);
    } finally {
      this._activeReqs.delete(req);
    }
  }

  async _fetchSingle() {
    const seg = this.segments[0];
    seg.downloaded = 0;   // a fresh body always starts at byte 0
    const { req, res } = await request(this.urls[this._urlIdx] || this.urls[0], {
      headers: this._extraHeaders(),
    });
    this._activeReqs.add(req);
    try {
      if (res.statusCode >= 400) throw new FatalError('HTTP ' + res.statusCode);
      if (!this.total) this.total = parseInt(res.headers['content-length'], 10) || 0;
      if (this.total && seg.downloaded === 0) await this._fd.truncate(this.total);
      await this._pump(res, seg, req, seg.start + seg.downloaded, 0);
    } finally {
      this._activeReqs.delete(req);
    }
  }

  _isComplete() {
    if (!this.resumable || this.total <= 0) return !!this._singleDone;
    return this.segments.every((s) => s.downloaded >= s.end - s.start + 1);
  }

  async _onWorkersDone() {
    if (this._fd) { try { await this._fd.close(); } catch { /* ignore */ } this._fd = null; }
    if (this._stop) { this.engine.markDirty(); return; }   // paused/canceled: caller set status
    if (this.status !== 'downloading') return;
    if (this._isComplete()) {
      try { await this._finalize(); }
      catch (e) { this._fail(e.message); }
    } else {
      this._fail('Download stalled before completion');
    }
  }

  async _finalize() {
    if (this._stop) return;
    const got = this.received;
    if (this.total > 0 && got !== this.total) {
      throw new Error(`Size mismatch: got ${got} of ${this.total} bytes`);
    }
    if (!this._singleDone && (!this.segments || !this.segments.length)) throw new Error('No data written');
    fs.renameSync(this.partPath, this.finalPath);
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1; this.error = '';
    this.engine.markDirty();
  }

  _fail(msg) {
    this.status = 'failed';
    this.error = msg;
    this.speed = 0; this.eta = -1;
    this._teardown();
    this.engine.markDirty();
  }

  async _teardown() {
    this._run++;               // invalidate any in-flight start()
    this._stop = true;
    for (const req of this._activeReqs) { try { req.destroy(); } catch { /* already gone */ } }
    this._activeReqs.clear();
    // give workers a moment to notice _stop before closing the fd
    for (let i = 0; i < 100 && this.workers > 0; i++) await sleep(30);
    if (this._fd) { try { await this._fd.close(); } catch { /* ignore */ } this._fd = null; }
    this.engine.markDirty();
  }

  async pause(who) {
    if (this.status !== 'downloading' && this.status !== 'probing' && this.status !== 'queued') return;
    this.pausedBy = who || 'user';
    this.status = 'paused';
    this.speed = 0; this.eta = -1;
    await this._teardown();
    this.engine.saveNow();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.status = 'queued';
    this.pausedBy = '';
    this.error = '';
    this.engine.markDirty();
  }

  async cancel() {
    if (this.status === 'completed') return;
    this.status = 'canceled';
    await this._teardown();
    try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
    this.engine.saveNow();
  }

  retry() {
    if (this.status !== 'failed' && this.status !== 'canceled' && this.status !== 'completed') return;
    this.status = 'queued';
    this.error = '';
    this._consecErrors = 0;
    this._singleDone = false;
    this.engine.markDirty();
  }

  restart() {
    this.segments = null;
    this.total = 0;
    this._singleDone = false;
    try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
    this.retry();
  }

  _sample(n) {
    const now = Date.now();
    this._samples.push({ t: now, n });
    while (this._samples.length && now - this._samples[0].t > SPEED_WINDOW_MS) this._samples.shift();
    this.engine.markDirty();
  }

  computeSpeed() {
    const now = Date.now();
    while (this._samples.length && now - this._samples[0].t > SPEED_WINDOW_MS) this._samples.shift();
    if (this._samples.length < 2) { this.speed = 0; return; }
    const first = this._samples[0];
    const span = Math.max(250, now - first.t);
    const bytes = this._samples.reduce((a, s) => a + s.n, 0);
    this.speed = Math.round((bytes / span) * 1000);
    const remaining = this.total > 0 ? Math.max(0, this.total - this.received) : 0;
    this.eta = this.speed > 0 && this.total > 0 ? Math.ceil(remaining / this.speed) : -1;
  }

  setSpeedLimit(bytesPerSec) {
    this.speedLimit = bytesPerSec;
    if (bytesPerSec > 0) {
      if (this._bucket) this._bucket.setRate(bytesPerSec);
      else this._bucket = new TokenBucket(bytesPerSec);
    } else this._bucket = null;
  }

  async verifyChecksum(algo, expected) {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
    const algos = ['sha256', 'sha1', 'md5', 'sha512'];
    if (!algos.includes(algo)) throw new Error('Unsupported algorithm');
    if (!fs.existsSync(this.finalPath)) throw new Error('File not found (only completed downloads can be verified)');
    return new Promise((resolve) => {
      const hash = crypto.createHash(algo);
      const stream = fs.createReadStream(this.finalPath, { highWaterMark: 1024 * 1024 });
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => {
        const actual = hash.digest('hex');
        this.checksum = { algo, expected: norm(expected), actual, ok: actual === norm(expected), at: Date.now() };
        this.engine.markDirty();
        this.engine.saveNow();
        resolve(this.checksum);
      });
      stream.on('error', (e) => { this.checksum = { algo, expected: norm(expected), actual: '', ok: false, at: Date.now(), error: e.message }; this.engine.markDirty(); resolve(this.checksum); });
    });
  }
}

class Engine extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    const defaults = {
      rootDir: defaultRoot(),
      maxConcurrent: 3,
      defaultSegments: 16,
      globalSpeedLimit: 0,          // bytes/sec, 0 = unlimited
      organizeByCategory: true,
      scheduleEnabled: false,
      scheduleFrom: '23:00',
      scheduleTo: '07:00',
      shutdownWhenDone: false,
    };
    const saved = store.load(this.stateFile, null);
    this.settings = Object.assign(defaults, (saved && saved.settings) || {});
    this.bucket = new TokenBucket(this.settings.globalSpeedLimit);
    this.items = new Map();
    for (const rec of (saved && saved.items) || []) {
      try { this.items.set(rec.id, new Download(this, rec)); } catch { /* skip corrupt record */ }
    }
    this.dirty = true;
    this._saveTimer = null;
    this._shutdownArmed = false;
    this._haltedBySchedule = false;
    setInterval(() => this._tick(), 500);
    process.on('exit', () => this.saveNow());
  }

  markDirty() { this.dirty = true; }
  saveSoon() {
    this.markDirty();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, 1500);
  }
  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      store.save(this.stateFile, {
        settings: this.settings,
        items: [...this.items.values()].map((d) => d.persistRec()),
      });
    } catch (e) {
      console.error('[downloadX] state save failed:', e.message);
    }
  }

  activeCount() {
    let n = 0;
    for (const d of this.items.values()) if (d.status === 'downloading' || d.status === 'probing') n++;
    return n;
  }

  add({ urls, filename, category, segments, speedLimit, referer, cookies, dir, startedPaused }) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) throw new Error('No URL provided');
    const d = new Download(this, {
      urls: list, filename: filename || nameFromUrl(list[0]), category: category || 'auto',
      segmentsWanted: segments, speedLimit, referer, cookies, dir,
      status: startedPaused ? 'paused' : 'queued',
    });
    this.items.set(d.id, d);
    this.saveNow();
    return d;
  }

  get(id) { return this.items.get(id); }
  async remove(id, deleteFile) {
    const d = this.items.get(id);
    if (!d) return false;
    if (d.status === 'downloading' || d.status === 'probing') await d.cancel();
    if (deleteFile) {
      for (const p of [d.finalPath, d.partPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    this.items.delete(id);
    this.saveNow();
    return true;
  }

  pauseAll(who) { const jobs = [...this.items.values()].filter((d) => ['downloading', 'probing', 'queued'].includes(d.status)); jobs.forEach((d) => d.pause(who)); }
  resumeAll(who) {
    for (const d of this.items.values()) {
      if (d.status === 'paused' && (!who || d.pausedBy === who)) d.resume();
    }
  }

  globalSpeed() {
    let s = 0;
    for (const d of this.items.values()) s += d.speed || 0;
    return s;
  }

  _inScheduleWindow() {
    const { scheduleEnabled, scheduleFrom, scheduleTo } = this.settings;
    if (!scheduleEnabled) return true;
    const toMin = (hhmm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
      if (!m) return null;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    };
    const from = toMin(scheduleFrom), to = toMin(scheduleTo);
    if (from === null || to === null) return true;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    if (from === to) return true;
    if (from < to) return cur >= from && cur < to;
    return cur >= from || cur < to;   // window wraps midnight
  }

  async _tick() {
    const windowOpen = this._inScheduleWindow();
    if (this.settings.scheduleEnabled) {
      if (!windowOpen && !this._haltedBySchedule) {
        this._haltedBySchedule = true;
        this.pauseAll('schedule');
      } else if (windowOpen && this._haltedBySchedule) {
        this._haltedBySchedule = false;
        this.resumeAll('schedule');
      }
    } else if (this._haltedBySchedule) {
      this._haltedBySchedule = false;
      this.resumeAll('schedule');
    }

    if (!this._haltedBySchedule) {
      const queued = [...this.items.values()]
        .filter((d) => d.status === 'queued')
        .sort((a, b) => (b.priority - a.priority) || (a.addedAt - b.addedAt));
      for (const d of queued) {
        if (this.activeCount() >= this.settings.maxConcurrent) break;
        d.start();  // async; errors funnel into _fail()
      }
    }
    let anyActive = false;
    for (const d of this.items.values()) {
      d.computeSpeed();
      if (d.status === 'downloading' || d.status === 'probing') anyActive = true;
    }
    if (anyActive) { this.dirty = true; this.saveSoon(); }

    if (this.settings.shutdownWhenDone && !this._shutdownArmed) {
      const pending = [...this.items.values()].some((d) =>
        ['downloading', 'probing', 'queued', 'paused'].includes(d.status) && d.pausedBy !== 'schedule');
      const anyDone = [...this.items.values()].some((d) => d.status === 'completed');
      if (!pending && anyDone) { this._shutdownArmed = true; this.emit('shutdown-armed'); }
    }
    if (!this.settings.shutdownWhenDone) this._shutdownArmed = false;
  }

  cancelShutdown() {
    this._shutdownArmed = false;
    this.emit('shutdown-cancelled');
  }
  isShutdownArmed() { return this._shutdownArmed; }

  snapshot() {
    return {
      items: [...this.items.values()].map((d) => d.snapshot()),
      settings: this.settings,
      globalSpeed: this.globalSpeed(),
      activeCount: this.activeCount(),
      scheduleHalted: this._haltedBySchedule,
      shutdownArmed: this._shutdownArmed,
    };
  }
}

function defaultRoot() {
  const home = os.homedir();
  const dl = path.join(home, 'Downloads');
  try { if (fs.existsSync(dl)) return dl; } catch { /* fall through */ }
  return path.join(home, 'Downloads');
}

module.exports = { Engine, Download };
