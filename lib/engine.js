'use strict';
/*
 * downloadX engine — queue, scheduling, persistence and the connection budget.
 *
 * The engine owns every download, decides what runs next and keeps the state
 * file in sync. The per-file logic lives in lib/download.js.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { TokenBucket } = require('./bucket');
const store = require('./store');
const { Download } = require('./download');
const { createSafeLookup } = require('./origin');
const httpget = require('./httpget');
const { normalizeSettings, DEFAULT_SETTINGS } = require('./settings');
const { normalizeCategory, categoryFor } = require('./categories');
const { sanitizeName, nameFromUrl, normalizeHash, guessAlgo, sanitizeHeaders, CHECKSUM_ALGOS } = require('./naming');
const { clampInt, cleanPathStr, sleep } = require('./util');

const MAX_ITEMS = 2000;
const STATE_VERSION = 2;
const SHUTDOWN_GRACE_MS = 60000;
/* How many of the newest downloads keep their segment table in a snapshot. */
const RECENT_ITEMS = 50;
/* Statuses whose segment table is always worth sending. */
const ACTIVE_STATUSES = new Set(['downloading', 'probing', 'paused', 'queued']);

class Engine extends EventEmitter {
  /**
   * @param {string} dataDir where state.json lives
   */
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
    this._connUsed = 0;
    this._quotaUsed = 0;
    this._quotaResetAt = Date.now() + 60 * 60 * 1000;
    this._quotaHalted = false;
    this._snapshotCache = new Map();
    /*
     * The address guard. The URL the user asked for may live in a private
     * network (a NAS at home), so the first request is allowed - but every
     * redirect and every part of a remote playlist is checked.
     */
    this._allowPrivate = this.settings.allowPrivateNetworks !== false
      || process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS === '1';
    this._lookup = createSafeLookup(true);
    this._strictLookup = createSafeLookup(this._allowPrivate);
    /*
     * The address guard. The URL the user asked for may live in a private
     * network (a NAS at home), so the first request is allowed - but every
     * redirect and every part of a remote playlist is checked.
     */
    this._allowPrivate = this.settings.allowPrivateNetworks !== false
      || process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS === '1';
    this._lookup = createSafeLookup(true);
    this._strictLookup = createSafeLookup(this._allowPrivate);
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

  /* ---------------- global connection budget ---------------- */

