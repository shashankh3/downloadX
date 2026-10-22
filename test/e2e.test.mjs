// downloadX end-to-end test — a fresh app, a real download, a restart.
// Starts the real server against a temporary data folder.
// Run: node test/e2e.test.mjs
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/* ---------------- a file to download ---------------- */
const BLOB = crypto.randomBytes(5 * 1024 * 1024 + 91);
const BLOB_HASH = crypto.createHash('sha256').update(BLOB).digest('hex');
const origin = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1);
    res.writeHead(206, {
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${BLOB.length}`,
      'Accept-Ranges': 'bytes',
    });
    return res.end(BLOB.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Length': String(BLOB.length), 'Accept-Ranges': 'bytes' });
  res.end(BLOB);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originUrl = `http://127.0.0.1:${origin.address().port}/movie.bin`;

const dataDir = path.join(TMP, 'data');
const files = path.join(TMP, 'files');
const port = await freePort();
let serverOut = '';

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DLX_PORT: String(port), DLX_DATA_DIR: dataDir, DLX_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverOut += d; });
  child.stderr.on('data', (d) => { serverOut += d; });
  return child;
}

async function api(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await api('/api/health');
      if (r.status === 200) return true;
    } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

let child = startServer();

/* ---------------- a fresh app ---------------- */
{
  const up = await waitUp();
  check('e2e: a fresh app starts', up, up ? '' : serverOut.trim().slice(-300));
  if (!up) {
    console.error('the server did not start, cannot continue');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const health = await api('/api/health');
  check('e2e: it reports its version', health.json.version === pkg.version, health.json.version);
  const settings = await api('/api/settings');
  check('e2e: the download folder is ready', !!settings.json.rootDir, settings.json.rootDir);
  check('e2e: the list starts empty', (await api('/api/state')).json.items.length === 0);
}

/* ---------------- a real download ---------------- */
{
  await api('/api/settings', { method: 'PUT', body: { rootDir: files, maxConnections: 8 } });
  const added = await api('/api/downloads', { method: 'POST', body: { url: originUrl, segments: 8 } });
  check('e2e: the download is accepted', added.status === 201 && !!added.json.id, added.json.error);
  const id = added.json.id;
  let item = null;
  for (let i = 0; i < 300; i++) {
    item = (await api(`/api/downloads/${id}`)).json;
    if (item.status === 'completed' || item.status === 'failed') break;
    await sleep(100);
  }
  check('e2e: the download completes', item.status === 'completed', item.error);
  check('e2e: every byte arrived', item.received === BLOB.length, `${item.received}/${BLOB.length}`);
  check('e2e: the file is byte-perfect',
    crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') === BLOB_HASH);
  check('e2e: the file is where it belongs', fs.existsSync(item.path), item.path);
  check('e2e: the part file is gone', !fs.existsSync(item.path + '.' + id.slice(0, 8) + '.dxpart'));
}

/* ---------------- the state survives a restart ---------------- */
{
  await api('/api/quit', { method: 'POST', body: {} });
  await sleep(1200);
  child = startServer();
  const up = await waitUp();
  check('e2e: the app restarts', up, up ? '' : serverOut.trim().slice(-300));
  const state = (await api('/api/state')).json;
  check('e2e: the download is still listed', state.items.length === 1 && state.items[0].status === 'completed');
  check('e2e: the settings survived', state.settings.rootDir === path.resolve(files), state.settings.rootDir);
  check('e2e: the port file is written', fs.existsSync(path.join(dataDir, 'port')));
}

/* ---------------- only one instance may own the data folder ---------------- */
{
  const second = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DLX_PORT: String(port + 1), DLX_DATA_DIR: dataDir, DLX_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  second.stdout.on('data', (d) => { out += d; });
  second.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => second.on('exit', r));
  check('e2e: a second instance refuses to start',
    code === 0 && /already running|already starting/i.test(out), (out || '').trim().slice(-120));
}

/* ---------------- a clean shutdown ---------------- */
{
  await api('/api/quit', { method: 'POST', body: {} });
  await sleep(1500);
  check('e2e: the port file is removed on shutdown', !fs.existsSync(path.join(dataDir, 'port')));
  check('e2e: the state file is written', fs.existsSync(path.join(dataDir, 'state.json')));
}

try { child.kill(); } catch { /* gone */ }
origin.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
  process.exit(1);
}
process.exit(0);
