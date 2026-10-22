// downloadX FTP support tests — local FTP server, no external network.
// The local test servers live on 127.0.0.1 - allow the private network in tests.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

// Run: node test/ftp.test.mjs
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Engine, categoryFor } = require('../lib/engine.js');
const { request } = require('../lib/httpget.js');
const { expandPatternDetailed } = require('../lib/patterns.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-ftp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function waitFor(fn, timeoutMs = 60000, interval = 100) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

async function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/* ---------------- local FTP test server ---------------- */
function startFtp(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const supportRest = options.supportRest !== false;
  const auth = options.auth || null;
  const chunkDelayMs = options.chunkDelayMs || 0;
  /* Send only this many bytes and then cut the data connection. */
  const cutAfterBytes = options.cutAfterBytes === undefined ? null : options.cutAfterBytes;
  const log = { cmds: [], rests: [], retrs: 0 };
  const server = net.createServer((sock) => {
    let authed = !auth;
    let user = '';
    let rest = 0;
    let dataServer = null;
    let dataConn = null;
    const dataWaiters = [];
    sock.setEncoding('latin1');
    sock.on('error', () => {});
    const send = (line) => { if (!sock.destroyed) sock.write(line + '\r\n'); };
    const waitData = (ms) => new Promise((resolve) => {
      if (dataConn) return resolve(dataConn);
      const t = setTimeout(() => resolve(null), ms);
      dataWaiters.push((c) => { clearTimeout(t); resolve(c); });
    });
    const cleanup = () => {
      if (dataConn) { try { dataConn.destroy(); } catch { /* gone */ } dataConn = null; }
      if (dataServer) { try { dataServer.close(); } catch { /* gone */ } dataServer = null; }
    };
    sock.on('close', cleanup);
    send('220 downloadX test FTP ready');
    let buf = '';
    sock.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line) continue;
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        log.cmds.push(cmd);
        try {
          if (cmd === 'USER') {
            user = arg;
            send(auth ? '331 password required' : '230 logged in');
          } else if (cmd === 'PASS') {
            if (auth && (user !== auth.user || arg !== auth.pass)) { send('530 login incorrect'); continue; }
            authed = true;
            send('230 logged in');
          } else if (cmd === 'FEAT') {
            send('211-Features:');
            if (supportRest) send(' REST STREAM');
            send(' SIZE');
            send(' MDTM');
            send('211 End');
          } else if (cmd === 'TYPE') {
            send('200 type ok');
          } else if (cmd === 'SIZE') {
            const f = files.get(arg);
            send(f ? '213 ' + f.length : '550 not found');
          } else if (cmd === 'MDTM') {
            const f = files.get(arg);
            send(f ? '213 20240102030405' : '550 not found');
          } else if (cmd === 'REST') {
            if (!supportRest) { send('502 REST not supported'); continue; }
            rest = parseInt(arg, 10) || 0;
            log.rests.push(rest);
            send('350 restart at ' + rest);
          } else if (cmd === 'PASV') {
            cleanup();
            dataServer = net.createServer((ds) => {
              ds.on('error', () => {});
              dataConn = ds;
              while (dataWaiters.length) dataWaiters.shift()(ds);
            });
            await new Promise((r) => dataServer.listen(0, '127.0.0.1', r));
            const p = dataServer.address().port;
            send(`227 Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255})`);
          } else if (cmd === 'RETR') {
            if (!authed) { send('530 not logged in'); continue; }
            const file = files.get(arg);
            if (!file) { send('550 file not found'); continue; }
            log.retrs++;
            const off = rest;
            rest = 0;
            send('150 opening data connection');
            const conn = await waitData(5000);
            if (!conn) { send('425 no data connection'); continue; }
            const slice = file.subarray(off);
            let cut = false;
            conn.on('close', () => { if (!cut) send('226 transfer complete'); });
            if (cutAfterBytes !== null) {
              cut = true;
              conn.write(slice.subarray(0, Math.min(cutAfterBytes, slice.length)));
              setTimeout(() => { try { conn.destroy(); } catch { /* gone */ } }, 20);
            } else if (chunkDelayMs && slice.length > 65536) {
              let pos = 0;
              const iv = setInterval(() => {
                if (conn.destroyed || pos >= slice.length) {
                  clearInterval(iv);
                  if (pos >= slice.length) conn.end();
                  return;
                }
                conn.write(slice.subarray(pos, pos + 32768));
                pos += 32768;
              }, chunkDelayMs);
            } else {
              conn.end(slice);
            }
          } else if (cmd === 'QUIT') {
            send('221 bye');
            sock.end();
          } else {
            send('502 not implemented');
          }
        } catch {
          send('451 internal error');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log }));
  });
}

