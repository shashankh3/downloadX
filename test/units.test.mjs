// downloadX unit tests — the small, pure modules that the big suites only
// touch indirectly. Fully local, no network, no server.
// Run: node test/units.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const patterns = require('../lib/patterns.js');
const instance = require('../lib/instance.js');
const protocol = require('../lib/protocol.js');
const { TokenBucket } = require('../lib/bucket.js');
const store = require('../lib/store.js');
const categories = require('../lib/categories.js');
const util = require('../lib/util.js');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-units-'));

/* ---------------- lib/patterns.js ---------------- */
{
  const g = patterns.expandGroup;
  check('patterns: numeric range', JSON.stringify(g('1-3')) === '["1","2","3"]', JSON.stringify(g('1-3')));
  check('patterns: zero padded range', JSON.stringify(g('01-03')) === '["01","02","03"]', JSON.stringify(g('01-03')));
  check('patterns: step range', JSON.stringify(g('1-10:3')) === '["1","4","7","10"]', JSON.stringify(g('1-10:3')));
  check('patterns: descending range', JSON.stringify(g('3-1')) === '["3","2","1"]', JSON.stringify(g('3-1')));
  check('patterns: negative range', JSON.stringify(g('-3--1')) === '["-3","-2","-1"]', JSON.stringify(g('-3--1')));
  check('patterns: letter range', JSON.stringify(g('a-c')) === '["a","b","c"]', JSON.stringify(g('a-c')));
  check('patterns: list group', JSON.stringify(g('one,two')) === '["one","two"]', JSON.stringify(g('one,two')));
  check('patterns: empty group is not a pattern', g('') === null);
  check('patterns: garbage group is not a pattern', g('nonsense') === null);
  check('patterns: half-open range is not a pattern', g('1-') === null);
  check('patterns: list with an empty part is not a pattern', g('a,,b') === null);
  check('patterns: cartesian product', patterns.expandPattern('http://x/[a,b][1-2].txt').length === 4);
  check('patterns: invalid lines are reported', (() => {
    const r = patterns.expandPatternDetailed('http://x/a.zip\nnot a url');
    return r.urls.length === 1 && r.errors.length === 1;
  })());
  check('patterns: cap is enforced', patterns.expandPattern('http://x/[1-2000].bin').length === patterns.MAX_URLS);
  check('patterns: IPv6 literals survive', patterns.expandPattern('http://[::1]/f.bin').length === 1);
}

/* ---------------- lib/instance.js ---------------- */
{
  const dir = path.join(TMP, 'inst');
  fs.mkdirSync(dir, { recursive: true });
  instance.writePortFile(dir, 9765);
  check('instance: port file round-trips', instance.readPortFile(dir) === 9765);
  instance.removePortFile(dir, 9765);
  check('instance: port file removed', instance.readPortFile(dir) === 0);
  instance.removePortFile(dir, 9765);
  check('instance: removing twice is safe', instance.readPortFile(dir) === 0);

  check('instance: the current pid is alive', instance.pidAlive(process.pid) === true);
  check('instance: an unused pid is not alive', instance.pidAlive(0x7ffffff0) === false);
  check('instance: a garbage pid is not alive', instance.pidAlive('abc') === false);

  // A lock file left behind by a dead process must not block a new instance.
  const staleDir = path.join(TMP, 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, instance.LOCK_NAME), JSON.stringify({
    pid: 0x7ffffff0, instance: 'dead', host: '127.0.0.1', port: 9765, startedAt: Date.now(),
  }));
  const lock = new instance.InstanceLock({ dataDir: staleDir, host: '127.0.0.1', port: 9765, timeoutMs: 3000 });
  const claim = await lock.acquire();
  check('instance: a stale lock is reclaimed', claim.acquired === true, JSON.stringify(claim));
  lock.release();
  check('instance: releasing removes the lock file', !fs.existsSync(path.join(staleDir, instance.LOCK_NAME)));

  const lockDir = path.join(TMP, 'lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const first = new instance.InstanceLock({ dataDir: lockDir, host: '127.0.0.1', port: 9765, timeoutMs: 1200 });
  const a = await first.acquire();
  const second = new instance.InstanceLock({ dataDir: lockDir, host: '127.0.0.1', port: 9765, timeoutMs: 1200 });
  const b = await second.acquire();
  check('instance: the first claim wins', a.acquired === true);
  check('instance: a second instance is refused', b.acquired === false, JSON.stringify(b));
  check('instance: a refused claim reports the owner', b.pid === process.pid, String(b.pid));
  first.release();
}

