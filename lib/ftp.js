'use strict';
/**
 * Zero-dependency FTP / FTPS client with an httpget-compatible request() contract.
 *
 * Supports: USER/PASS (anonymous fallback), TYPE I, FEAT (SIZE / MDTM / REST STREAM),
 * PASV with EPSV fallback, byte ranges via REST (enables segmented downloads) and
 * explicit TLS (ftps:// via AUTH TLS + PBSZ 0 + PROT P).
 *
 * Resolves { req, res, url } like the HTTP client:
 *   res.statusCode  206 when the offset was honoured (REST), 200 otherwise
 *   res.headers     content-length / content-range / accept-ranges / last-modified / content-type
 *   res             paused-capable readable (data / end / error / close), .complete flag
 *   req.destroy()   aborts the transfer (control + data sockets)
 */
const net = require('net');
const tls = require('tls');
const { PassThrough } = require('stream');

const DEFAULT_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;

const MIME_BY_EXT = {
  txt: 'text/plain', html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv',
  js: 'text/javascript', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', xz: 'application/x-xz', zst: 'application/zstd',
  exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msdownload',
  apk: 'application/vnd.android.package-archive', dmg: 'application/x-apple-diskimage',
  deb: 'application/vnd.debian.binary-package', rpm: 'application/x-rpm', iso: 'application/x-iso9660-image',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav',
  ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', ts: 'video/mp2t',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  avif: 'image/avif', heic: 'image/heic', epub: 'application/epub+zip',
};

function mimeForPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || 'application/octet-stream';
}

function fatalError(msg) {
  const e = new Error(msg);
  e.fatal = true;
  return e;
}

function abortError() {
  const e = new Error('Aborted');
  e.code = 'ABORT_ERR';
  e.name = 'AbortError';
  return e;
}

function assertNoControlChars(value) {
  if (/[\r\n\0]/.test(value)) throw fatalError('Illegal control characters in FTP URL');
  return value;
}

function friendlyHost(host) {
  return host.replace(/^\[|\]$/g, '');
}

function isPrivateHost(host) {
  const h = friendlyHost(host || '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function connectSocket(host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const cleanup = () => {
      sock.removeListener('connect', onConnect);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      sock.destroy();
      reject(e);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      sock.setTimeout(0);
      resolve(sock);
    };
    const onAbort = () => fail(abortError());
    sock.setTimeout(timeoutMs, () => fail(new Error('FTP connect timed out')));
    sock.once('error', fail);
    sock.once('connect', onConnect);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
  });
}

function upgradeSocket(sock, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      socket: sock,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    }, () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once('error', reject);
    s.setTimeout(timeoutMs, () => s.destroy(new Error('FTP TLS handshake timed out')));
  });
}

class Control {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.pending = [];
    this.waiters = [];
    this.closed = false;
    this.failure = null;
    this._onData = (d) => this._data(d);
    this._onClose = () => this._close();
    socket.on('data', this._onData);
    socket.on('close', this._onClose);
    socket.on('error', this._onClose);
  }

  _data(d) {
    this.buf += d.toString('latin1');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.pending.push(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    this._pump();
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    this._pump();
  }

  _tryFinish(waiter) {
    for (;;) {
      if (!this.pending.length) return false;
      const first = this.pending[0];
      const m = /^(\d{3})([ -])/.exec(first);
      if (!m) { this.pending.shift(); continue; }
      if (m[2] === ' ') {
        this.pending.shift();
        waiter.result = { code: parseInt(m[1], 10), text: first };
        return true;
      }
      for (let i = 1; i < this.pending.length; i++) {
        if (this.pending[i].startsWith(m[1] + ' ')) {
          const lines = this.pending.splice(0, i + 1);
          waiter.result = { code: parseInt(m[1], 10), text: lines.join('\n') };
          return true;
        }
      }
      return false;
    }
  }

  _pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (!this.closed && this._tryFinish(w)) {
        this.waiters.shift();
        clearTimeout(w.timer);
        w.resolve(w.result);
        continue;
      }
      break;
    }
    if (this.closed) {
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(this.failure || new Error('FTP connection closed'));
      }
    }
  }

  readReply(timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        reject,
        result: null,
        timer: setTimeout(() => {
          this.failure = new Error('FTP command timed out');
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(this.failure);
          this.destroy();
        }, timeoutMs || this.timeoutMs),
      };
      this.waiters.push(w);
      this._pump();
    });
  }

  send(line) {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(this.failure || new Error('FTP connection closed'));
      this.socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async cmd(line, timeoutMs) {
    await this.send(line);
    return this.readReply(timeoutMs);
  }

  detach() {
    this.closed = true;
    this.socket.removeListener('data', this._onData);
    this.socket.removeListener('close', this._onClose);
    this.socket.removeListener('error', this._onClose);
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('FTP connection upgraded'));
    }
  }

  destroy() {
    this.closed = true;
    try { this.socket.destroy(); } catch { /* gone */ }
  }
}

