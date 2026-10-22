// HLS + DASH media capture tests: playlists, AES-128, byte ranges, fMP4 init maps,
// DASH templates/timelines, pause/resume of stream downloads. Fully local.
// The local test servers live on 127.0.0.1 - allow the private network in tests.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

// Run: node test/streams.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { Engine } = require('../lib/engine.js');
const streams = require('../lib/streams.js');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-streams-'));
let seq = 0;
function makeEngine() {
  const dir = path.join(TMP, 'engine-' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  const engine = new Engine(dir);
  engine.settings.rootDir = path.join(dir, 'out');
  engine.settings.organizeByCategory = false;
  engine.settings.maxConcurrent = 3;
  return engine;
}

function waitFor(fn, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function runDownload(engine, url) {
  const d = engine.add({ urls: [url] });
  await waitFor(() => ['completed', 'failed', 'canceled'].includes(d.status));
  return d;
}

/* ---------------- fixtures ---------------- */

const tsSeg = (n, size = 2048) => {
  const b = Buffer.alloc(size, n & 0xff);
  b[0] = 0x47;
  return b;
};
const highSegs = [tsSeg(1), tsSeg(2), tsSeg(3), tsSeg(4), tsSeg(5)];
const lowSegs = [tsSeg(9)];

const KEY = crypto.randomBytes(16);
const explicitIv = crypto.randomBytes(16);
const encPlain = [crypto.randomBytes(1000), crypto.randomBytes(1000), crypto.randomBytes(1000)];
const ivForSeq = (s) => {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(s >>> 0, 12);
  return b;
};
const encCipher = [
  (() => { const c = crypto.createCipheriv('aes-128-cbc', KEY, explicitIv); return Buffer.concat([c.update(encPlain[0]), c.final()]); })(),
  (() => { const c = crypto.createCipheriv('aes-128-cbc', KEY, ivForSeq(8)); return Buffer.concat([c.update(encPlain[1]), c.final()]); })(),
  (() => { const c = crypto.createCipheriv('aes-128-cbc', KEY, ivForSeq(9)); return Buffer.concat([c.update(encPlain[2]), c.final()]); })(),
];

/* A plaintext whose last byte looks like a PKCS#7 padding length: it must not
   be truncated by the unpadder. */
const padIv = crypto.randomBytes(16);
const padPlain = Buffer.alloc(1000, 0xab);
padPlain[padPlain.length - 1] = 0x05;
const padCipher = (() => {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, padIv);
  return Buffer.concat([c.update(padPlain), c.final()]);
})();

const fmp4Init = Buffer.concat([Buffer.from('FMP4INIT'), Buffer.alloc(120, 7)]);
const fmp4Segs = [Buffer.from('FMP4SEG0'), Buffer.from('FMP4SEG1'), Buffer.from('FMP4SEG2')];

const rangeSegs = [tsSeg(21), tsSeg(22), tsSeg(23)];
const rangeFile = Buffer.concat(rangeSegs);

const slowSegs = Array.from({ length: 8 }, (_, i) => tsSeg(40 + i, 512));

const dashInitV = Buffer.from('DASH-VIDEO-INIT');
const dashV = ['DASHV1', 'DASHV2', 'DASHV3', 'DASHV4', 'DASHV5'].map((s) => Buffer.from(s));
const dashInitA = Buffer.from('DASH-AUDIO-INIT');
const dashA = [Buffer.from('DASHA1'), Buffer.from('DASHA2')];

/* A playlist that switches its initialisation section halfway through. */
const mapChangeInit = Buffer.from('FMP4-INIT-2');
const mapChangeSegs = [Buffer.from('MAPSEG0'), Buffer.from('MAPSEG1')];

const slowDelayMs = 150;

function buildRoutes() {
  const routes = new Map();
  const add = (p, buf, type = 'application/octet-stream', delay = 0) => routes.set(p, { buf, type, delay });
  routes.set('/key.bin', { buf: KEY, type: 'application/octet-stream', delay: 0, countKey: true });

  add('/master.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1920x1080',
    'high/index.m3u8',
  ].join('\n')), 'application/vnd.apple.mpegurl');

  const media = (urls, extra = []) => Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    ...extra,
    ...urls.flatMap((u) => ['#EXTINF:4.0,', u]),
    '#EXT-X-ENDLIST',
  ].join('\n'));

  add('/low/index.m3u8', media(['s0.ts']), 'application/vnd.apple.mpegurl');
  add('/low/s0.ts', lowSegs[0]);
  add('/high/index.m3u8', media(highSegs.map((_, i) => `s${i}.ts`)), 'application/vnd.apple.mpegurl');
  highSegs.forEach((b, i) => add(`/high/s${i}.ts`, b));

  add('/enc/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:7',
    `#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${explicitIv.toString('hex')}`,
    '#EXTINF:4.0,',
    'e0.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"',
    '#EXTINF:4.0,',
    'e1.ts',
    '#EXTINF:4.0,',
    'e2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  encCipher.forEach((b, i) => add(`/enc/e${i}.ts`, b));

  add('/pad/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${padIv.toString('hex')}`,
    '#EXTINF:4.0,',
    'p0.ts',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  add('/pad/p0.ts', padCipher);

  add('/fmp4/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="/fmp4/init.mp4"',
    '#EXTINF:4.0,',
    'seg0.m4s',
    '#EXTINF:4.0,',
    'seg1.m4s',
    '#EXTINF:4.0,',
    'seg2.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  add('/fmp4/init.mp4', fmp4Init);
  fmp4Segs.forEach((b, i) => add(`/fmp4/seg${i}.m4s`, b));

  add('/mapchange/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'm0.m4s',
    '#EXT-X-MAP:URI="/mapchange/init.mp4"',
    '#EXTINF:4.0,',
    'm1.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  add('/mapchange/init.mp4', mapChangeInit);
  mapChangeSegs.forEach((b, i) => add(`/mapchange/m${i}.m4s`, b));

  add('/mapchange/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'm0.m4s',
    '#EXT-X-MAP:URI="/mapchange/init.mp4"',
    '#EXTINF:4.0,',
    'm1.m4s',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  add('/mapchange/init.mp4', mapChangeInit);
  mapChangeSegs.forEach((b, i) => add(`/mapchange/m${i}.m4s`, b));

  add('/range/index.m3u8', Buffer.from([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-BYTERANGE:${rangeSegs[0].length}@0`,
    '#EXTINF:4.0,',
    'all.ts',
    `#EXT-X-BYTERANGE:${rangeSegs[1].length}`,
    '#EXTINF:4.0,',
    'all.ts',
    `#EXT-X-BYTERANGE:${rangeSegs[2].length}`,
    '#EXTINF:4.0,',
    'all.ts',
    '#EXT-X-ENDLIST',
  ].join('\n')), 'application/vnd.apple.mpegurl');
  add('/range/all.ts', rangeFile);

  add('/slow/index.m3u8', media(slowSegs.map((_, i) => `s${i}.ts`)), 'application/vnd.apple.mpegurl');
  slowSegs.forEach((b, i) => add(`/slow/s${i}.ts`, b, 'application/octet-stream', slowDelayMs));

  const mpd = [
    '<?xml version="1.0"?>',
    '<MPD mediaPresentationDuration="PT20S">',
    '  <Period duration="PT10S">',
    '    <BaseURL>dash/</BaseURL>',
    '    <AdaptationSet mimeType="video/mp4">',
    '      <Representation id="v1" bandwidth="1000000" width="1920" height="1080">',
    '        <SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="init-v.mp4" media="v$Number$.m4s"/>',
    '      </Representation>',
    '      <Representation id="v0" bandwidth="100000" width="640" height="360">',
    '        <SegmentTemplate timescale="1" duration="2" startNumber="1" initialization="init-v.mp4" media="v$Number$.m4s"/>',
    '      </Representation>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4">',
    '      <Representation id="a1" bandwidth="128000">',
    '        <SegmentTemplate startNumber="1" initialization="init-a.mp4" media="a$Number$.m4s">',
    '          <SegmentTimeline><S t="0" d="2" r="1"/></SegmentTimeline>',
    '        </SegmentTemplate>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
  ].join('\n');
  add('/stream.mpd', Buffer.from(mpd), 'application/dash+xml');
  add('/dash/init-v.mp4', dashInitV);
  dashV.forEach((b, i) => add(`/dash/v${i + 1}.m4s`, b));
  add('/dash/init-a.mp4', dashInitA);
  dashA.forEach((b, i) => add(`/dash/a${i + 1}.m4s`, b));
  return routes;
}

function startServer(routes) {
  const keyHits = { count: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const route = routes.get(p);
    if (!route) { res.writeHead(404); return res.end(); }
    if (route.countKey) keyHits.count++;
    const send = () => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (m) {
        const start = parseInt(m[1], 10);
        const end = Math.min(parseInt(m[2], 10), route.buf.length - 1);
        const slice = route.buf.subarray(start, end + 1);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${route.buf.length}`,
          'content-length': slice.length,
          'content-type': route.type,
        });
        return res.end(slice);
      }
      res.writeHead(200, { 'content-length': route.buf.length, 'content-type': route.type });
      res.end(route.buf);
    };
    if (route.delay) setTimeout(send, route.delay);
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, keyHits })));
}

/* ---------------- unit: playlist parsing ---------------- */
{
  const master = streams.parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n', 'http://x.tv/master.m3u8');
  check('parse: master variants sorted by bandwidth', master.kind === 'master' && master.variants[0].url === 'http://x.tv/high.m3u8');
  check('detect: m3u8 url', streams.detectPlaylist({}, 'http://x.tv/a/b.m3u8') === 'hls');
  check('detect: mpegurl content-type', streams.detectPlaylist({ 'content-type': 'application/vnd.apple.mpegurl' }, 'http://x.tv/x') === 'hls');
  check('detect: mpd url', streams.detectPlaylist({ 'content-type': 'application/dash+xml' }, 'http://x.tv/x') === 'dash');
  check('rename: m3u8 TS playlist becomes .ts', streams.renameForStream('movie.m3u8', 'hls', { segments: [{ url: 'a.ts' }] }) === 'movie.ts');
  check('rename: m3u8 fMP4 playlist becomes .mp4', streams.renameForStream('movie.m3u8', 'hls', { segments: [{ url: 'a.m4s' }] }) === 'movie.mp4');
  const listMpd = streams.parseMpd('<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="r" bandwidth="5"><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>', 'http://x.tv/d.mpd');
  check('parse mpd: SegmentList', listMpd.video && listMpd.video.init === 'http://x.tv/i.mp4' && listMpd.video.segments.length === 2, JSON.stringify(listMpd.video && listMpd.video.segments));
}

/* ---------------- HLS master -> best variant ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/master.m3u8`);
  check('hls: master download completes', d.status === 'completed', d.error || d.status);
  check('hls: output renamed to .ts', d.filename === 'master.ts', d.filename);
  check('hls: snapshot marks stream', d.snapshot().stream === 'hls');
  check('hls: segment count in snapshot', d.snapshot().total === 5 && d.snapshot().received === 5, `${d.snapshot().received}/${d.snapshot().total}`);
  check('hls: picks highest bandwidth variant', fs.readFileSync(d.finalPath).equals(Buffer.concat(highSegs)));
  check('hls: category is Video', d.snapshot().category === 'Video');
  const variants = d.snapshot().variants || [];
  check('hls: the available qualities are listed', variants.length === 2, JSON.stringify(variants.map((v) => v.bandwidth)));
  check('hls: the best quality comes first', variants[0] && variants[0].bandwidth === 500000, JSON.stringify(variants[0]));
  check('hls: a quality has a readable label', variants[0] && /1920x1080/.test(variants[0].label), variants[0] && variants[0].label);
  engine.close();
  srv.server.close();
}

/* ---------------- switching the quality ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/master.m3u8`);
  check('hls: the first quality is downloaded', fs.readFileSync(d.finalPath).equals(Buffer.concat(highSegs)));
  // Pick the other quality, exactly like the API does.
  d.variantIndex = 1;
  try { fs.unlinkSync(d.finalPath); } catch { /* none */ }
  await d.restart();
  const done = await waitFor(() => ['completed', 'failed'].includes(d.status) ? d : null, 60000);
  check('hls: the chosen quality is downloaded', done.status === 'completed', done.error);
  check('hls: the lower quality has its own content',
    fs.readFileSync(done.finalPath).equals(Buffer.concat(lowSegs)));
  engine.close();
  srv.server.close();
}

/* ---------------- HLS AES-128 ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/enc/index.m3u8`);
  check('aes: encrypted download completes', d.status === 'completed', d.error || d.status);
  check('aes: decrypted content byte-perfect', fs.readFileSync(d.finalPath).equals(Buffer.concat(encPlain)));
  check('aes: key fetched only once', srv.keyHits.count === 1, `${srv.keyHits.count} fetches`);
  engine.close();
  srv.server.close();
}

/* ---------------- HLS AES-128 padding edge case ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/pad/index.m3u8`);
  check('aes: plaintext ending in a padding-like byte is not truncated',
    d.status === 'completed' && fs.readFileSync(d.finalPath).equals(padPlain), d.error || `${fs.readFileSync(d.finalPath).length} bytes`);
  engine.close();
  srv.server.close();
}

/* ---------------- HLS with a mid-playlist init change ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/mapchange/index.m3u8`);
  check('map change: download completes', d.status === 'completed', d.error);
  // The init section belongs to the second part, not in front of the first.
  check('map change: the init section is placed where it belongs',
    fs.readFileSync(d.finalPath).equals(Buffer.concat([mapChangeSegs[0], mapChangeInit, mapChangeSegs[1]])),
    fs.readFileSync(d.finalPath).toString('hex'));
  engine.close();
  srv.server.close();
}

/* ---------------- HLS fMP4 with init map ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/fmp4/index.m3u8`);
  check('fmp4: completes', d.status === 'completed', d.error || d.status);
  check('fmp4: init map prepended', fs.readFileSync(d.finalPath).equals(Buffer.concat([fmp4Init, ...fmp4Segs])));
  engine.close();
  srv.server.close();
}

/* ---------------- HLS EXT-X-BYTERANGE ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/range/index.m3u8`);
  check('byterange: completes', d.status === 'completed', d.error || d.status);
  check('byterange: slices reassembled in order', fs.readFileSync(d.finalPath).equals(rangeFile));
  engine.close();
  srv.server.close();
}

/* ---------------- HLS pause / resume ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = engine.add({ urls: [`http://127.0.0.1:${srv.port}/slow/index.m3u8`] });
  await waitFor(() => d.stream && d.stream.index >= 2);
  await d.pause('user');
  check('pause: stream paused with progress kept', d.status === 'paused' && d.stream.index >= 1, `index=${d.stream.index}`);
  const partExists = fs.existsSync(d.partPath);
  d.resume();
  await waitFor(() => ['completed', 'failed'].includes(d.status));
  check('resume: stream completes after pause', d.status === 'completed', d.error || d.status);
  check('resume: kept progress (part file reused)', partExists && d.stream.total === 8);
  check('resume: final content complete', fs.readFileSync(d.finalPath).equals(Buffer.concat(slowSegs)));
  engine.close();
  srv.server.close();
}

/* ---------------- DASH ---------------- */
{
  const srv = await startServer(buildRoutes());
  const engine = makeEngine();
  const d = await runDownload(engine, `http://127.0.0.1:${srv.port}/stream.mpd`);
  check('dash: download completes', d.status === 'completed', d.error || d.status);
  check('dash: snapshot marks stream', d.snapshot().stream === 'dash');
  check('dash: picks highest video + audio (9 parts)', d.snapshot().total === 9, String(d.snapshot().total));
  check('dash: video track = init + 5 segments', fs.readFileSync(d.finalPath).equals(Buffer.concat([dashInitV, ...dashV])));
  check('dash: audio track written separately', fs.existsSync(d.audioPath) && fs.readFileSync(d.audioPath).equals(Buffer.concat([dashInitA, ...dashA])));
  engine.close();
  srv.server.close();
}

/* ---------------- stream metadata persistence across restart ---------------- */
{
  const srv = await startServer(buildRoutes());
  const dir = path.join(TMP, 'persist');
  fs.mkdirSync(dir, { recursive: true });
  const engine = new Engine(dir);
  engine.settings.rootDir = path.join(dir, 'out');
  engine.settings.organizeByCategory = false;
  const d = engine.add({ urls: [`http://127.0.0.1:${srv.port}/slow/index.m3u8`] });
  await waitFor(() => d.stream && d.stream.index >= 2);
  await d.pause('user');
  engine.saveNow();
  engine.close();

  const engine2 = new Engine(dir);
  const d2 = engine2.get(d.id);
  check('persist: stream metadata restored',
    !!d2 && !!d2.stream && d2.stream.kind === 'hls' && d2.stream.index >= 1 && d2.stream.total === slowSegs.length,
    d2 && JSON.stringify(d2.stream));
  d2.resume();
  await waitFor(() => ['completed', 'failed'].includes(d2.status));
  check('persist: resumed stream completes', d2.status === 'completed', d2.error || d2.status);
  check('persist: content intact after restart', fs.readFileSync(d2.finalPath).equals(Buffer.concat(slowSegs)));
  engine2.close();
  srv.server.close();
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