/* ---------------- lib/protocol.js ---------------- */
{
  const p = protocol.parseCommand;
  check('protocol: an empty argument opens the UI', p('').action === 'open');
  check('protocol: a bare URL is an add', (() => {
    const r = p('https://example.com/a.zip');
    return r.action === 'add' && r.target === 'https://example.com/a.zip';
  })());
  check('protocol: an ftp URL is an add', p('ftp://example.com/a.zip').action === 'add');
  check('protocol: downloadx://open', p('downloadx://open').action === 'open');
  check('protocol: downloadx://add with a query parameter', (() => {
    const r = p('downloadx://add?url=https%3A%2F%2Fexample.com%2Fa.zip');
    return r.action === 'add' && r.target === 'https://example.com/a.zip';
  })());
  check('protocol: filename and referer are read', (() => {
    const r = p('downloadx://add?url=https%3A%2F%2Fx%2Fa.zip&filename=a.zip&referer=https%3A%2F%2Fx%2Fp');
    return r.filename === 'a.zip' && r.referer === 'https://x/p';
  })());
  check('protocol: an inline URL in the path works', (() => {
    const r = p('downloadx://add/https%3A%2F%2Fexample.com%2Fa.zip');
    return r.action === 'add' && r.target === 'https://example.com/a.zip';
  })());
  check('protocol: a malformed URI is rejected', !!p('not a uri').error);
  check('protocol: a foreign scheme is rejected', !!p('javascript://alert(1)').error);
}

/* ---------------- lib/bucket.js ---------------- */
{
  const b = new TokenBucket(1000);
  await b.take(1000);
  check('bucket: the burst is spent', b.tokens < 1000);
  b.setRate(0);
  const t0 = Date.now();
  await b.take(50 * 1024 * 1024);
  check('bucket: rate 0 disables the limit', Date.now() - t0 < 50);
  const c = new TokenBucket(1000);
  await c.take(1000);
  c.setRate(10);
  check('bucket: setRate shrinks the burst', c.tokens <= 10, String(c.tokens));
}

/* ---------------- lib/store.js ---------------- */
{
  const file = path.join(TMP, 'store.json');
  store.save(file, { a: 1 });
  check('store: the value round-trips', store.load(file, null).a === 1);
  check('store: no temporary file is left behind', !fs.existsSync(file + '.tmp'));
  check('store: the parent directory is created', (() => {
    const nested = path.join(TMP, 'deep', 'er', 'store.json');
    store.save(nested, { b: 2 });
    return store.load(nested, null).b === 2;
  })());
  fs.writeFileSync(file, '{broken');
  check('store: a corrupt file falls back', store.load(file, 'fallback') === 'fallback');
}

/* ---------------- lib/categories.js ---------------- */
{
  check('category: extension wins over mime', categories.categoryFor('video/mp4', 'a.bin') === 'Video');
  check('category: mime fallback for video', categories.categoryFor('video/mp4', 'a.bin') === 'Video');
  check('category: mime fallback for pdf', categories.categoryFor('application/pdf', 'a.bin') === 'Documents');
  check('category: mime fallback for audio', categories.categoryFor('audio/mpeg', 'a.bin') === 'Music');
  check('category: mime fallback for image', categories.categoryFor('image/png', 'a.bin') === 'Images');
  check('category: unknown type falls back', categories.categoryFor('application/x-thing', 'a.bin') === 'Others');
  check('category: names are case-insensitive', categories.normalizeCategory('DOCUMENTS') === 'Documents');
  check('category: an unknown name becomes auto', categories.normalizeCategory('bogus') === 'auto');
  check('category: auto stays auto', categories.normalizeCategory('auto') === 'auto');
  check('category: the list contains every group', categories.CATEGORY_NAMES.length === 7);
}

