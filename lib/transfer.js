'use strict';
/*
 * HTTP transfer mechanics of a Download.
 *
 * Connection slots, the range request loop and the byte pump. The methods are
 * mixed into the Download class (see lib/download.js) and use "this" exactly
 * like the methods that live there.
 */
const { request, FatalError } = require('./httpget');
const streams = require('./streams');
const { nameFromHeaders } = require('./naming');
const { categoryFor } = require('./categories');
const { clampInt, isFatalDiskError } = require('./util');

const MAX_PLAYLIST = 10 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

class TransferMixin {
  async _acquireSlot() {
    const engine = this.engine;
    while (!engine.reserveConnection()) {
      if (this._stop) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      await sleep(80);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      engine.releaseConnection();
    };
  }

  /**
   * Open an HTTP request while holding a connection slot for the whole
   * transfer (response headers *and* body).
   */
  async _openRequest(target, opts) {
    const release = await this._acquireSlot();
    let req, res, url;
    try {
      ({ req, res, url } = await request(target, opts));
    } catch (e) {
      release();
      throw e;
    }
    const finish = () => { this._activeReqs.delete(req); release(); };
    if (typeof res.once === 'function') {
      res.once('end', finish);
      res.once('close', finish);
      res.once('error', finish);
    }
    if (typeof req.once === 'function') req.once('error', finish);
    this._activeReqs.add(req);
    return { req, res, url };
  }

  /** Fetch a complete body (playlist, key, media part) under a connection slot. */
  async _fetchBuffer(url, opts, hooks) {
    const release = await this._acquireSlot();
    const wrapped = {
      onReq: (req) => { if (hooks && hooks.onReq) hooks.onReq(req); },
      onDone: (req) => { release(); if (hooks && hooks.onDone) hooks.onDone(req); },
    };
    try {
      return await streams.fetchBuffer(url, opts, wrapped);
    } catch (e) {
      release();
      throw e;
    }
  }

  /** Fetch a playlist as text, refusing oversized payloads. */
  async _fetchText(url, opts) {
    const buf = await this._fetchBuffer(url, opts);
    if (buf.length > MAX_PLAYLIST) throw new Error('Playlist too large');
    return buf.toString('utf8');
  }

  _pump(res, seg, req, from, boundTotal) {
    const dbg = process.env.DLX_DEBUG;
    if (dbg) console.error(`  pump start from=${from} boundTotal=${boundTotal}`);
    return new Promise((resolve, reject) => {
      let pos = 0;
      let settled = false;
      /*
       * Node can emit several 'data' events in one tick (read() drains its
       * whole buffer), so chunks are pushed through a chain and handled one
       * after another. Without this the byte counter is updated by concurrent
       * handlers, which corrupts the segment and leaves the transfer in a
       * permanent "short read" retry loop.
       */
      let chain = Promise.resolve();

      const done = (err) => {
        if (settled) return;
        settled = true;
        this._activeReqs.delete(req);
        if (dbg) console.error(`  pump done pos=${pos} boundTotal=${boundTotal} err=${err ? err.message : 'ok'}`);
        if (err) reject(err); else resolve();
      };

      /* Run `fn` once every queued chunk has been processed. */
      const afterChain = (fn) => { chain.then(fn, fn); };

      const handle = async (chunkBuf) => {
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
      };

      res.on('data', (chunkBuf) => {
        res.pause();
        chain = chain.then(() => handle(chunkBuf)).catch((e) => {
          try { req.destroy(); } catch { /* already gone */ }
          if (isFatalDiskError(e)) { e.fatal = true; e.disk = true; }
          done(e);
        });
      });

      res.on('end', () => {
        afterChain(() => {
          if (settled) return;
          if (!res.complete) {
            return done(Object.assign(new Error('Connection closed early'), { shortRead: true }));
          }
          if (boundTotal && pos < boundTotal) {
            return done(Object.assign(new Error(`Short read: ${pos} of ${boundTotal} bytes`), { shortRead: true }));
          }
          if (!boundTotal) this._singleDone = true;
          done();
        });
      });

      res.on('error', (e) => afterChain(() => done(e)));
      res.on('aborted', () => afterChain(() => done(new Error('Connection aborted'))));
      res.on('close', () => {
        if (!res.complete && !settled) {
          afterChain(() => done(Object.assign(new Error('Connection closed early'), { shortRead: true })));
        }
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
    const { req, res } = await this._openRequest(this.urls[this._urlIdx] || this.urls[0], this._netOpts(headers));
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
    const { req, res } = await this._openRequest(this.urls[this._urlIdx] || this.urls[0], this._netOpts());
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
        const r = await this._openRequest(url, this._netOpts({ range: 'bytes=0-0', ...this._extraHeaders() }));
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
        const playlistKind = streams.detectPlaylist(res.headers, r.url);
        if (playlistKind) {
          res.destroy();
          const same = this.stream && this.stream.kind === playlistKind;
          this.stream = { kind: playlistKind, index: same ? this.stream.index : 0, total: same ? this.stream.total : 0 };
          this.category = (this.category === 'auto' || this.category === 'Others') ? 'Video' : this.category;
          this.resumable = false;
          this.total = 0;
          return;
        }
        if (st === 416) {
          const m = /bytes\s+\*\/(\d+)/i.exec(res.headers['content-range'] || '');
          res.resume();
          this.total = m ? parseInt(m[1], 10) : 0;
          this.resumable = true;
          return;
        }
        if (st === 206) {
          const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(res.headers['content-range'] || '');
          // The probe body is a single byte: drain it so the socket can be
          // reused instead of being torn down.
          res.resume();
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
}

module.exports = TransferMixin;