const FILE = crypto.randomBytes(1024 * 1024 + 333);
const FILE_HASH = crypto.createHash('sha256').update(FILE).digest('hex');
const SMALL = Buffer.from('hello ftp world');

const ftp = await startFtp({ files: { '/file.bin': FILE, '/small.txt': SMALL, '/my file.bin': SMALL } });
const base = `ftp://127.0.0.1:${ftp.port}`;

/* ---------------- raw client behaviour ---------------- */
{
  const { res } = await request(`${base}/file.bin`, { headers: { range: 'bytes=1000-1999' } });
  check('ftp: ranged request returns 206', res.statusCode === 206, String(res.statusCode));
  check('ftp: content-range is exact', res.headers['content-range'] === `bytes 1000-1999/${FILE.length}`, res.headers['content-range']);
  check('ftp: accept-ranges advertised', res.headers['accept-ranges'] === 'bytes');
  const body = await collect(res);
  check('ftp: ranged bytes are byte-perfect', body.length === 1000 && body.equals(FILE.subarray(1000, 2000)));
  check('ftp: complete flag set on clean end', res.complete === true);
  check('ftp: REST offset reached the server', ftp.log.rests.includes(1000), ftp.log.rests.join(','));
}
{
  const { res } = await request(`${base}/small.txt`);
  check('ftp: full request returns 200', res.statusCode === 200);
  check('ftp: full content-length known', res.headers['content-length'] === String(SMALL.length));
  check('ftp: full body intact', (await collect(res)).equals(SMALL));
  check('ftp: last-modified from MDTM', res.headers['last-modified'] === new Date(Date.UTC(2024, 0, 2, 3, 4, 5)).toUTCString(), res.headers['last-modified']);
}
{
  const { res } = await request(`${base}/my%20file.bin`);
  check('ftp: percent-encoded path decoded', (await collect(res)).equals(SMALL));
}
{
  const c = await startFtp({ files: { '/a.bin': SMALL }, auth: { user: 'u', pass: 'p' } });
  const ok = await request(`ftp://u:p@127.0.0.1:${c.port}/a.bin`);
  check('ftp: user/password login works', ok.res.statusCode === 200 && (await collect(ok.res)).equals(SMALL));
  let failed = null;
  try { await request(`ftp://u:wrong@127.0.0.1:${c.port}/a.bin`); } catch (e) { failed = e; }
  check('ftp: bad password fails fatally', !!failed && failed.fatal === true && /530|login/i.test(failed.message), failed && failed.message);
  c.server.close();
}
{
  const c = await startFtp({ files: { '/a.bin': SMALL }, supportRest: false });
  const { res } = await request(`ftp://127.0.0.1:${c.port}/a.bin`, { headers: { range: 'bytes=100-199' } });
  check('ftp: no REST falls back to full stream', res.statusCode === 200 && res.headers['content-length'] === String(SMALL.length));
  check('ftp: no REST sends no REST command', c.log.rests.length === 0);
  await collect(res);
  c.server.close();
}
{
  let failed = null;
  try { await request(`${base}/file%0D%0ADELETE%20x`); } catch (e) { failed = e; }
  check('ftp: control characters in path rejected', !!failed && /Illegal control characters/.test(failed.message), failed && failed.message);
}
{
  let failed = null;
  try {
    const r = await request(`${base}/missing.bin`);
    await collect(r.res);
  } catch (e) { failed = e; }
  check('ftp: missing file is a fatal error', !!failed && failed.fatal === true && /550|unavailable/i.test(failed.message), failed && failed.message);
}