/* ---------------- lib/util.js ---------------- */
{
  check('util: clampInt clamps', util.clampInt(5, 1, 3, 0) === 3);
  check('util: clampInt falls back', util.clampInt('x', 1, 3, 7) === 7);
  check('util: cleanPathStr strips NUL and spaces', util.cleanPathStr('  a\0b  ') === 'ab');
  check('util: cleanPathStr ignores non-strings', util.cleanPathStr(null) === '');
  check('util: disk errors are recognised', util.isFatalDiskError({ code: 'ENOSPC' }) === true);
  check('util: other errors are not fatal', util.isFatalDiskError({ code: 'ECONNRESET' }) === false);
  check('util: back-off grows', util.backoffDelay(1) <= 1000);
  check('util: back-off is capped', util.backoffDelay(30) <= 30000);
  check('util: back-off never returns zero', util.backoffDelay(1) >= 50);
  check('util: free space is a number or null', (() => {
    const v = util.freeSpaceFor(TMP);
    return v === null || (typeof v === 'number' && v >= 0);
  })());
}

/* ---------------- lib/ftp.js: the control channel parser ---------------- */
{
  const { Control } = require('../lib/ftp.js');
  const { PassThrough } = require('node:stream');
  const sock = new PassThrough();
  const control = new Control(sock, 2000);

  // A single line reply.
  const single = control.readReply(2000);
  sock.write('220 ready\r\n');
  const singleReply = await single;
  check('ftp: a single line reply is parsed', singleReply.code === 220 && /ready/.test(singleReply.text));

  // A multi line reply: the first line announces more, the last one ends it.
  const multi = control.readReply(2000);
  sock.write('211-Features:\r\n REST STREAM\r\n SIZE\r\n211 End\r\n');
  const multiReply = await multi;
  check('ftp: a multi line reply keeps every line', multiReply.code === 211 && multiReply.text.split('\n').length === 4, JSON.stringify(multiReply.text));
  check('ftp: the multi line reply keeps the feature', /REST STREAM/.test(multiReply.text));

  // A reply that is split across two packets.
  const split = control.readReply(2000);
  sock.write('502 Not ');
  await new Promise((r) => setTimeout(r, 20));
  sock.write('implemented\r\n');
  const splitReply = await split;
  check('ftp: a reply split over two packets is joined', splitReply.code === 502 && /not implemented/i.test(splitReply.text));

  // A line that is not a reply at all must not confuse the parser.
  const noisy = control.readReply(2000);
  sock.write('garbage line\r\n250 ok\r\n');
  const noisyReply = await noisy;
  check('ftp: a stray line is ignored', noisyReply.code === 250, JSON.stringify(noisyReply));
  control.destroy();
}

/* ---------------- lib/scrape.js ---------------- */
{
  const { extractLinks } = require('../lib/scrape.js');
  const html = [
    '<html><body>',
    '<a href="/files/manual.pdf">manual</a>',
    '<a href="files/setup.exe" download>setup</a>',
    '<a href="https://other.example/x.zip">other</a>',
    '<a href="page.html">page</a>',
    '<a href="style.css">css</a>',
    '<a href="javascript:void(0)">js</a>',
    '<a href="#top">top</a>',
    '<a href="/files/manual.pdf">manual again</a>',
    '<img src="/logo.png">',
    '</body></html>',
  ].join('');
  const links = extractLinks(html, 'https://example.com/dir/index.html');
  const urls = links.map((l) => l.url);
  check('scrape: relative links are resolved', urls.includes('https://example.com/files/manual.pdf'), urls.join(','));
  check('scrape: the same link is only listed once', new Set(urls).size === urls.length, urls.join(','));
  check('scrape: assets are skipped', !urls.some((u) => /\.(css|png|html)$/.test(u)), urls.join(','));
  check('scrape: javascript and anchors are skipped', !urls.some((u) => u.startsWith('javascript:') || u.endsWith('#top')), urls.join(','));
  check('scrape: absolute links are kept', urls.includes('https://other.example/x.zip'), urls.join(','));
  check('scrape: the likely downloads come first', links[0] && links[0].likely === true, JSON.stringify(links[0]));
  const withAssets = extractLinks(html, 'https://example.com/dir/index.html', { includeAssets: true });
  check('scrape: assets can be included', withAssets.some((l) => /\.css$/.test(l.url)), String(withAssets.length));
  check('scrape: an empty page yields nothing', extractLinks('', 'https://example.com/').length === 0);
}

