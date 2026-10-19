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

const CHUNK = 8 * 1024 * 1024;
const MIN_SPLIT = 1 * 1024 * 1024;
const MAX_BACKOFF = 30000;
const MAX_RETRY_AFTER = 120000;
const SPEED_WINDOW_MS = 5000;
const MAX_ITEMS = 2000;
const STATE_VERSION = 2;
const SHUTDOWN_GRACE_MS = 60000;

const CATEGORIES = {
  Programs:  ['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appx', 'appimage', 'jar'],
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'zst', 'lz4'],
  Music:     ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'aiff'],
  Video:     ['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'ts', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'odt', 'ods', 'odp', 'rtf', 'csv'],
  Images:    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'heic'],
};

const DEFAULT_SETTINGS = {
  rootDir: '',
  maxConcurrent: 3,
  defaultSegments: 16,
  globalSpeedLimit: 0,
  organizeByCategory: true,
  scheduleEnabled: false,
  scheduleFrom: '23:00',
  scheduleTo: '07:00',
  shutdownWhenDone: false,
};

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CHECKSUM_ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];
const CATEGORY_NAMES = [...Object.keys(CATEGORIES), 'Others'];

function normalizeCategory(value) {
  if (!value || value === 'auto') return 'auto';
  const s = String(value).trim().toLowerCase();
  return CATEGORY_NAMES.find((c) => c.toLowerCase() === s) || 'auto';
}

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
    n = n.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  if (!n) return 'download';
  const stem = n.split('.')[0];
  if (RESERVED_NAMES.test(stem)) n = '_' + n;
  return n;
}

function cleanPathStr(v) {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : '';
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
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[2].trim().replace(/^"|"$/g, ''));
      if (decoded) return sanitizeName(decoded);
    } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(cd);
  if (m) return sanitizeName(m[1].replace(/\\(.)/g, '$1'));
  m = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) return sanitizeName(m[1].trim().replace(/^"|"$/g, ''));
  return nameFromUrl(finalUrl);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isFatalDiskError(e) {
  return !!e && ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE'].includes(e.code);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function validHHMM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return fallback;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function normalizeSettings(input, base) {
  const defaults = Object.assign({}, DEFAULT_SETTINGS, base || {}, { rootDir: (base && base.rootDir) || defaultRoot() });
  const s = Object.assign({}, defaults, input || {});
  s.rootDir = cleanPathStr(s.rootDir) ? path.resolve(cleanPathStr(s.rootDir)) : defaults.rootDir;
  s.maxConcurrent = clampInt(s.maxConcurrent, 1, 20, defaults.maxConcurrent);
  s.defaultSegments = clampInt(s.defaultSegments, 1, 64, defaults.defaultSegments);
  s.globalSpeedLimit = clampInt(s.globalSpeedLimit, 0, 1024 * 1024 * 1024, defaults.globalSpeedLimit);
  s.organizeByCategory = s.organizeByCategory !== false;
  s.scheduleEnabled = !!s.scheduleEnabled;
  s.scheduleFrom = validHHMM(s.scheduleFrom, defaults.scheduleFrom);
  s.scheduleTo = validHHMM(s.scheduleTo, defaults.scheduleTo);
  s.shutdownWhenDone = !!s.shutdownWhenDone;
  return s;
}

function normalizeHash(expected) {
  return String(expected || '').trim().toLowerCase()
    .replace(/^0x/, '')
    .replace(/^[a-z0-9]+:/, '')
    .replace(/[^a-f0-9]/g, '');
}

function guessAlgo(expected) {
  const len = normalizeHash(expected).length;
  if (len === 32) return 'md5';
  if (len === 40) return 'sha1';
  if (len === 64) return 'sha256';
  if (len === 128) return 'sha512';
  return '';
}