/* ---------------- engine: segmented FTP download ---------------- */
{
  const engine = new Engine(path.join(TMP, 'engine-ftp'));
  engine.settings.rootDir = path.join(TMP, 'files-ftp');
  engine.settings.maxConcurrent = 4;
  const before = ftp.log.retrs;
  const d = engine.add({ urls: [`${base}/file.bin`], segments: 4 });
  const done = await waitFor(() => {
    const it = engine.get(d.id);
    return ['completed', 'failed'].includes(it.status) ? it : null;
  }, 90000);
  check('engine+ftp: segmented download completes', done.status === 'completed', done.error);
  check('engine+ftp: byte count exact', done.received === FILE.length, `${done.received}/${FILE.length}`);
  check('engine+ftp: content byte-perfect', (await hashFile(done.finalPath)) === FILE_HASH);
  check('engine+ftp: used ranged REST fetches', ftp.log.rests.length >= 1, `${ftp.log.rests.length} RESTs`);
  check('engine+ftp: used multiple connections', ftp.log.retrs - before >= 2, `${ftp.log.retrs - before} RETRs`);
  check('engine+ftp: reports resumable', done.resumable === true);
  check('engine+ftp: filename from URL', done.filename === 'file.bin', done.filename);
  check('engine+ftp: category detected', done.category === 'Others', done.category);
  engine.close();
}
{
  const c = await startFtp({ files: { '/plain.bin': FILE }, supportRest: false });
  const engine = new Engine(path.join(TMP, 'engine-norest'));
  engine.settings.rootDir = path.join(TMP, 'files-norest');
  const d = engine.add({ urls: [`ftp://127.0.0.1:${c.port}/plain.bin`], segments: 8 });
  const done = await waitFor(() => {
    const it = engine.get(d.id);
    return ['completed', 'failed'].includes(it.status) ? it : null;
  }, 90000);
  check('engine+ftp: streaming fallback completes', done.status === 'completed', done.error);
  check('engine+ftp: streaming fallback is byte-perfect', (await hashFile(done.finalPath)) === FILE_HASH);
  check('engine+ftp: no-REST reports non-resumable', done.resumable === false);
  engine.close();
  c.server.close();
}
{
  const engine = new Engine(path.join(TMP, 'engine-missing'));
  engine.settings.rootDir = path.join(TMP, 'files-missing');
  const d = engine.add({ urls: [`${base}/nope.bin`] });
  const done = await waitFor(() => {
    const it = engine.get(d.id);
    return ['completed', 'failed'].includes(it.status) ? it : null;
  }, 60000);
  check('engine+ftp: missing file marks failed', done.status === 'failed' && /550|unavailable/i.test(done.error), done.error);
  engine.close();
}
{
  const engine = new Engine(path.join(TMP, 'engine-auth'));
  engine.settings.rootDir = path.join(TMP, 'files-auth');
  let err = null;
  try { engine.add({ urls: ['magnet:?xt=urn:btih:deadbeef'] }); } catch (e) { err = e; }
  check('engine: torrent/magnet URLs rejected', !!err && /supported/i.test(err.message), err && err.message);
  const d = engine.add({ urls: [`ftp://127.0.0.1:${ftp.port}/small.txt`] });
  check('engine: ftp URL accepted', !!d && d.urls[0].startsWith('ftp://'));
  engine.close();
}

/* ---------------- the data connection dies in the middle ---------------- */
{
  // The server accepts the transfer but never delivers a byte.
  const cutFtp = await startFtp({ files: { '/file.bin': FILE }, cutAfterBytes: 0 });
  const engine = new Engine(path.join(TMP, 'engine-cut'));
  engine.settings.rootDir = path.join(TMP, 'files-cut');
  engine.settings.maxRetries = 2;
  const d = engine.add({ urls: [`ftp://127.0.0.1:${cutFtp.port}/file.bin`], segments: 1 });
  const done = await waitFor(() => {
    const it = engine.get(d.id);
    return ['completed', 'failed'].includes(it.status) ? it : null;
  }, 60000);
  check('engine+ftp: a data connection without data fails cleanly', done.status === 'failed', done.status);
  check('engine+ftp: the failure is reported', !!done.error && done.error.length > 0, done.error);
  check('engine+ftp: no corrupt file is left behind', !fs.existsSync(done.finalPath));
  engine.close();
  cutFtp.server.close();
}

/* ---------------- file-type coverage ---------------- */
{
  check('types: installer', categoryFor('', 'setup.exe') === 'Programs');
  check('types: android', categoryFor('', 'app.apk') === 'Programs');
  check('types: video container', categoryFor('', 'clip.mkv') === 'Video');
  check('types: streaming video', categoryFor('', 'show.s01e01.m2ts') === 'Video');
  check('types: audio', categoryFor('', 'song.flac') === 'Music');
  check('types: e-book', categoryFor('', 'book.mobi') === 'Documents');
  check('types: subtitle', categoryFor('', 'movie.en.srt') === 'Documents');
  check('types: raw photo', categoryFor('', 'shot.cr2') === 'Images');
  check('types: modern archive', categoryFor('', 'pack.zst') === 'Compressed');
  check('types: disk image', categoryFor('', 'disc.iso') === 'Compressed');
  check('types: extension package', categoryFor('', 'addon.crx') === 'Programs');
  check('mime: epub', categoryFor('application/epub+zip', 'unknown.xyz') === 'Documents');
  check('mime: plain text', categoryFor('text/plain', 'unknown.xyz') === 'Documents');
  check('mime: octet-stream stays Others', categoryFor('application/octet-stream', 'unknown.xyz') === 'Others');
  const expansion = expandPatternDetailed(`ftp://x/f[1-2].bin`);
  check('patterns: ftp URLs expand', expansion.urls.length === 2 && expansion.errors.length === 0, JSON.stringify(expansion.errors));
}

try { ftp.server.close(); } catch { /* done */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
