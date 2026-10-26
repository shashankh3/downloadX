// Real-browser download-grab test.
//
// This is the "does Chrome actually hand a download to downloadX?" test. It
// starts a local origin server, a downloadX server and a Chromium/Chrome for
// Testing instance with the real extension loaded. The browser is then pointed
// at an attachment; the extension must cancel Chrome's copy, hand the URL to
// downloadX and downloadX must produce a byte-perfect file.
//
// Run: npm run test:chrome-grab
//
// Branded Chrome 137+ ignores --load-extension, so the test looks for Chromium
// or Chrome for Testing (including Playwright's Chromium). Set DLX_CHROME_PATH
// to force a specific executable. If no supported browser is found the test
// prints SKIP and exits successfully.
process.env.DLX_ALLOW_LOOPBACK_DOWNLOADS = '1';

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { prepareExtension } = require('../installer/extension-tools.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-chrome-grab-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/* A tiny Chrome DevTools Protocol client over Node's built-in WebSocket. */
class Cdp {
  static async connect(url, timeoutMs = 10000) {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket error'));
      }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* Find a browser that still supports --load-extension. Branded Chrome 137+
   removed the flag; Chromium and Chrome for Testing keep it. */
function findChromium() {
  const explicit = process.env.DLX_CHROME_PATH || process.env.CHROME_PATH || process.env.CHROME_FOR_TESTING_PATH;
  if (explicit) return explicit;

  const candidates = [];
  const playwrightRoots = [];
  if (process.env.LOCALAPPDATA) playwrightRoots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  if (process.env.HOME) {
    playwrightRoots.push(path.join(process.env.HOME, '.cache', 'ms-playwright'));
    playwrightRoots.push(path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright'));
  }
  for (const root of playwrightRoots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
        .sort((a, b) => parseInt(b.name.slice('chromium-'.length), 10) - parseInt(a.name.slice('chromium-'.length), 10));
    } catch { /* no Playwright cache */ }
    for (const dir of dirs) {
      const base = path.join(root, dir.name);
      candidates.push(
        path.join(base, 'chrome-win64', 'chrome.exe'),
        path.join(base, 'chrome-linux', 'chrome'),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  }

  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        path.join(base, 'Chromium', 'Application', 'chrome.exe'),
        path.join(base, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
  } else {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error('DevTools HTTP ' + res.status);
  return await res.json();
}

async function evaluate(target, expression) {
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception;
      throw new Error((exception && exception.description) || result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result.value;
  } finally {
    cdp.close();
  }
}

async function main() {
  if (typeof WebSocket !== 'function') {
    console.log('SKIP  chrome grab: Node.js 22+ is required for the built-in WebSocket CDP client.');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    return 0;
  }
  const browserPath = findChromium();
  if (!browserPath) {
    console.log('SKIP  chrome grab: no Chromium/Chrome for Testing found.');
    console.log('      Set DLX_CHROME_PATH to a Chromium or Chrome for Testing executable.');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    return 0;
  }
  console.log(`chrome: using ${browserPath}`);

  let origin = null;
  let server = null;
  let chrome = null;
  let browserCdp = null;
  let serverLogs = '';
  let chromeLogs = '';
  let testFileName = '';
  let chromeDownloadsDir = '';
  let keepTemp = process.env.DLX_CHROME_TEST_KEEP === '1';

  try {
    /* ---------------- the attachment ---------------- */
    const blob = crypto.randomBytes(4 * 1024 * 1024 + 37);
    const blobHash = crypto.createHash('sha256').update(blob).digest('hex');
    const fileName = `downloadx-chrome-grab-${process.pid}-${crypto.randomBytes(4).toString('hex')}.bin`;
    testFileName = fileName;

    origin = http.createServer((req, res) => {
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Accept-Ranges': 'bytes',
      };
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      let start = 0;
      let end = blob.length - 1;
      if (match) {
        start = parseInt(match[1], 10);
        if (match[2]) end = Math.min(parseInt(match[2], 10), blob.length - 1);
      }
      res.writeHead(match ? 206 : 200, {
        ...headers,
        'Content-Length': String(end - start + 1),
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${blob.length}` } : {}),
      });
      if (req.method === 'HEAD') return res.end();
      res.end(blob.subarray(start, end + 1));
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originBase = `http://127.0.0.1:${origin.address().port}`;
    const downloadUrl = `${originBase}/${encodeURIComponent(fileName)}`;

    /* ---------------- the real extension ---------------- */
    const serverPort = await freePort();
    const extension = prepareExtension({
      src: path.join(ROOT, 'extension'),
      out: path.join(TMP, 'extension'),
      keyFile: path.join(TMP, 'extension-key.pem'),
      version: pkg.version,
      firefoxId: 'downloadx-chrome-grab@local',
    });
    const extensionRoot = path.dirname(extension.chromeDir);
    const backgroundFile = path.join(extension.chromeDir, 'background.js');
    let background = fs.readFileSync(backgroundFile, 'utf8');
    const original = background;
    background = background
      .replace(/const DEFAULT_API = 'http:\/\/127\.0\.0\.1:9765';/,
        `const DEFAULT_API = 'http://127.0.0.1:${serverPort}';`)
      .replace(/const NATIVE_HOST = 'com\.downloadx\.host';/,
        "const NATIVE_HOST = 'com.downloadx.chrome-grab.test';")
      .replace(/const PORT_RANGE = \[9765, 9775\];/,
        `const PORT_RANGE = [${serverPort}, ${Math.min(serverPort + 10, 65535)}];`);
    if (background === original) throw new Error('Could not rewrite the extension defaults for the test port');
    fs.writeFileSync(backgroundFile, background);

    /* ---------------- downloadX ---------------- */
    const dataDir = path.join(TMP, 'data');
    const downloadsDir = path.join(TMP, 'downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DLX_PORT: String(serverPort),
        DLX_PORT_TRIES: '0',
        DLX_DATA_DIR: dataDir,
        DLX_EXT_DIR: extensionRoot,
        DLX_EXTENSION_IDS: extension.id,
        DLX_FIREFOX_ID: extension.firefoxId,
        DLX_NO_OPEN: '1',
        DLX_ALLOW_LOOPBACK_DOWNLOADS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (data) => { serverLogs += data; });
    server.stderr.on('data', (data) => { serverLogs += data; });
    const base = `http://127.0.0.1:${serverPort}`;
    const api = async (pathname, options = {}) => {
      const res = await fetch(base + pathname, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };

    let healthy = false;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(base + '/api/health');
        if (res.ok) { healthy = true; break; }
      } catch { /* not up yet */ }
      await sleep(100);
    }
    check('chrome: downloadX test server started', healthy, base);
    if (!healthy) throw new Error('The downloadX test server did not start');

    await api('/api/settings', {
      method: 'PUT',
      body: { rootDir: downloadsDir, organizeByCategory: false },
    });

    /* ---------------- Chromium ---------------- */
    let debugPort = await freePort();
    while (debugPort === serverPort) debugPort = await freePort();
    const profileDir = path.join(TMP, 'chrome-profile');
    const chromeDownloads = path.join(TMP, 'chrome-downloads');
    chromeDownloadsDir = chromeDownloads;
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
    fs.mkdirSync(chromeDownloads, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
      download: {
        default_directory: chromeDownloads,
        prompt_for_download: false,
        directory_upgrade: true,
      },
      savefile: { default_directory: chromeDownloads },
    }, null, 2));

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--hide-scrollbars',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      `--load-extension=${extension.chromeDir}`,
      `--disable-extensions-except=${extension.chromeDir}`,
      'about:blank',
    ];
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox', '--disable-dev-shm-usage');
    }
    chrome = spawn(browserPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    });
    chrome.stderr.on('data', (data) => { chromeLogs += data; });

    let version = null;
    for (let i = 0; i < 150; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (res.ok) { version = await res.json(); break; }
      } catch { /* not up yet */ }
      await sleep(100);
    }
    check('chrome: browser started', !!version, `DevTools port ${debugPort}`);
    if (!version) throw new Error('Chromium did not start with remote debugging');

    browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);

    let targets = [];
    let extensionTarget = null;
    for (let i = 0; i < 150; i++) {
      try { targets = await listTargets(debugPort); } catch { targets = []; }
      extensionTarget = targets.find((target) =>
        target.type === 'service_worker' &&
        target.url === `chrome-extension://${extension.id}/background.js`);
      if (extensionTarget) break;
      await sleep(100);
    }
    check('chrome: the extension was loaded', !!extensionTarget,
      extensionTarget ? `chrome-extension://${extension.id}` : targets.map((target) => target.url).join(', '));
    if (!extensionTarget) {
      throw new Error('Chromium did not load the extension (branded Chrome ignores --load-extension)');
    }
    // Let init() install the downloads listener before we start a download.
    await sleep(1000);

    /* ---------------- trigger a browser download ---------------- */
    const created = await browserCdp.send('Target.createTarget', { url: downloadUrl });
    check('chrome: the download was started', !!created.targetId, created.targetId || '');

    let item = null;
    const waitUntil = Date.now() + 30000;
    while (Date.now() < waitUntil) {
      const state = await api('/api/state').catch(() => null);
      const items = (state && state.json && state.json.items) || [];
      item = items.find((entry) => entry.url === downloadUrl || entry.filename === fileName) || null;
      if (item) break;
      await sleep(250);
    }
    check('chrome: the extension handed the download to downloadX', !!item,
      item ? item.filename : 'nothing arrived');

    if (item) {
      check('chrome: the file name was forwarded', item.filename === fileName, item.filename);

      let done = item;
      const doneUntil = Date.now() + 60000;
      while (Date.now() < doneUntil) {
        done = (await api(`/api/downloads/${item.id}`)).json;
        if (done.status === 'completed' || done.status === 'failed') break;
        await sleep(250);
      }
      check('chrome: downloadX completed the download', done.status === 'completed', done.error || done.status);
      if (done.path && fs.existsSync(done.path)) {
        check('chrome: the file is byte-perfect', hashFile(done.path) === blobHash, done.path);
      } else {
        check('chrome: the file is byte-perfect', false, 'missing ' + (done.path || path.join(downloadsDir, fileName)));
      }
    }

    /* ---------------- Chrome must not keep a copy ---------------- */
    let chromeItems = null;
    try {
      let target = extensionTarget;
      if (!target) {
        const current = await listTargets(debugPort);
        target = current.find((entry) => entry.type === 'service_worker' &&
          entry.url === `chrome-extension://${extension.id}/background.js`);
      }
      if (target) {
        chromeItems = await evaluate(target,
          'new Promise((resolve) => chrome.downloads.search({}, (items) => resolve(items.map((i) => ' +
          '({ id: i.id, state: i.state, filename: i.filename, error: i.error })))))');
      }
    } catch {
      chromeItems = null;
    }
    if (Array.isArray(chromeItems)) {
      const matching = chromeItems.filter((entry) =>
        String(entry.filename || '').replace(/\\/g, '/').endsWith(fileName));
      const kept = matching.filter((entry) => entry.state === 'complete' || entry.state === 'in_progress');
      check('chrome: the browser copy was cancelled', kept.length === 0, JSON.stringify(matching));
    } else {
      console.log('SKIP  chrome: the browser download list was not readable; checking the download folder only');
    }

    let leftovers = [];
    for (let i = 0; i < 20; i++) {
      leftovers = [];
      for (const dir of [chromeDownloads, path.join(os.homedir(), 'Downloads')]) {
        try {
          for (const name of fs.readdirSync(dir)) {
            if (name.includes(fileName)) leftovers.push(path.join(dir, name));
          }
        } catch { /* folder may not exist */ }
      }
      if (!leftovers.length) break;
      await sleep(250);
    }
    check('chrome: Chrome did not keep a copy', leftovers.length === 0, leftovers.join(', '));
  } catch (error) {
    check('chrome: test completed without a setup error', false, error.message);
  } finally {
    try { if (browserCdp) browserCdp.close(); } catch { /* ignore */ }
    killTree(chrome);
    killTree(server);
    try { if (origin) origin.close(); } catch { /* ignore */ }
    await sleep(500);
    if (testFileName) {
      for (const dir of [chromeDownloadsDir, path.join(os.homedir(), 'Downloads')]) {
        if (!dir) continue;
        try {
          for (const name of fs.readdirSync(dir)) {
            if (name.includes(testFileName)) {
              try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* locked */ }
            }
          }
        } catch { /* folder may not exist */ }
      }
    }
    if (!keepTemp) {
      try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { keepTemp = true; }
    }
    if (keepTemp) console.log('temp files kept at ' + TMP);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    if (chromeLogs.trim()) console.log('\n--- Chromium stderr ---\n' + chromeLogs.trim().slice(-4000));
    if (serverLogs.trim()) console.log('\n--- downloadX server log ---\n' + serverLogs.trim().slice(-4000));
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