class Download {
  constructor(engine, rec) {
    this.engine = engine;
    this.id = rec.id || crypto.randomUUID();
    this.urls = (rec.urls && rec.urls.length ? rec.urls : [rec.url]).filter(Boolean);
    this.filename = rec.filename ? sanitizeName(rec.filename) : '';
    this.category = normalizeCategory(rec.category);
    this.dirOverride = cleanPathStr(rec.dir) ? path.resolve(cleanPathStr(rec.dir)) : '';
    this._destDir = cleanPathStr(rec.destDir) ? path.resolve(cleanPathStr(rec.destDir)) : this.dirOverride;
    this.segmentsWanted = clampInt(rec.segmentsWanted || rec.segments, 1, 64, engine.settings.defaultSegments);
    this.speedLimit = Math.max(0, parseInt(rec.speedLimit, 10) || 0);
    this.referer = rec.referer || '';
    this.cookies = rec.cookies || '';
    this.total = rec.total || 0;
    this.status = rec.status || 'queued';
    this.addedAt = rec.addedAt || Date.now();
    this.completedAt = rec.completedAt || 0;
    this.error = rec.error || '';
    this.etag = rec.etag || '';
    this.lastModified = rec.lastModified || '';
    this.resumable = rec.resumable !== false;
    this.priority = parseInt(rec.priority, 10) || 0;
    this.checksum = rec.checksum || null;
    this.expectedChecksum = rec.expectedChecksum || '';
    this.checksumAlgo = CHECKSUM_ALGOS.includes(rec.checksumAlgo) ? rec.checksumAlgo : (guessAlgo(rec.expectedChecksum) || 'sha256');
    this.segments = Array.isArray(rec.segments) ? rec.segments : null;
    this.pausedBy = rec.pausedBy || '';
    this.finalUrl = rec.finalUrl || this.urls[0];
    this._urlNamed = rec._urlNamed != null ? !!rec._urlNamed : !rec.filename;
    this._forceSingle = !!rec._forceSingle;
    this._probeIdx = clampInt(rec._probeIdx, 0, Math.max(0, this.urls.length - 1), 0);
    this.speed = 0; this.eta = -1; this.workers = 0;
    this._fd = null; this._stop = false;
    this._samples = []; this._lockedSegs = new Set();
    this._activeReqs = new Set(); this._consecErrors = 0; this._urlIdx = 0;
    this._fatalIdx = new Set();
    this._singleDone = !!rec._singleDone;
    this._restartedOnce = false;
    this._run = 0;
    this._teardownPromise = null;
    this._bucket = this.speedLimit > 0 ? new TokenBucket(this.speedLimit) : null;
    if (this.status === 'downloading' || this.status === 'probing') this.status = 'queued';
    if (this.status === 'canceled' && !rec.filename) this.filename = 'download';
  }

  get received() {
    if (!this.segments) return this.status === 'completed' ? this.total : 0;
    return this.segments.reduce((a, s) => a + (s.downloaded || 0), 0);
  }
  _computeDestDir() {
    if (this.dirOverride) return this.dirOverride;
    const root = this.engine.settings.rootDir;
    const cat = this.category && this.category !== 'auto' ? this.category : 'Others';
    return this.engine.settings.organizeByCategory ? path.join(root, cat) : root;
  }
  get destDir() { return this._destDir || this._computeDestDir(); }
  get finalPath() { return path.join(this.destDir, this.filename); }
  get partPath() { return this.finalPath + '.' + this.id.slice(0, 8) + '.dxpart'; }

  persistRec() {
    const rec = {
      id: this.id, urls: this.urls, filename: this.filename, category: this.category,
      dir: this.dirOverride, destDir: this._destDir, total: this.total, status: this.status,
      addedAt: this.addedAt, completedAt: this.completedAt, error: this.error, etag: this.etag,
      lastModified: this.lastModified, resumable: this.resumable, priority: this.priority,
      checksum: this.checksum, expectedChecksum: this.expectedChecksum, checksumAlgo: this.checksumAlgo,
      segmentsWanted: this.segmentsWanted, speedLimit: this.speedLimit, referer: this.referer,
      cookies: this.cookies, pausedBy: this.pausedBy, finalUrl: this.finalUrl,
      _singleDone: this._singleDone, _forceSingle: this._forceSingle, _urlNamed: this._urlNamed,
      _probeIdx: this._probeIdx,
    };
    if (this.status !== 'completed') rec.segments = this.segments;
    return rec;
  }