class Session {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.restSupported = false;
    this.passiveHost = null;
  }

  dig(reply, prefix) {
    return reply.text.split('\n').some((l) => l.startsWith(prefix));
  }

  async login(user, pass) {
    let r = await this.ctrl.cmd('USER ' + user);
    if (r.code === 331 || r.code === 332) r = await this.ctrl.cmd('PASS ' + pass);
    if (r.code === 530) throw fatalError('FTP login failed (530): ' + r.text);
    if (r.code >= 400) throw new Error('FTP login failed (' + r.code + '): ' + r.text.split('\n').pop());
    const t = await this.ctrl.cmd('TYPE I');
    if (t.code >= 400) throw new Error('FTP TYPE I failed (' + t.code + ')');
  }

  async upgradeTls(host, timeoutMs) {
    const r = await this.ctrl.cmd('AUTH TLS');
    if (r.code !== 234) throw new Error('FTP server refused AUTH TLS (' + r.code + ')');
    const plain = this.ctrl.socket;
    this.ctrl.detach();
    const secure = await upgradeSocket(plain, host, timeoutMs);
    secure.on('error', () => { /* handled by Control close */ });
    this.ctrl = new Control(secure, timeoutMs);
    let p = await this.ctrl.cmd('PBSZ 0');
    if (p.code !== 200) throw new Error('FTP PBSZ failed (' + p.code + ')');
    p = await this.ctrl.cmd('PROT P');
    if (p.code !== 200) throw new Error('FTP PROT P failed (' + p.code + ')');
  }

  async feat() {
    const r = await this.ctrl.cmd('FEAT');
    if (r.code !== 211) return { rest: false, size: false, mdtm: false };
    return {
      rest: this.dig(r, ' REST STREAM'),
      size: this.dig(r, ' SIZE'),
      mdtm: this.dig(r, ' MDTM'),
    };
  }

  async size(path) {
    const r = await this.ctrl.cmd('SIZE ' + path);
    if (r.code !== 213) return null;
    const n = parseInt(r.text.split('\n').pop().replace(/^213\s*/, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  async mdtm(path) {
    const r = await this.ctrl.cmd('MDTM ' + path);
    if (r.code !== 213) return '';
    const m = /^213\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(r.text.split('\n').pop().trim());
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return Number.isFinite(d.getTime()) ? d.toUTCString() : '';
  }

  async rest(offset) {
    const r = await this.ctrl.cmd('REST ' + offset);
    return r.code === 350;
  }

  async pasv(controlHost) {
    let r = await this.ctrl.cmd('PASV');
    let m = r.code === 227 ? /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(r.text) : null;
    if (m) {
      const host = m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4];
      const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
      if (port > 0) {
        const bogus = host === '0.0.0.0' || (isPrivateHost(host) && !isPrivateHost(controlHost));
        this.passiveHost = bogus ? controlHost : host;
        return { host: this.passiveHost, port };
      }
    }
    r = await this.ctrl.cmd('EPSV');
    m = r.code === 229 ? /\(\|\|\|(\d+)\|\)/.exec(r.text) : null;
    if (m) {
      const port = parseInt(m[1], 10);
      if (port > 0) {
        this.passiveHost = controlHost;
        return { host: controlHost, port };
      }
    }
    throw new Error('FTP server refused PASV/EPSV');
  }

  async retr(path) {
    const r = await this.ctrl.cmd('RETR ' + path);
    if (r.code === 550) throw fatalError('FTP: ' + r.text.split('\n').pop().replace(/^550\s*/, 'file unavailable: '));
    if (r.code !== 150 && r.code !== 125) {
      throw new Error('FTP RETR failed (' + r.code + '): ' + r.text.split('\n').pop());
    }
  }

  async waitTransferDone(timeoutMs) {
    const r = await this.ctrl.readReply(timeoutMs || 20000);
    if (r.code >= 400) return { ok: false, code: r.code, text: r.text.split('\n').pop() };
    return { ok: true, code: r.code };
  }

  destroy() {
    try { this.ctrl.socket.write('QUIT\r\n'); } catch { /* gone */ }
    this.ctrl.destroy();
  }
}

async function ftpRequest(urlStr, opts = {}) {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid URL: ' + urlStr); }
  const secure = u.protocol === 'ftps:';
  const host = friendlyHost(u.hostname);
  const port = parseInt(u.port, 10) || 21;
  let path;
  try { path = decodeURIComponent(u.pathname || '/'); } catch { path = u.pathname || '/'; }
  let user, pass;
  try { user = u.username ? decodeURIComponent(u.username) : 'anonymous'; } catch { user = u.username || 'anonymous'; }
  try { pass = u.password ? decodeURIComponent(u.password) : (u.username ? '' : 'anonymous@'); } catch { pass = u.password || ''; }
  assertNoControlChars(path);
  assertNoControlChars(user);
  assertNoControlChars(pass);

  const ctrlSock = await connectSocket(host, port, Math.min(timeoutMs, CONNECT_TIMEOUT_MS), signal);
  const session = new Session(new Control(ctrlSock, timeoutMs));
  let dataSock = null;
  try {
    const greet = await session.ctrl.readReply(timeoutMs);
    if (greet.code < 200 || greet.code >= 400) throw new Error('FTP server refused connection (' + greet.code + ')');
    if (secure) await session.upgradeTls(host, timeoutMs);
    await session.login(user, pass);

    const feat = await session.feat().catch(() => ({ rest: false, size: false, mdtm: false }));
    const size = await session.size(path).catch(() => null);
    const lastModified = feat.mdtm ? await session.mdtm(path).catch(() => '') : '';

    const rm = /bytes=(\d+)-(\d*)/.exec(String(headers.range || ''));
    let from = rm ? parseInt(rm[1], 10) : 0;
    let end = rm && rm[2] ? parseInt(rm[2], 10) : null;
    let ranged = false;
    if (rm && feat.rest && size != null && size > 0 && from >= 0) {
      ranged = true;
      if (from > 0) {
        const ok = await session.rest(from).catch(() => false);
        if (!ok) { ranged = false; from = 0; end = rm[2] ? parseInt(rm[2], 10) : null; }
      }
    } else {
      from = 0;
      end = null;
    }
    if (from > 0 && size != null && from >= size) throw fatalError('FTP range not satisfiable');

    const data = await session.pasv(host);
    dataSock = await connectSocket(data.host, data.port, Math.min(timeoutMs, CONNECT_TIMEOUT_MS), signal);
    if (secure) dataSock = await upgradeSocket(dataSock, data.host, timeoutMs);
    await session.retr(path);

    const rangeEnd = ranged && size != null ? (end != null ? Math.min(end, size - 1) : size - 1) : null;
    const deliverLimit = ranged && rangeEnd != null ? rangeEnd - from + 1 : null;
    const res = new PassThrough();
    res.statusCode = ranged ? 206 : 200;
    res.headers = Object.assign(
      { 'content-type': mimeForPath(path) },
      size != null && !ranged ? { 'content-length': String(size) } : {},
      deliverLimit != null ? { 'content-length': String(deliverLimit) } : {},
      ranged && size != null ? { 'content-range': `bytes ${from}-${rangeEnd}/${size}` } : {},
      feat.rest && size != null ? { 'accept-ranges': 'bytes' } : {},
      lastModified ? { 'last-modified': lastModified } : {}
    );
    res.complete = false;

    let finished = false;
    let delivered = 0;
    const cleanup = () => {
      if (dataSock) { try { dataSock.destroy(); } catch { /* gone */ } }
      session.destroy();
    };
    const req = {
      destroy() {
        if (finished) return;
        finished = true;
        cleanup();
        try { res.destroy(); } catch { /* gone */ }
      },
    };

    dataSock.on('data', (buf) => {
      if (finished) return;
      if (deliverLimit != null && delivered + buf.length > deliverLimit) {
        buf = buf.subarray(0, deliverLimit - delivered);
      }
      delivered += buf.length;
      const keep = res.write(buf);
      if (deliverLimit != null && delivered >= deliverLimit) {
        finished = true;
        res.complete = true;
        cleanup();
        res.end();
        return;
      }
      if (!keep) {
        dataSock.pause();
        res.once('drain', () => { if (!finished) dataSock.resume(); });
      }
    });
    dataSock.on('end', async () => {
      if (finished) return;
      finished = true;
      res.complete = true;
      const tr = await session.waitTransferDone().catch(() => ({ ok: true }));
      cleanup();
      if (!tr.ok && tr.code !== 426 && tr.code !== 451) {
        res.destroy(new Error('FTP transfer failed (' + tr.code + '): ' + tr.text));
        return;
      }
      res.end();
    });
    dataSock.on('error', (e) => {
      if (finished) return;
      finished = true;
      cleanup();
      res.destroy(e);
    });
    dataSock.setTimeout(timeoutMs, () => {
      if (finished) return;
      finished = true;
      cleanup();
      res.destroy(new Error('FTP data connection timed out'));
    });
    res.on('close', () => {
      if (!finished) {
        finished = true;
        cleanup();
      }
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        throw abortError();
      }
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    return { req, res, url: u.toString() };
  } catch (e) {
    if (dataSock) { try { dataSock.destroy(); } catch { /* gone */ } }
    session.destroy();
    throw e;
  }
}

module.exports = { request: ftpRequest, Control, Session };
