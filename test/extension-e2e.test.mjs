// downloadX extension integration test — the real extension code against the
// real server. The browser API is mocked, the network is not.
// Run: node test/extension-e2e.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createConnector } = require('../extension/background.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-ext-e2e-'));
const files = path.join(TMP, 'files');

/* ---------------- a file to download ---------------- */
const FILE = crypto.randomBytes(2 * 1024 * 1024 + 51);
const FILE_HASH = crypto.createHash('sha256').update(FILE).digest('hex');
const origin = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = FILE.length - 1;
  if (m) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), FILE.length - 1);
    res.writeHead(206, {
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${FILE.length}`,
      'Accept-Ranges': 'bytes',
    });
    return res.end(FILE.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Length': String(FILE.length), 'Accept-Ranges': 'bytes' });
  res.end(FILE);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originBase = `http://127.0.0.1:${origin.address().port}`;

/* ---------------- the downloadX server ---------------- */
/** Keep the default port busy so the extension has to look for another one. */
const blocker = net.createServer();
await new Promise((r) => blocker.listen(9765, '127.0.0.1', r));
const DLX_PORT = 9766;
const dataDir = path.join(TMP, 'data');

let dlx = null;
async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DLX_PORT: String(DLX_PORT), DLX_DATA_DIR: dataDir, DLX_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) {
    try { await api('/api/health'); break; } catch { await sleep(100); }
  }
  return child;
}
async function stopServer(child) {
  if (!child) return;
  try { child.kill(); } catch { /* gone */ }
  for (let i = 0; i < 50; i++) {
    try { await api('/api/health'); await sleep(100); } catch { return; }
  }
}

async function api(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${DLX_PORT}${pathname}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

dlx = await startServer();
if (!(await api('/api/health')).json.ok) { console.error('the server did not start'); process.exit(1); }
await api('/api/settings', { method: 'PUT', body: { rootDir: files, organizeByCategory: false } });

/** The ids of the downloads that are already known. */
async function knownIds() {
  return new Set(((await api('/api/state')).json.items || []).map((i) => i.id));
}
/** Wait for a download that is not in `before` and return it. */
async function waitForNew(before, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const items = ((await api('/api/state')).json.items || []).filter((i) => !before.has(i.id));
    if (items.length) return items[0];
    await sleep(250);
  }
  return null;
}
async function waitForDone(item, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last = item;
  while (Date.now() < end) {
    last = (await api(`/api/downloads/${item.id}`)).json;
    if (last.status === 'completed' || last.status === 'failed') return last;
    await sleep(250);
  }
  return last;
}

/* ---------------- a mocked browser, a real network ---------------- */
function makeChrome() {
  const state = { storage: {}, canceled: [], erased: [], badges: [], nativeCalls: [], cookies: [] };
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
      openOptionsPage(cb) { if (cb) cb(); },
      sendNativeMessage(host, msg, cb) { state.nativeCalls.push({ host, msg }); if (cb) cb(null); },
    },
    tabs: { onRemoved: { addListener() {} }, sendMessage(tabId, msg, cb) { if (cb) cb(); } },
    webRequest: { onHeadersReceived: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    storage: {
      local: {
        get(key, cb) {
          const res = typeof key === 'string'
            ? (key in state.storage ? { [key]: state.storage[key] } : {})
            : { ...state.storage };
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set(obj, cb) { Object.assign(state.storage, obj); if (cb) cb(); return Promise.resolve(); },
      },
    },
    action: {
      onClicked: { addListener() {} },
      setBadgeText(opts, cb) { state.badges.push(opts.text); if (cb) cb(); },
      setBadgeBackgroundColor(opts, cb) { if (cb) cb(); },
    },
    contextMenus: { onClicked: { addListener() {} }, removeAll(cb) { if (cb) cb(); }, create() {} },
    downloads: {
      onCreated: { addListener() {} },
      cancel(id, cb) { state.canceled.push(id); if (cb) cb(); },
      erase(q, cb) { state.erased.push(q); if (cb) cb(); },
    },
    cookies: { getAll(details, cb) { if (cb) cb(state.cookies); } },
  };
  return { chrome, state };
}