  snapshot() {
    let segments = this.segments || [];
    if (!segments.length && this.status === 'completed' && this.total > 0) {
      segments = [{ start: 0, end: this.total - 1, downloaded: this.total }];
    }
    return {
      id: this.id, url: this.urls[0], urls: this.urls, filename: this.filename,
      category: this.category === 'auto' ? 'Others' : this.category,
      status: this.status, total: this.total, received: this.received,
      speed: this.speed, eta: this.eta, workers: this.workers,
      activeConnections: this.status === 'downloading' ? this._lockedSegs.size : 0,
      error: this.error, addedAt: this.addedAt, completedAt: this.completedAt,
      path: this.finalPath, destDir: this.destDir, segmentsWanted: this.segmentsWanted,
      checksum: this.checksum, expectedChecksum: this.expectedChecksum, checksumAlgo: this.checksumAlgo,
      speedLimit: this.speedLimit, priority: this.priority, pausedBy: this.pausedBy,
      canResume: this.resumable && this.total > 0, lastModified: this.lastModified,
      segments: segments.map((s) => ({
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
    let lastErr = null;
    const startIdx = clampInt(this._probeIdx, 0, Math.max(0, this.urls.length - 1), 0);
    for (let i = 0; i < this.urls.length; i++) {
      const idx = (startIdx + i) % this.urls.length;
      const url = this.urls[idx];
      let res;
      let req;
      try {
        const r = await request(url, { headers: { range: 'bytes=0-0', ...this._extraHeaders() } });
        res = r.res;
        req = r.req;
        this._activeReqs.add(req);
        const st = res.statusCode;
        if (st >= 300 && st < 400) {
          res.destroy();
          lastErr = new Error('Too many redirects (' + r.url + ')');
          continue;
        }
        if (st >= 400 && st !== 416) {
          res.destroy();
          lastErr = new FatalError('HTTP ' + st + ' (' + r.url + ')');
          continue;
        }
        this._urlIdx = idx;
        this._probeIdx = idx;
        this.finalUrl = r.url;
        this.etag = res.headers.etag || '';
        this.lastModified = res.headers['last-modified'] || '';
        if (this._urlNamed || !this.filename) {
          this.filename = nameFromHeaders(res.headers, r.url);
          this._urlNamed = false;
        }
        if (this.category === 'auto') this.category = categoryFor(res.headers['content-type'], this.filename);
        if (st === 416) {
          const m = /bytes\s+\*\/(\d+)/i.exec(res.headers['content-range'] || '');
          res.destroy();
          this.total = m ? parseInt(m[1], 10) : 0;
          this.resumable = true;
          return;
        }
        if (st === 206) {
          const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(res.headers['content-range'] || '');
          res.destroy();
          if (m) { this.resumable = true; this.total = parseInt(m[1], 10); return; }
          this.resumable = false;
          this.total = 0;
          return;
        }
        res.destroy();
        this.resumable = false;
        this.total = parseInt(res.headers['content-length'], 10) || 0;
        return;
      } catch (e) {
        if (res) { try { res.destroy(); } catch { /* gone */ } }
        lastErr = e;
      } finally {
        if (req) this._activeReqs.delete(req);
      }
    }
    throw lastErr || new FatalError('No reachable URL');
  }

  _segmentsValid() {
    if (!Array.isArray(this.segments) || !this.segments.length) return false;
    if (!this.resumable || this.total <= 0 || this._forceSingle) return false;
    let covered = 0;
    for (const s of this.segments) {
      if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) return false;
      if (s.start < 0 || s.end < s.start || s.end >= this.total) return false;
      const len = s.end - s.start + 1;
      if (!Number.isFinite(s.downloaded) || s.downloaded < 0 || s.downloaded > len) return false;
      covered += len;
    }
    return covered === this.total;
  }

  _buildSegments() {
    if (this._forceSingle || !this.resumable || this.total <= 0) {
      this.segments = [{ start: 0, end: this.total > 0 ? this.total - 1 : -1, downloaded: 0 }];
      this._singleDone = false;
      return;
    }
    if (this._segmentsValid()) return;
    const n = Math.max(1, Math.min(this.segmentsWanted, Math.ceil(this.total / MIN_SPLIT)));
    const size = Math.ceil(this.total / n);
    this.segments = [];
    for (let i = 0; ; i++) {
      const s = i * size;
      if (s >= this.total) break;
      this.segments.push({ start: s, end: Math.min(this.total - 1, s + size - 1), downloaded: 0 });
    }
    if (!this.segments.length) this.segments = [{ start: 0, end: -1, downloaded: 0 }];
    this._singleDone = false;
  }

  async start() {
    if (this._fd || this.status === 'downloading' || this.status === 'probing') return;
    if (this.status === 'paused' || this.status === 'canceled' || this.status === 'completed') return;
    if (this._teardownPromise) await this._teardownPromise;
    if (this.status !== 'queued') return;
    const run = ++this._run;
    try {
      if (!this.segments || !this.resumable || this._forceSingle) await this._probe();
    } catch (e) {
      return this._fail(e.fatal ? e.message : 'Probe failed: ' + e.message);
    }
    const invalidated = () => run !== this._run;
    if (invalidated()) return;
    if (!this._destDir) this._destDir = this._computeDestDir();
    try {
      const dir = this.destDir;
      fs.mkdirSync(dir, { recursive: true });
      this._dedupeName(dir);
      this._buildSegments();
      const partExists = fs.existsSync(this.partPath);
      if (!partExists && this.segments.some((s) => s.downloaded > 0)) {
        this.segments.forEach((s) => { s.downloaded = 0; });
        this._singleDone = false;
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
    this._samples = [];
    this.status = 'downloading';
    this.engine.markDirty();
    const workerCount = this.resumable && this.total > 0 && !this._forceSingle
      ? Math.max(1, Math.min(this.segmentsWanted, this.segments.length))
      : 1;
    const workers = Array.from({ length: workerCount }, () => this._workerLoop());
    Promise.allSettled(workers).then(() => this._onWorkersDone(run)).catch(() => {});
  }

  _dedupeName(dir) {
    if (fs.existsSync(this.partPath)) return;
    const caseFold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const taken = (name) => {
      const key = caseFold(name);
      if (fs.existsSync(path.join(dir, name))) return true;
      for (const other of this.engine.items.values()) {
        if (other.id === this.id) continue;
        if (other.destDir === dir && caseFold(other.filename) === key &&
            !['failed', 'canceled'].includes(other.status)) return true;
      }
      return false;
    };
    let f = this.filename;
    if (!taken(f)) return;
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
    if (bestRem >= MIN_SPLIT * 2 && this.segments.length < this.segmentsWanted && best.end >= 0) {
      const mid = best.start + best.downloaded + Math.floor(bestRem / 2);
      if (mid > best.start && mid <= best.end) {
        this.segments.push({ start: mid, end: best.end, downloaded: 0 });
        best.end = mid - 1;
      }
    }
    this._lockedSegs.add(best);
    return best;
  }
  _unlock(seg) { this._lockedSegs.delete(seg); }

  _markUrlFailed() {
    this._fatalIdx.add(this._urlIdx);
    for (let i = 1; i <= this.urls.length; i++) {
      const idx = (this._urlIdx + i) % this.urls.length;
      if (!this._fatalIdx.has(idx)) { this._urlIdx = idx; return true; }
    }
    return false;
  }

  _retryDelay(e) {
    if (e && e.retryAfter) return Math.min(MAX_RETRY_AFTER, e.retryAfter);
    return Math.min(1000 * 2 ** Math.max(0, this._consecErrors - 1), MAX_BACKOFF);
  }

  async _workerLoop() {
    this.workers++;
    try {
      while (!this._stop && this.status === 'downloading') {
        if (!this.resumable || this.total <= 0 || this._forceSingle) {
          if (this._singleDone) break;
          try { await this._fetchSingle(); this._consecErrors = 0; }
          catch (e) {
            if (this._stop) break;
            if (e.disk) return this._fail(e.message);
            if (e.fatal) {
              if (this._markUrlFailed()) { this.error = e.message; await sleep(this._retryDelay(e)); continue; }
              return this._fail(e.message);
            }
            this._consecErrors++;
            this.error = e.message;
            if (this._consecErrors >= 12) return this._fail('Too many errors: ' + e.message);
            if (this.urls.length > 1) this._urlIdx = (this._urlIdx + 1) % this.urls.length;
            await sleep(this._retryDelay(e));
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
            this._unlock(seg);
            await sleep(30);
            continue;
          }
          if (e.restartNeeded) {
            this._unlock(seg);
            if (this._restartedOnce) return this._fail(e.message);
            this._restartedOnce = true;
            if (e.fallbackSingle) this._forceSingle = true;
            this.status = 'queued';
            this.segments = null;
            this.total = 0;
            this._singleDone = false;
            this._stop = true;
            for (const r of this._activeReqs) { try { r.destroy(); } catch { /* gone */ } }
            this.engine.markDirty();
            return;
          }
          if (e.fatal) {
            this._unlock(seg);
            if (e.disk) return this._fail(e.message);
            if (this._markUrlFailed()) { this.error = e.message; await sleep(this._retryDelay(e)); continue; }
            return this._fail(e.message);
          }
          this._consecErrors++;
          this.error = e.message;
          if (this._consecErrors >= 12) { this._unlock(seg); return this._fail('Too many errors: ' + e.message); }
          if (this.urls.length > 1) this._urlIdx = (this._urlIdx + 1) % this.urls.length;
          await sleep(this._retryDelay(e));
        } finally {
          this._unlock(seg);
        }
      }
    } finally {
      this.workers--;
    }
  }

  _pump(res, seg, req, from, boundTotal) {
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
          if (boundTotal && pos + buf.length > boundTotal) buf = buf.subarray(0, boundTotal - pos);
          if (buf.length > 0) {
            await this.engine.bucket.take(buf.length);
            if (this._bucket) await this._bucket.take(buf.length);
            if (this._stop || this.status !== 'downloading') { req.destroy(); return done(); }
            if (!this._fd) { req.destroy(); return done(new Error('File handle closed')); }
            await this._fd.write(buf, 0, buf.length, from + pos);
            pos += buf.length;
            const maxLen = seg.end >= 0 ? seg.end - seg.start + 1 : Infinity;
            seg.downloaded = Math.min(maxLen, (from - seg.start) + pos);
            this._sample(buf.length);
          }
          if (boundTotal && pos >= boundTotal) { req.destroy(); return done(); }
          res.resume();
          } catch (e) {
            try { req.destroy(); } catch { /* already gone */ }
            if (isFatalDiskError(e)) { e.fatal = true; e.disk = true; }
            done(e);
          }
      });
      res.on('end', () => {
        if (!res.complete) {
          return done(Object.assign(new Error('Connection closed early'), { shortRead: true }));
        }
        if (boundTotal && pos < boundTotal) {
          return done(Object.assign(new Error(`Short read: ${pos} of ${boundTotal} bytes`), { shortRead: true }));
        }
        if (!boundTotal) this._singleDone = true;
        done();
      });
      res.on('error', (e) => done(e));
      res.on('aborted', () => done(new Error('Connection aborted')));
      res.on('close', () => {
        if (!res.complete && !settled) done(Object.assign(new Error('Connection closed early'), { shortRead: true }));
      });
    });
  }

