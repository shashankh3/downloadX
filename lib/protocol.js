'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'install.json'), 'utf8')); } catch { return {}; }
})();
const DATA_DIR = process.env.DLX_DATA_DIR
  || (INSTALL.perUserData && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'downloadX', 'data') : '')
  || INSTALL.dataDir
  || path.join(ROOT, 'data');
const HOST = process.env.DLX_HOST || INSTALL.host || '127.0.0.1';
const PORT = parseInt(process.env.DLX_PORT, 10) || INSTALL.port || 9765;

function candidatePorts() {
  const ports = [];
  try {
    const saved = parseInt(fs.readFileSync(path.join(DATA_DIR, 'port'), 'utf8').trim(), 10);
    if (saved > 0) ports.push(saved);
  } catch { /* no saved port */ }
  if (!ports.includes(PORT)) ports.push(PORT);
  for (let i = 1; i <= 10; i++) if (!ports.includes(PORT + i)) ports.push(PORT + i);
  return ports;
}

function getJson(port, pathname, timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { done(JSON.parse(body)); } catch { done(null); }
        });
      });
    } catch { return done(null); }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

function postJson(port, pathname, payload, timeout = 15000) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    let req;
    try {
      req = http.request({
        host: '127.0.0.1', port, path: pathname, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* plain */ }
          resolve({ status: res.statusCode, body: parsed, text: body });
        });
      });
    } catch (e) { return resolve({ status: 0, error: e }); }
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e }));
    req.write(data);
    req.end();
  });
}

async function findServer() {
  for (const port of candidatePorts()) {
    const info = await getJson(port, '/api/health', 700);
    if (info && info.ok) return port;
  }
  return 0;
}

function startServer() {
  try {
    const env = { ...process.env, DLX_DATA_DIR: DATA_DIR, DLX_HOST: HOST, DLX_PORT: String(PORT) };
    delete env.DLX_OPEN;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.on('error', () => { /* reported by timeout */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureServer() {
  let port = await findServer();
  if (port) return port;
  if (!startServer()) return 0;
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 350));
    port = await findServer();
    if (port) return port;
  }
  return 0;
}

function openTarget(target) {
  const [cmd, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no opener */ });
    child.unref();
  } catch { /* no opener */ }
}

function fail(message) {
  process.stderr.write('[downloadX] ' + message + '\n');
  process.exitCode = 1;
}

/**
 * Parse the argument of the downloadx:// handler.
 *
 * Accepts a bare http(s)/ftp(s) URL ("add it") or a downloadx:// URI with an
 * action in the host or the first path segment:
 *
 *   downloadx://add?url=https%3A%2F%2Fexample.com%2Ffile.zip
 *   downloadx://open
 *   downloadx://add/https%3A%2F%2Fexample.com%2Ffile.zip
 *
 * Returns { action, target, filename, referer } or { error }.
 */
function parseCommand(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { action: 'open', target: '', filename: '', referer: '' };
  if (/^(https?|ftps?):\/\//i.test(value)) {
    return { action: 'add', target: value, filename: '', referer: '' };
  }
  let uri;
  try { uri = new URL(value); } catch { return { error: 'Invalid downloadx:// URI' }; }
  if (!/^downloadx:$/i.test(uri.protocol)) return { error: 'Invalid downloadx:// URI' };
  const pathAction = uri.hostname || uri.pathname.replace(/^\/+/, '').split('/')[0];
  const action = String(pathAction || 'open').toLowerCase();
  let target = uri.searchParams.get('url') || '';
  const filename = uri.searchParams.get('filename') || '';
  const referer = uri.searchParams.get('referer') || '';
  if (!target) {
    let inline = uri.pathname.replace(/^\/+/, '');
    const slash = inline.indexOf('/');
    if (slash >= 0) inline = inline.slice(slash + 1);
    try { inline = decodeURIComponent(inline); } catch { /* keep raw */ }
    if (/^(https?|ftps?):\/\//i.test(inline)) target = inline;
  }
  return { action, target, filename, referer };
}

async function main() {
  const parsed = parseCommand(process.argv[2]);
  if (parsed.error) return fail(parsed.error);
  const { action, target, filename, referer } = parsed;

  const port = await ensureServer();
  if (!port) return fail('Could not reach or start downloadX');

  if (action === 'add') {
    if (!/^(https?|ftps?):\/\//i.test(target)) return fail('No valid http(s) or ftp(s) URL in downloadx:// link');
    const payload = { url: target };
    if (filename) payload.filename = filename;
    if (referer) payload.referer = referer;
    const result = await postJson(port, '/api/downloads', payload);
    if (!result.status || result.status >= 400) {
      const detail = (result.body && result.body.error) || (result.error && result.error.message) || 'request failed';
      return fail('Could not add download: ' + detail);
    }
    return;
  }

  if (action === 'open' || action === 'ui') {
    openTarget(`http://127.0.0.1:${port}/`);
    return;
  }

  return fail('Unknown downloadx:// action: ' + action);
}

module.exports = { parseCommand, main };

if (require.main === module) {
  main().catch((e) => fail(e && e.message ? e.message : String(e)));
}