/* ---------------- 1. the app is found on a non-default port ---------------- */
{
  const { chrome, state } = makeChrome();
  const connector = createConnector(chrome);
  const before = await knownIds();
  // No apiBase is stored: the extension has to find the app by itself.
  await connector.onCreated({
    id: 1,
    url: `${originBase}/file.bin`,
    filename: 'C:\\Users\\u\\Downloads\\file.bin',
    referrer: `${originBase}/page.html`,
  });
  check('extension: the app is found on a non-default port',
    state.storage.apiBase === `http://127.0.0.1:${DLX_PORT}`, state.storage.apiBase);
  const item = await waitForNew(before);
  check('extension: the found app received the download', !!item, item ? item.url : 'nothing arrived');
  if (item) await waitForDone(item);
}

/* ---------------- 2. a browser download is grabbed ---------------- */
{
  const { chrome, state } = makeChrome();
  state.cookies = [{ name: 'sid', value: 'secret' }];
  const connector = createConnector(chrome);
  const before = await knownIds();
  await connector.onCreated({
    id: 7,
    url: `${originBase}/file.bin`,
    filename: 'C:\\Users\\u\\Downloads\\movie.bin',
    referrer: `${originBase}/watch`,
  });
  check('extension: the browser download was cancelled after the handoff', state.canceled.includes(7), state.canceled.join(','));
  check('extension: the browser entry was erased', state.erased.some((q) => q.id === 7));
  check('extension: the success badge is shown', state.badges.filter(Boolean).pop() === '✓', state.badges.join(','));

  const item = await waitForNew(before);
  check('extension: the download reached downloadX', !!item, item ? item.url : 'nothing arrived');
  if (item) {
    check('extension: the file name was forwarded', item.filename === 'movie.bin', item.filename);
    const done = await waitForDone(item);
    check('extension: the file was downloaded', done.status === 'completed', done.error);
    if (done.path && fs.existsSync(done.path)) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(done.path)).digest('hex');
      check('extension: the file is byte-perfect', hash === FILE_HASH);
    } else {
      check('extension: the file is byte-perfect', false, 'the file is missing');
    }
  }
}

/* ---------------- 3. the context menu hands a link over ---------------- */
{
  const { chrome } = makeChrome();
  const connector = createConnector(chrome);
  const before = await knownIds();
  const reply = await new Promise((resolve) => {
    connector.onMessage({ type: 'dlx:download', url: `${originBase}/file.bin`, filename: 'menu.bin' }, {}, resolve);
  });
  check('extension: the context menu hands the link over', !!(reply && reply.ok), JSON.stringify(reply));
  const item = await waitForNew(before);
  check('extension: the menu download arrived', !!item, item ? item.url : 'nothing arrived');
  if (item) {
    const done = await waitForDone(item);
    check('extension: the menu download completes', done.status === 'completed', done.error);
  }
}

/* ---------------- 4. a download is never lost ---------------- */
{
  await stopServer(dlx);
  dlx = null;
  const { chrome, state } = makeChrome();
  const connector = createConnector(chrome);
  await connector.onCreated({ id: 99, url: `${originBase}/file.bin` });
  check('extension: a download survives an unreachable app', state.canceled.length === 0, state.canceled.join(','));
  check('extension: the failure badge is shown', state.badges.filter(Boolean).pop() === '!', state.badges.join(','));
}

/* ---------------- 5. the app is reachable again afterwards ---------------- */
{
  dlx = await startServer();
  const { chrome } = makeChrome();
  const connector = createConnector(chrome);
  const before = await knownIds();
  const reply = await new Promise((resolve) => {
    connector.onMessage({ type: 'dlx:download', url: `${originBase}/file.bin`, filename: 'again.bin' }, {}, resolve);
  });
  check('extension: the app answers again', !!(reply && reply.ok), JSON.stringify(reply));
  const item = await waitForNew(before);
  check('extension: the download arrived again', !!item, item ? item.url : 'nothing arrived');
}

/* ---------------- cleanup ---------------- */
try { if (dlx) dlx.kill(); } catch { /* gone */ }
try { blocker.close(); } catch { /* gone */ }
origin.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
  process.exit(1);
}
process.exit(0);