  async _fetchChunk(seg) {
    const from = seg.start + seg.downloaded;
    if (seg.end >= 0 && from > seg.end) return;
    const hardEnd = seg.end >= 0 ? Math.min(from + CHUNK - 1, seg.end) : -1;
    const headers = { range: `bytes=${from}-${hardEnd}`, ...this._extraHeaders() };
    if (this.resumable && this.received > 0) {
      if (this.etag) headers['if-range'] = this.etag;
      else if (this.lastModified) headers['if-range'] = this.lastModified;
    }
    const { req, res } = await request(this.urls[this._urlIdx] || this.urls[0], { headers });
    this._activeReqs.add(req);
    try {
      if (res.statusCode === 206) {
        const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
        if (!m) {
          res.destroy();
          throw new Error('Server returned 206 without a valid Content-Range');
        }
        if (parseInt(m[1], 10) !== from) {
          res.destroy();
          throw new Error('Server returned wrong range offset');
        }
        if (m[3] !== '*' && this.total > 0 && parseInt(m[3], 10) !== this.total) {
          res.destroy();
          throw Object.assign(new Error('File size changed on server — restarting'), { restartNeeded: true, fallbackSingle: true });
        }
      } else if (res.statusCode === 200) {
        if (this.received > 0 || this.segments.length > 1) {
          res.destroy();
          throw Object.assign(new Error('File changed on server — restarting from scratch'), { restartNeeded: true, fallbackSingle: true });
        }
        this.resumable = false;
        seg.end = -1;
        await this._pump(res, seg, req, from, 0);
        return;
      } else if (res.statusCode === 416) {
        res.destroy();
        if (seg.end >= 0 && from > seg.end) return;
        throw new Error('Range not satisfiable');
      } else if (res.statusCode === 429 || res.statusCode === 503) {
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        res.destroy();
        const err = new Error('HTTP ' + res.statusCode + ' (rate limited)');
        err.retryAfter = retryAfter;
        throw err;
      } else if (res.statusCode >= 400 && res.statusCode < 500) {
        res.destroy();
        throw new FatalError('HTTP ' + res.statusCode);
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
    seg.downloaded = 0;
    const { req, res } = await request(this.urls[this._urlIdx] || this.urls[0], {
      headers: this._extraHeaders(),
    });
    this._activeReqs.add(req);
    try {
      if (res.statusCode === 429 || res.statusCode === 503) {
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        res.destroy();
        const err = new Error('HTTP ' + res.statusCode + ' (rate limited)');
        err.retryAfter = retryAfter;
        throw err;
      }
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        throw new Error('Too many redirects');
      }
      if (res.statusCode >= 400 && res.statusCode < 500) {
        res.destroy();
        throw new FatalError('HTTP ' + res.statusCode);
      }
      if (res.statusCode >= 500) {
        res.destroy();
        throw new Error('HTTP ' + res.statusCode);
      }
      if (!this.total) this.total = parseInt(res.headers['content-length'], 10) || 0;
      if (this.total > 0) await this._fd.truncate(this.total);
      else await this._fd.truncate(0);
      await this._pump(res, seg, req, 0, 0);
    } finally {
      this._activeReqs.delete(req);
    }
  }

  _isComplete() {
    if (!this.resumable || this.total <= 0 || this._forceSingle) return !!this._singleDone;
    if (!this.segments || !this.segments.length) return false;
    return this.segments.every((s) => s.downloaded >= s.end - s.start + 1) &&
      (this.total <= 0 || this.received >= this.total);
  }

  async _onWorkersDone(run) {
    if (run !== this._run) return;
    if (this._fd) { try { await this._fd.close(); } catch { /* ignore */ } this._fd = null; }
    this._lockedSegs.clear();
    this._samples = [];
    if (this._stop) { this.engine.markDirty(); return; }
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
    if (this.total <= 0) {
      const st = fs.statSync(this.partPath);
      if (st.size > 0) this.total = st.size;
    }
    fs.mkdirSync(this.destDir, { recursive: true });
    try {
      fs.renameSync(this.partPath, this.finalPath);
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
        this._dedupeFinalName();
        fs.renameSync(this.partPath, this.finalPath);
      } else throw e;
    }
    if (this.expectedChecksum) {
      try {
        const result = await this.verifyChecksum(this.checksumAlgo, this.expectedChecksum);
        if (!result.ok) this.error = 'Checksum mismatch (expected ' + normalizeHash(this.expectedChecksum).slice(0, 16) + '…)';
      } catch (e) {
        this.error = 'Checksum verification failed: ' + e.message;
      }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1;
    this.engine.markDirty();
    this.engine.saveSoon();
  }

  _dedupeFinalName() {
    const ext = path.extname(this.filename);
    const base = this.filename.slice(0, this.filename.length - ext.length);
    let n = 1;
    while (fs.existsSync(path.join(this.destDir, this.filename))) {
      this.filename = `${base} (${n++})${ext}`;
      if (n > 9999) break;
    }
  }

  _fail(msg) {
    if (this.status === 'canceled' || this.status === 'paused' || this.status === 'completed') return;
    this.status = 'failed';
    this.error = msg;
    this.speed = 0; this.eta = -1;
    setImmediate(() => { this._teardown().catch(() => {}); });
    this.engine.markDirty();
    this.engine.saveSoon();
  }

  async _closeFd() {
    const fd = this._fd;
    this._fd = null;
    if (!fd) return;
    try { await fd.close(); } catch { /* ignore */ }
  }

  async _teardown() {
    if (this._teardownPromise) return this._teardownPromise;
    this._teardownPromise = (async () => {
      this._run++;
      this._stop = true;
      for (const req of this._activeReqs) { try { req.destroy(); } catch { /* already gone */ } }
      this._activeReqs.clear();
      for (let i = 0; i < 100 && this.workers > 0; i++) await sleep(30);
      await this._closeFd();
      this._lockedSegs.clear();
      this._samples = [];
      this.engine.markDirty();
    })();
    try { await this._teardownPromise; }
    finally { this._teardownPromise = null; }
  }

  async pause(who) {
    if (!['downloading', 'probing', 'queued'].includes(this.status)) return;
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
    this._consecErrors = 0;
    this._restartedOnce = false;
    this._samples = [];
    this._fatalIdx.clear();
    this.engine.markDirty();
  }

  async cancel() {
    if (this.status === 'completed') return;
    this.status = 'canceled';
    this.pausedBy = '';
    await this._teardown();
    try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
    this.engine.saveNow();
  }

  retry() {
    if (this.status !== 'failed' && this.status !== 'canceled') return;
    this.status = 'queued';
    this.error = '';
    this._consecErrors = 0;
    this._restartedOnce = false;
    this._singleDone = false;
    this._fatalIdx.clear();
    this.pausedBy = '';
    this.engine.markDirty();
  }

  async restart() {
    await this._teardown();
    this.segments = null;
    this.total = 0;
    this._singleDone = false;
    this._forceSingle = false;
    this._restartedOnce = false;
    this._fatalIdx.clear();
    this.checksum = null;
    try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
    this.status = 'queued';
    this.error = '';
    this.pausedBy = '';
    this._consecErrors = 0;
    this._samples = [];
    this.engine.markDirty();
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
    this.speedLimit = Math.max(0, parseInt(bytesPerSec, 10) || 0);
    if (this.speedLimit > 0) {
      if (this._bucket) this._bucket.setRate(this.speedLimit);
      else this._bucket = new TokenBucket(this.speedLimit);
    } else this._bucket = null;
  }

  async verifyChecksum(algo, expected) {
    if (!algo) algo = guessAlgo(expected);
    if (!CHECKSUM_ALGOS.includes(algo)) throw new Error('Unsupported algorithm');
    const expectedNorm = normalizeHash(expected);
    if (!expectedNorm) throw new Error('Expected checksum is empty');
    const file = fs.existsSync(this.finalPath) ? this.finalPath : (fs.existsSync(this.partPath) ? this.partPath : '');
    if (!file) throw new Error('File not found (download it first)');
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algo);
      const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
      stream.on('data', (d) => hash.update(d));
      stream.on('error', reject);
      stream.on('end', () => {
        const actual = hash.digest('hex');
        this.checksum = { algo, expected: expectedNorm, actual, ok: actual === expectedNorm, at: Date.now(), file };
        this.engine.markDirty();
        this.engine.saveNow();
        resolve(this.checksum);
      });
    });
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

