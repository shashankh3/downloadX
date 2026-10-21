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
const streams = require('./streams');
const { FatalError } = require('./httpget');
const { sleep, isFatalDiskError } = require('./util');

class StreamMixin {
  async _fetchPlan() {
    const startUrl = this.finalUrl || this.urls[0];
    const body = await this._fetchText(startUrl, this._netOpts());
    if (this.stream.kind === 'hls') {
      let parsed = streams.parseM3u8(body, startUrl);
      if (parsed.kind === 'master') {
        if (!parsed.variants.length) throw new FatalError('Empty HLS master playlist');
        const variantUrl = parsed.variants[0].url;
        const mediaBody = await this._fetchText(variantUrl, this._netOpts());
        parsed = streams.parseM3u8(mediaBody, variantUrl);
        if (parsed.kind !== 'media') throw new FatalError('HLS master points to another master playlist');
      }
      if (!parsed.segments.length) throw new FatalError('HLS playlist has no segments');
      return { kind: 'hls', map: parsed.map, segments: parsed.segments };
    }
    const mpd = streams.parseMpd(body, startUrl);
    if (!mpd.video && !mpd.audio) throw new FatalError('DASH manifest has no playable streams');
    return { kind: 'dash', video: mpd.video, audio: mpd.audio };
  }

  _buildStreamTasks(plan) {
    const tasks = [];
    const addUnit = (unit, out) => {
      if (!unit) return;
      if (unit.init) tasks.push({ url: unit.init, init: true, out });
      for (const s of unit.segments) {
        tasks.push({ url: s.url, key: s.key || null, byterange: s.byterange || null, seq: s.seq, out });
      }
    };
    if (plan.kind === 'hls') addUnit({ init: plan.map, segments: plan.segments }, 'main');
    else {
      addUnit(plan.video, 'video');
      addUnit(plan.audio, 'audio');
    }
    return tasks;
  }

  async _fetchKey(url) {
    if (this._keys.has(url)) return this._keys.get(url);
    const hooks = {
      onReq: (req) => this._activeReqs.add(req),
      onDone: (req) => this._activeReqs.delete(req),
    };
    const buf = await this._fetchBuffer(url, this._netOpts(), hooks);
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
        let buf = await this._fetchBuffer(task.url, this._netOpts(headers), hooks);
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
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
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
    const hasAudio = this.stream.kind === 'dash' && fs.existsSync(this.audioPartPath);
    try {
      fs.renameSync(this.partPath, this.finalPath);
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
        this._dedupeFinalName();
        fs.renameSync(this.partPath, this.finalPath);
      } else throw e;
    }
    if (hasAudio) {
      try { fs.renameSync(this.audioPartPath, this.audioPath); } catch { /* ignore */ }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1;
    this.engine.markDirty();
    this.engine.saveSoon();
  }

  async _startStream(run) {
    let plan;
    try {
      plan = await this._fetchPlan();
    } catch (e) {
      if (this._stop || run !== this._run || e.cancelled) return;
      return this._fail(e.fatal ? e.message : 'Stream failed: ' + e.message);
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