  /** Global cap on simultaneously open connections (0 = unlimited). */
  get connectionLimit() {
    const n = parseInt(this.settings.maxConnections, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Claim one connection slot. Returns false when the budget is exhausted so the
   * caller can wait instead of opening more sockets than the user allowed.
   */
  /**
   * Claim one connection slot.
   * @returns {boolean} false when the budget is exhausted
   */
  reserveConnection() {
    const limit = this.connectionLimit;
    if (limit <= 0) { this._connUsed++; return true; }
    if (this._connUsed >= limit) return false;
    this._connUsed++;
    return true;
  }

  /** Give a connection slot back. */
  releaseConnection() {
    this._connUsed = Math.max(0, this._connUsed - 1);
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

  /** Number of network connections currently open across all downloads. */
  activeConnections() {
    return this._connUsed;
  }

  /**
   * Add a download.
   * @param {{ urls?: string[], filename?: string, category?: string, segments?: number,
   *   speedLimit?: number, referer?: string, cookies?: string, dir?: string,
   *   startedPaused?: boolean, expectedChecksum?: string, checksumAlgo?: string,
   *   priority?: number, skipSave?: boolean, headers?: Record<string, string>,
   *   username?: string, password?: string, proxy?: string }} options
   * @returns {Download}
   */
  add({ urls, filename, category, segments, speedLimit, referer, cookies, dir, startedPaused, expectedChecksum, checksumAlgo, priority, skipSave, headers, username, password, proxy, schedule, dependsOn }) {
    const list = (urls || []).filter(Boolean).map((u) => String(u).trim());
    if (!list.length) throw new Error('No URL provided');
    for (const u of list) {
      if (!/^(https?|ftps?):\/\//i.test(u)) throw new Error('Only http(s) and ftp(s) URLs are supported');
    }
    const cleanName = filename ? sanitizeName(filename) : '';
    const d = new Download(this, {
      urls: list, filename: cleanName || nameFromUrl(list[0]),
      category: normalizeCategory(category), segmentsWanted: segments, speedLimit, referer,
      cookies, headers, username, password, proxy,
      dir: cleanPathStr(dir) ? path.resolve(cleanPathStr(dir)) : '',
      status: startedPaused ? 'paused' : 'queued', expectedChecksum, checksumAlgo, priority,
      _urlNamed: !cleanName,
      schedule, dependsOn,
    });
    if (d.dependsOn && !this._noCycle(d.id)) {
      this.items.delete(d.id);
      throw new Error('That would create a loop between the downloads');
    }
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

  /**
   * Tell a webhook that a download finished or failed.
   * The call is fire and forget: a broken webhook never affects a download.
   * @param {'completed'|'failed'} event
   * @param {Download} d
   */
  notifyWebhook(event, d) {
    const url = String(this.settings.webhookUrl || '').trim();
    if (!url) return;
    const payload = {
      event,
      id: d.id,
      filename: d.filename,
      url: d.urls[0] || '',
      path: d.finalPath,
      size: d.total || 0,
      error: d.error || '',
      at: Date.now(),
    };
    const body = JSON.stringify(payload);
    httpget.request(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      proxy: this.settings.proxy,
      rejectUnauthorized: !this.settings.allowInvalidTls,
      timeoutMs: 10000,
    }).then(({ res }) => { res.resume(); }).catch((e) => {
      console.error('[downloadX] webhook failed:', e.message);
    });
  }

  /**
   * Remove a download from the list.
   *
   * `deleteFiles` is explicit: without it nothing on disk is touched, so a
   * stopped transfer keeps its partial data and the caller stays in control of
   * what is deleted.
   * @param {string} id
   * @param {boolean} [deleteFiles]
   * @returns {Promise<boolean>} false when the id is unknown
   */
  async remove(id, deleteFiles) {
    const d = this.items.get(id);
    if (!d) return false;
    if (d.status !== 'completed' && d.status !== 'failed' && d.status !== 'canceled') {
      await d.cancel({ keepFiles: true });
    }
    if (deleteFiles) this.deleteFilesOf(d);
    this.items.delete(id);
    this._snapshotCache.delete(id);
    this.saveNow();
    return true;
  }

  /** Delete every file a download produced (final file plus partial parts). */
  deleteFilesOf(d) {
    const paths = [d.finalPath, d.partPath, d.audioPartPath];
    for (const p of paths) {
      try { fs.unlinkSync(p); } catch { /* not there (or still open) */ }
    }
  }

  async clearFinished(deleteFiles) {
    const done = [...this.items.values()].filter((d) => ['completed', 'failed', 'canceled'].includes(d.status));
    for (const d of done) {
      if (deleteFiles) this.deleteFilesOf(d);
      this.items.delete(d.id);
      this._snapshotCache.delete(d.id);
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

  /**
   * Export the portable download list. The file is intentionally independent
   * of the state.json format so it can be imported on another installation.
   * @returns {{ app: string, version: number, exportedAt: number, items: object[] }}
   */
  exportList() {
    return {
      app: 'downloadX',
      version: STATE_VERSION,
      exportedAt: Date.now(),
      items: [...this.items.values()].map((d) => d.exportRec()),
    };
  }

  /**
   * Import a previously exported list. Imported downloads start paused so an
   * import never surprises the user with a burst of traffic.
   * @param {object|object[]} data
   * @param {{ startNow?: boolean }} [options]
   * @returns {{ added: number, items: object[], errors: {item: unknown, error: string}[] }}
   */
  importList(data, options = {}) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
    const startNow = options.startNow === true;
    const added = [];
    const errors = [];
    for (const entry of list) {
      try {
        const item = typeof entry === 'string' ? { urls: [entry] } : entry;
        if (!item || typeof item !== 'object') throw new Error('Not a download record');
        const urls = Array.isArray(item.urls) ? item.urls : (item.url ? [item.url] : []);
        const d = this.add({
          urls,
          filename: item.filename,
          category: item.category,
          segments: item.segmentsWanted ?? item.segments,
          speedLimit: item.speedLimit,
          referer: item.referer,
          cookies: item.cookies,
          dir: item.dir,
          startedPaused: !startNow,
          expectedChecksum: item.expectedChecksum,
          checksumAlgo: item.checksumAlgo,
          priority: item.priority,
          skipSave: true,
          headers: item.headers,
          username: item.username,
          password: item.password,
          proxy: item.proxy,
          schedule: item.schedule,
          // Dependencies refer to ids from the old list, so they are not
          // carried over. The user can re-link them from the details panel.
          dependsOn: null,
        });
        added.push(d);
      } catch (e) {
        errors.push({ item: entry, error: e.message });
      }
    }
    if (added.length) this.saveNow();
    return { added: added.length, items: added.map((d) => d.snapshot()), errors };
  }

  /**
   * Count bytes that actually reached the disk. The hourly quota is enforced by
   * the ticker, which pauses the queue once the limit is reached.
   * @param {number} n
   */
  recordTraffic(n) {
    const bytes = Math.max(0, parseInt(n, 10) || 0);
    if (!bytes) return;
    if (Date.now() >= this._quotaResetAt) {
      this._quotaUsed = 0;
      this._quotaResetAt = Date.now() + 60 * 60 * 1000;
      this._quotaHalted = false;
    }
    this._quotaUsed += bytes;
  }

  _checkQuota() {
    const quota = parseInt(this.settings.hourlyQuota, 10) || 0;
    if (!quota) {
      if (this._quotaHalted) {
        this._quotaHalted = false;
        this.resumeAll('quota');
      }
      return;
    }
    if (Date.now() >= this._quotaResetAt) {
      this._quotaUsed = 0;
      this._quotaResetAt = Date.now() + 60 * 60 * 1000;
      if (this._quotaHalted) {
        this._quotaHalted = false;
        this.resumeAll('quota');
      }
      return;
    }
    if (this._quotaUsed >= quota && !this._quotaHalted) {
      this._quotaHalted = true;
      this.pauseAll('quota');
    } else if (this._quotaUsed < quota && this._quotaHalted) {
      this._quotaHalted = false;
      this.resumeAll('quota');
    }
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

  /**
   * True when the download may run right now: its parent has to be finished
   * and its own time window has to be open.
   * @param {Download} d
   * @returns {boolean}
   */
  _mayRun(d) {
    if (d.blockedBy) return false;
    if (!d.schedule) return true;
    const s = d.schedule;
    if (!s.windowStart && !s.windowEnd && !s.days.length) return true;
    const now = new Date();
    if (s.days.length && !s.days.includes(now.getDay())) return false;
    const toMinutes = (hhmm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
      if (!m) return null;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    };
    const start = toMinutes(s.windowStart);
    const end = toMinutes(s.windowEnd);
    if (start === null || end === null) return true;
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (start === end) return true;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  }

  /**
   * Resolve the dependencies: a download waits for its parent.
   * @param {Download} d
   */
  _resolveDependency(d) {
    if (!d.dependsOn) { d.blockedBy = ''; return; }
    const parent = this.items.get(d.dependsOn);
    if (!parent) {
      d.blockedBy = 'the download it waits for no longer exists';
      return;
    }
    if (parent.id === d.id) {
      d.blockedBy = 'it waits for itself';
      return;
    }
    if (parent.status === 'failed' || parent.status === 'canceled') {
      d.blockedBy = 'the download it waits for failed';
      return;
    }
    d.blockedBy = parent.status === 'completed' ? '' : 'it waits for another download';
  }

  /**
   * True when the dependency graph of the given download has no cycle.
   * @param {string} id
   * @returns {boolean}
   */
  _noCycle(id) {
    const seen = new Set();
    let current = this.items.get(id);
    while (current && current.dependsOn) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = this.items.get(current.dependsOn);
    }
    return true;
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

      // The hourly traffic quota pauses the queue until the window resets.
      this._checkQuota();

      // The dependencies and the time windows of every download.
      for (const d of this.items.values()) this._resolveDependency(d);

      if (!this._haltedBySchedule && !this._quotaHalted) {
        const queued = [...this.items.values()]
          .filter((d) => d.status === 'queued')
          .sort((a, b) => (b.priority - a.priority) || (a.addedAt - b.addedAt));
        for (const d of queued) {
          if (this.activeCount() >= this.settings.maxConcurrent) break;
          // A download waits for its parent and for its own time window.
          if (!this._mayRun(d)) continue;
          if (d.schedule && d.schedule.speedLimit) d.setSpeedLimit(d.schedule.speedLimit);
          d.start().catch((e) => console.error('[downloadX] start failed:', e.message));
        }
      }
      let anyActive = false;
      for (const d of this.items.values()) {
        if (d.status === 'downloading' && d.schedule && !this._mayRun(d)) {
          // The window closed: pause until it opens again.
          d.pause('schedule').catch(() => {});
        } else if (d.status === 'paused' && d.pausedBy === 'schedule' && this._mayRun(d)) {
          // The window opened again: continue.
          d.resume();
        }
        // Only live transfers have a speed to measure.
        if (d.status === 'downloading' || d.status === 'probing') {
          d.computeSpeed();
          anyActive = true;
        }
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

  /**
   * The snapshot of one download, cached while nothing about it changed.
   * Finished downloads never change, so the live feed does not rebuild them
   * on every frame.
   */
  _snapshotFor(d) {
    const key = [d.id, d.status, d.received, d.total, d.error, d.checksum ? d.checksum.at : 0].join('|');
    const hit = this._snapshotCache.get(d.id);
    if (hit && hit.key === key) return hit.snap;
    const snap = d.snapshot();
    this._snapshotCache.set(d.id, { key, snap });
    return snap;
  }

  /**
   * True when private and reserved addresses may be reached. The user can
   * allow them in the settings; the test suites allow them through the
   * environment.
   * @returns {boolean}
   */
  allowsPrivateNetworks() {
    return this._allowPrivate;
  }

  /**
   * The live snapshot of every download plus the settings and the counters.
   * @returns {Record<string, unknown>}
   */
  snapshot() {
    /*
     * Segment tables are only useful for the working set. Older entries keep
     * their totals so the list stays complete, but they do not ship a table
     * for every live frame - that would turn a long history into megabytes of
     * JSON per update.
     */
    const items = [...this.items.values()];
    const recent = new Set(items.slice(-RECENT_ITEMS).map((d) => d.id));
    const snapshots = items.map((d) => {
      const snap = this._snapshotFor(d);
      const active = ACTIVE_STATUSES.has(d.status);
      if (!active && !recent.has(d.id) && snap.segments.length) {
        return { ...snap, segmentsTotal: d.segments ? d.segments.length : 0, segments: [], segmentsOmitted: true };
      }
      return snap;
    });
    return {
      version: STATE_VERSION,
      uptime: Math.round((Date.now() - this._startedAt) / 1000),
      items: snapshots,
      settings: this.settings,
      globalSpeed: this.globalSpeed(),
      activeCount: this.activeCount(),
      activeConnections: this.activeConnections(),
      connectionLimit: this.connectionLimit,
      scheduleHalted: this._haltedBySchedule,
      quotaHalted: this._quotaHalted,
      quotaUsed: this._quotaUsed,
      quotaLimit: this.settings.hourlyQuota || 0,
      quotaResetIn: Math.max(0, Math.ceil((this._quotaResetAt - Date.now()) / 1000)),
      shutdownArmed: this._shutdownArmed,
      shutdownIn: this._shutdownArmed ? Math.max(0, Math.ceil((this._shutdownAt - Date.now()) / 1000)) : 0,
    };
  }
}

module.exports = {
  Engine,
  Download,
  normalizeSettings,
  normalizeCategory,
  sanitizeName,
  categoryFor,
  nameFromUrl,
  normalizeHash,
  guessAlgo,
  CHECKSUM_ALGOS,
  DEFAULT_SETTINGS,
  CATEGORIES: require('./categories').CATEGORIES,
  sanitizeHeaders,
  clampInt,
  sleep,
};