class Engine extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    const saved = store.load(this.stateFile, null);
    this.settings = normalizeSettings(saved && saved.settings);
    try { fs.mkdirSync(this.settings.rootDir, { recursive: true }); } catch { /* best effort */ }
    this.bucket = new TokenBucket(this.settings.globalSpeedLimit);
    this.items = new Map();
    for (const rec of (saved && saved.items) || []) {
      try {
        if (!rec || !rec.id) continue;
        this.items.set(rec.id, new Download(this, rec));
      } catch { /* skip corrupt record */ }
    }
    this.dirty = true;
    this._saveTimer = null;
    this._shutdownArmed = false;
    this._shutdownAt = 0;
    this._shutdownCanceled = false;
    this._haltedBySchedule = false;
    this._closed = false;
    this._startedAt = Date.now();
    this._exitHandler = () => this.saveNow();
    process.on('exit', this._exitHandler);
    this._tickTimer = setInterval(() => this._tick(), 500);
    this._tickTimer.unref();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._tickTimer);
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    process.removeListener('exit', this._exitHandler);
    this.saveNow();
  }

  markDirty() { this.dirty = true; }
  saveSoon() {
    this.markDirty();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, 1500);
    this._saveTimer.unref();
  }
  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      store.save(this.stateFile, {
        version: STATE_VERSION,
        savedAt: Date.now(),
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

  activeConnections() {
    let n = 0;
    for (const d of this.items.values()) if (d.status === 'downloading') n += d._lockedSegs.size;
    return n;
  }

  add({ urls, filename, category, segments, speedLimit, referer, cookies, dir, startedPaused, expectedChecksum, checksumAlgo, priority, skipSave }) {
    const list = (urls || []).filter(Boolean).map((u) => String(u).trim());
    if (!list.length) throw new Error('No URL provided');
    for (const u of list) {
      if (!/^https?:\/\//i.test(u)) throw new Error('Only http(s) URLs are supported');
    }
    const cleanName = filename ? sanitizeName(filename) : '';
    const d = new Download(this, {
      urls: list, filename: cleanName || nameFromUrl(list[0]),
      category: normalizeCategory(category), segmentsWanted: segments, speedLimit, referer,
      cookies, dir: cleanPathStr(dir) ? path.resolve(cleanPathStr(dir)) : '',
      status: startedPaused ? 'paused' : 'queued', expectedChecksum, checksumAlgo, priority,
      _urlNamed: !cleanName,
    });
    this.items.set(d.id, d);
    this._trimHistory();
    if (this._shutdownArmed) this.cancelShutdown();
    this._shutdownCanceled = false;
    if (!skipSave) this.saveNow();
    return d;
  }

  _trimHistory() {
    if (this.items.size <= MAX_ITEMS) return;
    const finished = [...this.items.values()]
      .filter((d) => ['completed', 'failed', 'canceled'].includes(d.status))
      .sort((a, b) => a.addedAt - b.addedAt);
    while (this.items.size > MAX_ITEMS && finished.length) {
      const d = finished.shift();
      this.items.delete(d.id);
    }
  }

  get(id) { return this.items.get(id); }

  async remove(id, deleteFile) {
    const d = this.items.get(id);
    if (!d) return false;
    if (d.status !== 'completed' && d.status !== 'failed' && d.status !== 'canceled') await d.cancel();
    if (deleteFile) {
      for (const p of [d.finalPath, d.partPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    this.items.delete(id);
    this.saveNow();
    return true;
  }

  async clearFinished(deleteFiles) {
    const done = [...this.items.values()].filter((d) => ['completed', 'failed', 'canceled'].includes(d.status));
    for (const d of done) {
      if (deleteFiles) {
        for (const p of [d.finalPath, d.partPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      }
      this.items.delete(d.id);
    }
    if (done.length) this.saveNow();
    return done.length;
  }

  retryAllFailed() {
    let n = 0;
    for (const d of this.items.values()) {
      if (d.status === 'failed') { d.retry(); n++; }
    }
    if (n) this.saveNow();
    return n;
  }

  pauseAll(who) {
    const jobs = [...this.items.values()].filter((d) => ['downloading', 'probing', 'queued'].includes(d.status));
    jobs.forEach((d) => d.pause(who));
  }
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
    return cur >= from || cur < to;
  }

  async _tick() {
    if (this._closed) return;
    try {
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
          d.start().catch((e) => console.error('[downloadX] start failed:', e.message));
        }
      }
      let anyActive = false;
      for (const d of this.items.values()) {
        d.computeSpeed();
        if (d.status === 'downloading' || d.status === 'probing') anyActive = true;
      }
      if (anyActive) { this.dirty = true; this.saveSoon(); }
      this._updateShutdown();
    } catch (e) {
      console.error('[downloadX] tick failed:', e.message);
    }
  }

  _updateShutdown() {
    if (!this.settings.shutdownWhenDone) {
      if (this._shutdownArmed) this.cancelShutdown();
      return;
    }
    const items = [...this.items.values()];
    const anyDone = items.some((d) => d.status === 'completed' && d.completedAt >= this._startedAt);
    const pending = items.some((d) =>
      ['downloading', 'probing', 'queued', 'paused'].includes(d.status) && d.pausedBy !== 'schedule');
    const failed = items.some((d) => d.status === 'failed');
    if (anyDone && !pending && !failed) {
      if (!this._shutdownArmed && !this._shutdownCanceled) {
        this._shutdownArmed = true;
        this._shutdownAt = Date.now() + SHUTDOWN_GRACE_MS;
        this.emit('shutdown-armed', { at: this._shutdownAt });
      }
      this.dirty = true;
    } else if (this._shutdownArmed && (pending || failed)) {
      this.cancelShutdown();
    }
    if (pending || failed) this._shutdownCanceled = false;
  }

  cancelShutdown() {
    if (!this._shutdownArmed) return;
    this._shutdownArmed = false;
    this._shutdownAt = 0;
    this._shutdownCanceled = true;
    this.emit('shutdown-cancelled');
  }
  isShutdownArmed() { return this._shutdownArmed; }

  snapshot() {
    return {
      version: STATE_VERSION,
      uptime: Math.round((Date.now() - this._startedAt) / 1000),
      items: [...this.items.values()].map((d) => d.snapshot()),
      settings: this.settings,
      globalSpeed: this.globalSpeed(),
      activeCount: this.activeCount(),
      activeConnections: this.activeConnections(),
      scheduleHalted: this._haltedBySchedule,
      shutdownArmed: this._shutdownArmed,
      shutdownIn: this._shutdownArmed ? Math.max(0, Math.ceil((this._shutdownAt - Date.now()) / 1000)) : 0,
    };
  }
}

function defaultRoot() {
  const home = os.homedir();
  const dl = path.join(home, 'Downloads');
  try { if (fs.existsSync(dl)) return dl; } catch { /* fall through */ }
  return dl;
}
module.exports = {
  Engine, Download, normalizeSettings, normalizeCategory, sanitizeName, categoryFor, nameFromUrl,
  normalizeHash, guessAlgo, CHECKSUM_ALGOS, DEFAULT_SETTINGS, CATEGORIES,
};
