'use strict';
/*
 * A single download: probe → segment → transfer → verify → finalize.
 *
 * The class owns everything that belongs to one file: its URL(s), the on-disk
 * part file, the segment table, the per-download speed limiter and the
 * retry/back-off policy. The Engine owns scheduling and persistence.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { TokenBucket } = require('./bucket');
const { sanitizeName, sanitizeHeaders, normalizeHash, guessAlgo, CHECKSUM_ALGOS } = require('./naming');
const { normalizeCategory } = require('./categories');
const { clampInt, cleanPathStr, sleep, freeSpaceFor, backoffDelay } = require('./util');
const TransferMixin = require('./transfer');
const StreamMixin = require('./stream');

const MIN_SPLIT = 1 * 1024 * 1024;
const MAX_BACKOFF = 30000;
const MAX_RETRY_AFTER = 120000;
const SPEED_WINDOW_MS = 5000;
const MAX_SNAPSHOT_SEGMENTS = 64;
const DISK_HEADROOM = 32 * 1024 * 1024;

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

class Download {
  /**
   * @param {Engine} engine the engine that owns this download
   * @param {Record<string, unknown>} [rec] a saved record (from state.json)
   */
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
    this.headers = sanitizeHeaders(rec.headers);
    this.username = String(rec.username || '');
    this.password = String(rec.password || '');
    this.proxy = typeof rec.proxy === 'string' ? rec.proxy.trim() : '';
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
    this.stream = rec.stream && typeof rec.stream === 'object'
      ? {
        kind: rec.stream.kind === 'dash' ? 'dash' : 'hls',
        index: Math.max(0, parseInt(rec.stream.index, 10) || 0),
        total: Math.max(0, parseInt(rec.stream.total, 10) || 0),
      }
      : null;
    this._keys = new Map();
    this.pausedBy = rec.pausedBy || '';
    this.variants = Array.isArray(rec.variants) ? rec.variants : [];
    this.variantIndex = Number.isInteger(rec.variantIndex) ? rec.variantIndex : -1;
    this.finalUrl = rec.finalUrl || this.urls[0];
    this._urlNamed = rec._urlNamed != null ? !!rec._urlNamed : !rec.filename;
    this._forceSingle = !!rec._forceSingle;
    this._probeIdx = clampInt(rec._probeIdx, 0, Math.max(0, this.urls.length - 1), 0);
    this.speed = 0; this.eta = -1; this.workers = 0;
    this._fd = null; this._streamFds = null; this._stop = false;
    this._abort = null;
    this._samples = []; this._lockedSegs = new Set();
    this._activeReqs = new Set(); this._consecErrors = 0; this._urlIdx = 0;
    this._fatalIdx = new Set();
    this._singleDone = !!rec._singleDone;
    this._restartedOnce = false;
    this._repairTried = false;
    this._run = 0;
    this._teardownPromise = null;
    this._bucket = this.speedLimit > 0 ? new TokenBucket(this.speedLimit) : null;
    if (this.status === 'downloading' || this.status === 'probing') this.status = 'queued';
    if (this.status === 'canceled' && !rec.filename) this.filename = 'download';
  }

  get received() {
    if (this.stream) return this.stream.index;
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
      cookies: this.cookies, headers: this.headers, username: this.username, password: this.password,
      proxy: this.proxy, pausedBy: this.pausedBy, finalUrl: this.finalUrl,
      variants: this.variants, variantIndex: this.variantIndex,
      _singleDone: this._singleDone, _forceSingle: this._forceSingle, _urlNamed: this._urlNamed,
      _probeIdx: this._probeIdx,
    };
    if (this.status !== 'completed') rec.segments = this.segments;
    if (this.stream) rec.stream = { kind: this.stream.kind, index: this.stream.index, total: this.stream.total };
    return rec;
  }

  get audioPath() {
    const ext = path.extname(this.filename);
    const base = this.filename.slice(0, this.filename.length - ext.length);
    return path.join(this.destDir, base + '.audio.m4a');
  }
  get audioPartPath() { return this.audioPath + '.' + this.id.slice(0, 8) + '.dxpart'; }

  /**
   * The public view of this download.
   * @returns {Record<string, unknown>}
   */
  snapshot() {
    let segments = this.segments || [];
    if (!segments.length && this.status === 'completed' && this.total > 0) {
      segments = [{ start: 0, end: this.total - 1, downloaded: this.total }];
    }
    const truncated = segments.length > MAX_SNAPSHOT_SEGMENTS;
    if (truncated) segments = segments.slice(0, MAX_SNAPSHOT_SEGMENTS);
    const snap = {
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
    if (truncated) snap.segmentsTotal = this.segments.length;
    if (this.stream) {
      snap.total = this.stream.total;
      snap.received = this.stream.index;
      snap.canResume = this.stream.index > 0;
      snap.stream = this.stream.kind;
      snap.segments = [];
      if (this.variants.length) {
        snap.variants = this.variants;
        snap.variantIndex = this.variantIndex;
      }
    }
    return snap;
  }

  _extraHeaders() {
    const h = {};
    if (this.referer) h.referer = this.referer;
    if (this.cookies) h.cookie = this.cookies;
    if (this.headers) Object.assign(h, this.headers);
    return h;
  }

  /**
   * The options for a network request.
   * @param {Record<string, string>} [headers]
   * @param {boolean} [strict] true for resources that a remote document names
   *   (playlist parts, encryption keys): they must not reach a private host.
   * @returns {Record<string, unknown>}
   */
  _netOpts(headers, strict) {
    const opts = { headers: headers || { ...this._extraHeaders() } };
    if (this.username || this.password) opts.credentials = { user: this.username, pass: this.password };
    const proxy = this.proxy || this.engine.settings.proxy;
    if (proxy) opts.proxy = proxy;
    if (this.engine.settings.allowInvalidTls) opts.rejectUnauthorized = false;
    if (this._abort) opts.signal = this._abort.signal;
    const engine = this.engine;
    opts.lookup = strict ? engine._strictLookup : engine._lookup;
    opts.redirectLookup = engine._strictLookup;
    return opts;
  }

  /**
   * Claim one of the engine's global connection slots.
   * The returned release function is idempotent and is called once the socket
   * is really gone — never before.
   */

  /**
   * A saved segment table is only reusable when it exactly covers the file:
   * contiguous ranges, no gaps, no overlaps and sane byte counters.
   */
  _segmentsValid() {
    if (!Array.isArray(this.segments) || !this.segments.length) return false;
    if (!this.resumable || this.total <= 0 || this._forceSingle) return false;
    const sorted = [...this.segments].sort((a, b) => (a.start || 0) - (b.start || 0));
    let cursor = 0;
    for (const s of sorted) {
      if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) return false;
      if (s.start < 0 || s.end < s.start || s.end >= this.total) return false;
      if (s.start !== cursor) return false;
      const len = s.end - s.start + 1;
      if (!Number.isFinite(s.downloaded) || s.downloaded < 0 || s.downloaded > len) return false;
      cursor = s.end + 1;
    }
    return cursor === this.total;
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

  /** Highest byte offset that the segment table claims to have written. */
  _requiredBytes() {
    if (!this.segments || !this.segments.length) return 0;
    let need = 0;
    for (const s of this.segments) {
      if (!Number.isFinite(s.start) || !Number.isFinite(s.downloaded)) continue;
      need = Math.max(need, s.start + Math.max(0, s.downloaded));
    }
    return need;
  }

  /**
   * A part file shorter than the recorded progress means the data was lost or
   * truncated behind our back — the safe move is to start the file over.
   */
  _validatePartFile() {
    let size = 0;
    try { size = fs.statSync(this.partPath).size; } catch { return false; }
    const need = this._requiredBytes();
    if (need > size) {
      this.segments.forEach((s) => { s.downloaded = 0; });
      this._singleDone = false;
      return false;
    }
    return true;
  }

  _checkDiskSpace() {
    if (this.total <= 0) return null;
    const free = freeSpaceFor(this.destDir);
    if (free == null) return null;
    const need = Math.max(0, this.total - this.received);
    if (free < need + DISK_HEADROOM) {
      const mb = (v) => (v / (1024 * 1024)).toFixed(0);
      return 'Not enough disk space: ' + mb(need) + ' MB needed, ' + mb(free) + ' MB free';
    }
    return null;
  }

  async start() {
    if (this._fd || this.status === 'downloading' || this.status === 'probing') return;
    if (this.status === 'paused' || this.status === 'canceled' || this.status === 'completed') return;
    if (this._teardownPromise) await this._teardownPromise;
    if (this.status !== 'queued') return;
    const run = ++this._run;
    this._abort = new AbortController();
    try {
      if (!this.segments || !this.resumable || this._forceSingle) await this._probe();
    } catch (e) {
      if (e && e.cancelled) return;
      return this._fail(e.fatal ? e.message : 'Probe failed: ' + e.message);
    }
    const invalidated = () => run !== this._run;
    if (invalidated()) return;
    if (this.stream) return this._startStream(run);
    if (!this._destDir) this._destDir = this._computeDestDir();
    try {
      const dir = this.destDir;
      fs.mkdirSync(dir, { recursive: true });
      this._dedupeName(dir);
      this._buildSegments();
      const partExists = fs.existsSync(this.partPath);
      if (partExists) {
        this._validatePartFile();
      } else if (this.segments.some((s) => s.downloaded > 0)) {
        this.segments.forEach((s) => { s.downloaded = 0; });
        this._singleDone = false;
      }
      const noSpace = this._checkDiskSpace();
      if (noSpace) return this._fail(noSpace);
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
    return backoffDelay(this._consecErrors, MAX_BACKOFF);
  }

  _maxRetries() {
    const n = parseInt(this.engine.settings.maxRetries, 10);
    return Number.isFinite(n) && n > 0 ? n : 12;
  }

  async _workerLoop() {
    this.workers++;
    try {
      while (!this._stop && this.status === 'downloading') {
        if (!this.resumable || this.total <= 0 || this._forceSingle) {
          if (this._singleDone) break;
          try { await this._fetchSingle(); this._consecErrors = 0; }
          catch (e) {
            if (this._stop || e.cancelled) break;
            if (e.disk) return this._fail(e.message);
            if (e.fatal) {
              if (this._markUrlFailed()) { this.error = e.message; await sleep(this._retryDelay(e)); continue; }
              return this._fail(e.message);
            }
            this._consecErrors++;
            this.error = e.message;
            if (this._consecErrors >= this._maxRetries()) return this._fail('Too many errors: ' + e.message);
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
        const beforeDownloaded = seg.downloaded;
        try {
          await this._fetchChunk(seg);
          this._consecErrors = 0;
        } catch (e) {
          if (this._stop || e.cancelled) { this._unlock(seg); break; }
          if (e.shortRead) {
            this._unlock(seg);
            /*
             * A connection that closed early is not a failure as long as it
             * delivered something - the segment is simply continued. A short
             * read without any progress would loop forever, so it counts as an
             * error like any other.
             */
            if (seg.downloaded > beforeDownloaded) this._consecErrors = 0;
            else {
              this._consecErrors++;
              if (this._consecErrors >= this._maxRetries()) {
                return this._fail('Too many errors: ' + e.message);
              }
            }
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
          if (this._consecErrors >= this._maxRetries()) { this._unlock(seg); return this._fail('Too many errors: ' + e.message); }
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
      const result = await this.verifyChecksum(this.checksumAlgo, this.expectedChecksum);
      if (!result.ok) {
        if (!this._repairTried) {
          /*
           * The file does not match the expected hash: the transfer was
           * damaged. Download it once more before giving up.
           */
          this._repairTried = true;
          this.checksum = null;
          try { fs.unlinkSync(this.finalPath); } catch { /* nothing there */ }
          this.segments = null;
          this.total = 0;
          this._singleDone = false;
          this._forceSingle = false;
          this._restartedOnce = false;
          this.status = 'queued';
          this.error = 'Checksum mismatch — downloading again';
          this.engine.markDirty();
          this.engine.saveSoon();
          return;
        }
        this.error = 'Checksum mismatch (expected ' + normalizeHash(this.expectedChecksum).slice(0, 16) + '…)';
      } else {
        this.error = '';
      }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1;
    this.engine.markDirty();
    this.engine.saveSoon();
    this.engine.notifyWebhook('completed', this);
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
    this.engine.notifyWebhook('failed', this);
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
      // Abort first: sockets that are still waiting for headers or data stop
      // immediately instead of lingering until they time out.
      if (this._abort) {
        try { this._abort.abort(); } catch { /* already aborted */ }
        this._abort = null;
      }
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

  /**
   * Stop the transfer. The partial files are removed unless `keepFiles` is set,
   * so callers that only want to drop a list entry can leave the disk alone.
   */
  async cancel(options = {}) {
    if (this.status === 'completed') return;
    const keepFiles = options.keepFiles === true;
    this.status = 'canceled';
    this.pausedBy = '';
    await this._teardown();
    if (!keepFiles) {
      try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
      if (this.stream) try { fs.unlinkSync(this.audioPartPath); } catch { /* no audio part */ }
    }
    this.engine.saveNow();
  }

  retry() {
    if (this.status !== 'failed' && this.status !== 'canceled') return;
    this.status = 'queued';
    this.error = '';
    this._consecErrors = 0;
    this._restartedOnce = false;
    this._repairTried = false;
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
    this._repairTried = false;
    this._fatalIdx.clear();
    this.checksum = null;
    if (this.stream) {
      this.stream.index = 0;
      this._keys.clear();
    }
    try { fs.unlinkSync(this.partPath); } catch { /* no part file */ }
    if (this.stream) try { fs.unlinkSync(this.audioPartPath); } catch { /* no audio part */ }
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


module.exports = { Download, parseRetryAfter, MAX_SNAPSHOT_SEGMENTS };

/*
 * The HTTP range transfer and the HLS/DASH capture live in their own modules
 * so this file stays readable. Their methods are copied onto the prototype
 * with their original descriptors, so they behave exactly like the methods
 * defined in the class above.
 */
Object.defineProperties(Download.prototype, {
  ...Object.getOwnPropertyDescriptors(TransferMixin.prototype),
  ...Object.getOwnPropertyDescriptors(StreamMixin.prototype),
});
