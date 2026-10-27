'use strict';
/*
 * HLS and DASH capture of a Download.
 *
 * Playlist parsing, part fetching, AES-128 decryption and the sequential
 * assembly of the media file. The methods are mixed into the Download class
 * (see lib/download.js) and use "this" exactly like the methods that live
 * there.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const streams = require('./streams');
const { FatalError } = require('./httpget');
const retry = require('./retry');
const { sleep, isFatalDiskError, promoteFile } = require('./util');

/** A readable label for a quality: "1080p - 4.5 Mbps". */
function variantLabel(variant) {
  const parts = [];
  if (variant.resolution) parts.push(String(variant.resolution));
  if (variant.bandwidth) parts.push((variant.bandwidth / 1000000).toFixed(1) + ' Mbps');
  return parts.join(' - ') || 'default';
}

class StreamMixin {
  /**
   * Build the part list for the stream.
   *
   * The available qualities are recorded on the download so the user can pick
   * another one later; `this.variantIndex` selects it (-1 means "the best").
   */
  async _fetchPlan() {
    const startUrl = this.finalUrl || this.urls[0];
    const body = await this._fetchText(startUrl, this._netOpts());
    if (this.stream.kind === 'hls') {
      let parsed = streams.parseM3u8(body, startUrl);
      if (parsed.kind === 'master') {
        if (!parsed.variants.length) throw new FatalError('Empty HLS master playlist');
        this.variants = parsed.variants.map((v, i) => ({
          url: v.url,
          bandwidth: v.bandwidth || 0,
          resolution: v.resolution || '',
          codecs: v.codecs || '',
          label: variantLabel(v),
          index: i,
        }));
        const chosen = this.selectedVariant();
        const variantUrl = chosen.url;
        const mediaBody = await this._fetchText(variantUrl, this._netOpts(undefined, true));
        parsed = streams.parseM3u8(mediaBody, variantUrl);
        if (parsed.kind !== 'media') throw new FatalError('HLS master points to another master playlist');
      }
      if (!parsed.segments.length) throw new FatalError('HLS playlist has no segments');
      return { kind: 'hls', map: parsed.map, segments: parsed.segments };
    }
    const mpd = streams.parseMpd(body, startUrl, { videoIndex: this.variantIndex });
    if (!mpd.video && !mpd.audio) throw new FatalError('DASH manifest has no playable streams');
    this.variants = (mpd.videos || []).map((v, i) => ({
      url: v.repBase || '',
      bandwidth: v.bandwidth || 0,
      resolution: v.width && v.height ? `${v.width}x${v.height}` : '',
      codecs: v.mime || '',
      label: variantLabel({ bandwidth: v.bandwidth, resolution: v.width && v.height ? `${v.width}x${v.height}` : '' }),
      index: i,
    }));
    return { kind: 'dash', video: mpd.video, audio: mpd.audio };
  }

  /** The quality the user picked, or the best one. */
  selectedVariant() {
    const list = this.variants || [];
    if (!list.length) return null;
    const i = Number.isInteger(this.variantIndex) && this.variantIndex >= 0 && this.variantIndex < list.length
      ? this.variantIndex : 0;
    return list[i] || list[0];
  }

  _buildStreamTasks(plan) {
    const tasks = [];
    /*
     * `useUnitInit` is false for HLS: there the initialisation section belongs
     * to the part it was declared with, so only the per-part map counts. DASH
     * has one init section per representation, which the unit provides.
     */
    const addUnit = (unit, out, useUnitInit) => {
      if (!unit) return;
      let emitted = null;
      for (const s of unit.segments) {
        const init = s.map || (useUnitInit ? unit.init : null) || null;
        if (init && init !== emitted) {
          tasks.push({ url: init, init: true, out });
          emitted = init;
        }
        tasks.push({ url: s.url, key: s.key || null, byterange: s.byterange || null, seq: s.seq, out });
      }
    };
    if (plan.kind === 'hls') addUnit({ init: plan.map, segments: plan.segments }, 'main', false);
    else {
      addUnit(plan.video, 'video', true);
      addUnit(plan.audio, 'audio', true);
    }
    return tasks;
  }

  async _fetchKey(url) {
    if (this._keys.has(url)) return this._keys.get(url);
    const hooks = {
      onReq: (req) => this._activeReqs.add(req),
      onDone: (req) => this._activeReqs.delete(req),
    };
    const buf = await this._fetchBuffer(url, this._netOpts(undefined, true), hooks);
    if (buf.length !== 16) throw new Error('Invalid AES-128 key from ' + url);
    this._keys.set(url, buf);
    return buf;
  }

  async _fetchStreamPart(task) {
    let attempt = 0;
    for (;;) {
      try {
        const headers = { ...this._extraHeaders() };
        if (task.byterange) {
          headers.range = `bytes=${task.byterange.offset}-${task.byterange.offset + task.byterange.length - 1}`;
        }
        const hooks = {
          onReq: (req) => this._activeReqs.add(req),
          onDone: (req) => this._activeReqs.delete(req),
        };
        let buf = await this._fetchBuffer(task.url, this._netOpts(headers, true), hooks);
        if (task.key) {
          const key = await this._fetchKey(task.key.url);
          const iv = task.key.iv
            ? Buffer.from(task.key.iv.replace(/^0x/i, ''), 'hex')
            : streams.ivFromSequence(task.seq || 0);
          buf = streams.decryptAes128(buf, key, iv);
        }
        return buf;
      } catch (e) {
        if (this._stop || e.fatal || e.cancelled) throw e;
        if (++attempt >= 5) throw e;
        this.error = e.message;
        // Retry-After is an explicit instruction from the server; the shared
        // host gate keeps the other parts of the stream from barging in (and
        // already applies the delay before the next request).
        const wait = e.rateLimited ? 0
          : e.retryAfter ? Math.min(120000, e.retryAfter)
            : Math.min(1000 * 2 ** (attempt - 1), 8000);
        if (wait) await sleep(wait);
      }
    }
  }