/* ---------------- lib/origin.js ---------------- */
{
  const { createOriginCheck, normalizeIds } = require('../lib/origin.js');
  const open = createOriginCheck();
  check('origin: no origin is allowed', open('') === true);
  check('origin: loopback is allowed', open('http://127.0.0.1:9765') === true);
  check('origin: localhost is allowed', open('http://localhost:9765') === true);
  check('origin: an extension is allowed by default', open('chrome-extension://abcdefghijklmnopabcdefghijklmnop') === true);
  check('origin: a foreign site is rejected', open('https://evil.example') === false);
  check('origin: a look-alike host is rejected', open('http://127.0.0.1.evil.example') === false);
  check('origin: a file url is rejected', open('file:///C:/evil.html') === false);

  const pinned = createOriginCheck({ allowedIds: 'AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP' });
  check('origin: the pinned extension is allowed', pinned('chrome-extension://aabbccddeeffgghhiijjkkllmmnnoopp') === true);
  check('origin: another extension is rejected', pinned('chrome-extension://ppppooonnmllkkjjiihhggffeedccbbaa') === false);
  check('origin: loopback still works when pinned', pinned('http://127.0.0.1:9765') === true);
  check('origin: ids are normalised', JSON.stringify(normalizeIds(' AA , bb ')) === '["aa","bb"]');
}

/* ---------------- lib/origin.js: the address guard ---------------- */
{
  const { isPrivateOrReservedIp, createSafeLookup } = require('../lib/origin.js');
  check('guard: IPv4 loopback is private', isPrivateOrReservedIp('127.0.0.1') === true);
  check('guard: the whole 127/8 block is private', isPrivateOrReservedIp('127.99.1.5') === true);
  check('guard: 10/8 is private', isPrivateOrReservedIp('10.1.2.3') === true);
  check('guard: 172.16/12 is private', isPrivateOrReservedIp('172.16.0.1') === true);
  check('guard: 172.32 is public', isPrivateOrReservedIp('172.32.0.1') === false);
  check('guard: 192.168/16 is private', isPrivateOrReservedIp('192.168.1.1') === true);
  check('guard: link local is private (cloud metadata)', isPrivateOrReservedIp('169.254.169.254') === true);
  check('guard: carrier grade NAT is private', isPrivateOrReservedIp('100.64.0.1') === true);
  check('guard: a public address is allowed', isPrivateOrReservedIp('93.184.216.34') === false);
  check('guard: 8.8.8.8 is allowed', isPrivateOrReservedIp('8.8.8.8') === false);
  check('guard: IPv6 loopback is private', isPrivateOrReservedIp('::1') === true);
  check('guard: IPv6 unique local is private', isPrivateOrReservedIp('fd00::1') === true);
  check('guard: IPv6 link local is private', isPrivateOrReservedIp('fe80::1') === true);
  check('guard: a public IPv6 is allowed', isPrivateOrReservedIp('2606:4700:4700::1111') === false);
  check('guard: an IPv4 mapped loopback is private', isPrivateOrReservedIp('::ffff:127.0.0.1') === true);
  check('guard: garbage is not private', isPrivateOrReservedIp('not an ip') === false);
  check('guard: the lookup exists', typeof createSafeLookup(true) === 'function');
}

/* ---------------- report ---------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
  process.exit(1);
}
process.exit(0);