  async _closeStreamFds() {
    if (this._streamFds) {
      for (const k of Object.keys(this._streamFds)) {
        const fd = this._streamFds[k];
        if (!fd) continue;
        try { await fd.close(); } catch { /* ignore */ }
        this._streamFds[k] = null;
      }
    }
    await this._closeFd();
  }

  async _finalizeStream() {
    await this._closeStreamFds();
    // Any error text from a transient retry is stale once the stream is done.
    this.error = '';
    // Capture both source names before a collision can change this.filename
    // (and with it the part-path getters).
    const partPath = this.partPath;
    const audioPartPath = this.audioPartPath;
    const hasAudio = this.stream.kind === 'dash' && fs.existsSync(audioPartPath);
    // Same no-clobber promotion as a normal download: a finished file may
    // have appeared while the stream was being assembled.
    for (let attempt = 0; ; attempt++) {
      if (promoteFile(partPath, this.finalPath)) break;
      this._dedupeFinalName();
      if (attempt > 9999) throw new Error('Could not find a free file name');
    }
    if (hasAudio) {
      let audioPath = this.audioPath;
      const ext = path.extname(audioPath);
      const base = audioPath.slice(0, audioPath.length - ext.length);
      for (let attempt = 0; ; attempt++) {
        if (promoteFile(audioPartPath, audioPath)) break;
        audioPath = `${base} (${attempt + 1})${ext}`;
        if (attempt > 9999) throw new Error('Could not find a free audio file name');
      }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1;
    this.engine.markDirty();
    this.engine.saveSoon();
  }

  async _startStream(run) {
    let plan;
    const maxPlanTries = this._maxRetries();
    for (let attempt = 1; ; attempt++) {
      try {
        plan = await this._fetchPlan();
        break;
      } catch (e) {
        if (run !== this._run || !e || e.cancelled || e.name === 'AbortError') return;
        if (e.fatal || !retry.isTransientError(e) || attempt >= maxPlanTries) {
          return this._fail(e.fatal ? e.message : 'Stream failed: ' + e.message);
        }
        this._consecErrors = attempt;
        this.error = e.message;
        // The host gate already covers rate limits; a plain back-off covers
        // connection resets and 5xx responses.
        if (!e.rateLimited) await sleep(this._retryDelay(e));
        if (run !== this._run) return;
      }
    }
    if (run !== this._run) return;
    if (!this._destDir) this._destDir = this._computeDestDir();
    this.filename = streams.renameForStream(this.filename, plan.kind, plan);
    const tasks = this._buildStreamTasks(plan);
    this.stream.total = tasks.length;
    if (this.stream.index > tasks.length) this.stream.index = 0;
    try {
      const dir = this.destDir;
      fs.mkdirSync(dir, { recursive: true });
      this._dedupeName(dir);
      const fds = { main: null, video: null, audio: null };
      if (plan.kind === 'hls') {
        if (this.stream.index === 0) { try { fs.truncateSync(this.partPath, 0); } catch { /* new */ } }
        else if (!fs.existsSync(this.partPath)) this.stream.index = 0;
        fds.main = await fsp.open(this.partPath, 'a');
      } else {
        const videoTaskCount = tasks.filter((t) => t.out === 'video').length;
        const inAudio = this.stream.index >= videoTaskCount;
        if (this.stream.index === 0) { try { fs.truncateSync(this.partPath, 0); } catch { /* new */ } }
        if (!inAudio && this.stream.index > 0 && !fs.existsSync(this.partPath)) this.stream.index = 0;
        if (!inAudio) {
          try { fs.unlinkSync(this.audioPartPath); } catch { /* none */ }
        } else if (this.stream.index === videoTaskCount) {
          try { fs.truncateSync(this.audioPartPath, 0); } catch { /* new */ }
        }
        fds.video = await fsp.open(this.partPath, 'a');
        if (plan.audio) {
          fds.audio = await fsp.open(this.audioPartPath, 'a');
        } else if (inAudio) {
          this.stream.index = videoTaskCount;
        }
      }
      this._streamFds = fds;
      this._stop = false;
      this._samples = [];
      this.workers = 1;
      this.status = 'downloading';
      this.engine.markDirty();
      try {
        for (let i = this.stream.index; i < tasks.length; i++) {
          if (this._stop || run !== this._run || this.status !== 'downloading') break;
          const task = tasks[i];
          const buf = await this._fetchStreamPart(task);
          if (this._stop || run !== this._run || this.status !== 'downloading') break;
          const fd = fds[task.out];
          if (!fd) throw new Error('Output file closed');
          await fd.write(buf);
          this.stream.index = i + 1;
          this._sample(buf.length);
          this.engine.recordTraffic(buf.length);
          this.engine.markDirty();
          this.engine.saveSoon();
        }
      } finally {
        await this._closeStreamFds();
      }
      if (this._stop || run !== this._run || this.status !== 'downloading') return;
      if (this.stream.index >= tasks.length) await this._finalizeStream();
      else this._fail('Stream stalled before completion');
    } catch (e) {
      if (this._stop || run !== this._run || e.cancelled) return;
      if (isFatalDiskError(e)) e.fatal = true;
      this._fail(e.message);
    } finally {
      this.workers = 0;
    }
  }
}

module.exports = StreamMixin;