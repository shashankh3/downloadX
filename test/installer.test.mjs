// downloadX installer + extension packaging tests.
// Run: node test/installer.test.mjs   (or: npm run test:installer)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crxlib = require('../installer/crx.js');
const { prepareExtension } = require('../installer/extension-tools.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dlx-installer-'));
const WINDOWS = process.platform === 'win32';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' - ' + extra : ''}`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, windowsHide: true, ...opts });
}

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, 30000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function powershell(script, opts = {}) {
  return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);
}

function regExists(key) {
  const safe = key.replace(/'/g, "''");
  return powershell(`if (Test-Path -LiteralPath '${safe}') { exit 0 } else { exit 1 }`).status === 0;
}

function cleanReg(key) {
  const safe = key.replace(/'/g, "''");
  powershell(`Remove-Item -LiteralPath '${safe}' -Recurse -Force -ErrorAction SilentlyContinue`);
}

function readZip(buf) {
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.subarray(i, i + 4).equals(eocdSig)) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory header');
    const crc = buf.readUInt32LE(off + 16);
    const size = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    const local = buf.readUInt32LE(off + 42);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lelen;
    entries.set(name, { crc, data: buf.subarray(start, start + size) });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint overrun');
    const b = buf[pos++];
    value += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [value, pos];
    shift += 7;
    if (shift > 56) throw new Error('varint too long');
  }
}

function parseProto(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const value = buf.subarray(pos, pos + len);
      pos += len;
      if (!fields.has(field)) fields.set(field, []);
      fields.get(field).push(value);
    } else if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      if (!fields.has(field)) fields.set(field, []);
      fields.get(field).push(value);
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error('unsupported protobuf wire type ' + wire);
    }
  }
  return fields;
}

function pingHost(exe, env = undefined) {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    const chunks = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(null); }, 30000);
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      let reply = null;
      try { reply = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch { /* bad json */ }
      try { child.stdin.end(); child.kill(); } catch { /* gone */ }
      resolve(reply);
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    const msg = Buffer.from(JSON.stringify({ cmd: 'ping' }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(msg.length);
    child.stdin.write(Buffer.concat([head, msg]));
  });
}

/* ---------------- manifest / version consistency ---------------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  check('manifest: extension version matches package', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);
  check('manifest: nativeMessaging permission', Array.isArray(manifest.permissions) && manifest.permissions.includes('nativeMessaging'));
}

/* ---------------- ZIP + CRC ---------------- */
{
  check('crc32: known vector', crxlib.crc32(Buffer.from('123456789')) === 0xcbf43926);
  const manifestData = Buffer.from('{"name":"downloadX"}');
  const randomData = crypto.randomBytes(1024);
  const zip = crxlib.zipStore([
    { name: 'manifest.json', data: manifestData },
    { name: 'nested/background.js', data: randomData },
  ], new Date('2026-01-02T03:04:06Z'));
  const entries = readZip(zip);
  check('zip: stores both entries', entries.size === 2);
  check('zip: payload round-trip', entries.get('manifest.json').data.equals(manifestData) && entries.get('nested/background.js').data.equals(randomData));
  check('zip: crc32 in directory', entries.get('nested/background.js').crc === crxlib.crc32(randomData));
}

/* ---------------- key + id ---------------- */
let info;
let keyId;
{
  const keyFile = path.join(TMP, 'keys', 'extension-key.pem');
  const key = crxlib.loadOrCreateKey(keyFile);
  const der = crxlib.publicKeyDer(key);
  keyId = crxlib.extensionId(der);
  check('key: creates PEM file', fs.existsSync(keyFile));
  check('id: chrome alphabet', /^[a-p]{32}$/.test(keyId), keyId);
  const again = crxlib.loadOrCreateKey(keyFile);
  check('id: stable across reloads', crxlib.extensionId(crxlib.publicKeyDer(again)) === keyId);

  const out = path.join(TMP, 'ext-out');
  info = prepareExtension({
    src: path.join(ROOT, 'extension'),
    out,
    keyFile,
    version: '9.9.9',
    firefoxId: 'downloadx-test@local',
    codebase: 'http://127.0.0.1:9765/ext/downloadx.crx',
  });
  check('prepare: writes chrome build', fs.existsSync(path.join(out, 'chrome', 'manifest.json')));
  check('prepare: writes firefox build', fs.existsSync(path.join(out, 'firefox', 'manifest.json')));
  check('prepare: writes crx + updates', fs.existsSync(info.crxFile) && fs.existsSync(info.updatesFile));

  const cm = JSON.parse(fs.readFileSync(path.join(out, 'chrome', 'manifest.json'), 'utf8'));
  const fm = JSON.parse(fs.readFileSync(path.join(out, 'firefox', 'manifest.json'), 'utf8'));
  check('chrome: version injected', cm.version === '9.9.9');
  check('chrome: key injected', cm.key === der.toString('base64'));
  check('chrome: nativeMessaging permission', Array.isArray(cm.permissions) && cm.permissions.includes('nativeMessaging'));
  check('firefox: gecko id', fm.browser_specific_settings && fm.browser_specific_settings.gecko.id === 'downloadx-test@local');
  check('firefox: event page background', Array.isArray(fm.background.scripts) && fm.background.scripts[0] === 'background.js');
  check('firefox: nativeMessaging permission', fm.permissions.includes('nativeMessaging'));
  check('prepare: id matches key', info.id === keyId, info.id);
}

/* ---------------- CRX3 container ---------------- */
{
  const crx = fs.readFileSync(info.crxFile);
  check('crx: magic + version', crx.toString('latin1', 0, 4) === 'Cr24' && crx.readUInt32LE(4) === 3);
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const zipData = crx.subarray(12 + headerLen);
  const headerFields = parseProto(header);
  const proof = parseProto(headerFields.get(2)[0]);
  const pubDer = proof.get(1)[0];
  const signature = proof.get(2)[0];
  const signedHeader = headerFields.get(10000)[0];
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), lenBuf, signedHeader, zipData]);
  const publicKey = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  check('crx: signature verifies', crypto.verify('sha256', signed, publicKey, signature));
  const crxId = parseProto(signedHeader).get(1)[0];
  check('crx: signed id matches key', crxId.equals(crypto.createHash('sha256').update(pubDer).digest().subarray(0, 16)));
  check('crx: id matches build info', info.id === keyId);

  const entries = readZip(zipData);
  check('crx: contains manifest', entries.has('manifest.json') && JSON.parse(entries.get('manifest.json').data).version === '9.9.9');
  check('crx: contains background script', entries.has('background.js'));

  const updates = fs.readFileSync(info.updatesFile, 'utf8');
  check('updates.xml: app id', updates.includes(`appid='${info.id}'`));
  check('updates.xml: version + codebase', updates.includes("version='9.9.9'") && updates.includes('http://127.0.0.1:9765/ext/downloadx.crx'));
  check('updates.xml: escapes ampersands', crxlib.updateManifest(keyId, '1.0', 'http://x/a?b=1&c=2').includes('b=1&amp;c=2'));
}

/* ---------------- downloadx:// protocol handler ---------------- */
{
  const posts = [];
  const mock = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: 'test' }));
    }
    if (req.url === '/api/downloads' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* invalid */ }
        posts.push(parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));

  const dataDir = path.join(TMP, 'protocol-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'port'), String(mock.address().port));
  const env = { ...process.env, DLX_DATA_DIR: dataDir, DLX_NO_OPEN: '1' };
  const script = path.join(ROOT, 'lib', 'protocol.js');
  const target = 'https://example.com/files/release.zip?token=abc';
  const referer = 'https://example.com/page?x=1&y=2';
  const query = new URLSearchParams({ url: target, filename: 'release.zip', referer }).toString();
  const ok = await runAsync(process.execPath, [script, 'downloadx://add?' + query], { env });
  check('protocol: add exits 0', ok.status === 0, (ok.stderr || '').trim());
  check('protocol: posts download', posts.length === 1 && posts[0].url === target && posts[0].filename === 'release.zip' && posts[0].referer === referer, JSON.stringify(posts[0]));

  const pathForm = await runAsync(process.execPath, [script, 'downloadx://add/' + encodeURIComponent(target)], { env });
  check('protocol: path form posts download', pathForm.status === 0 && posts.length === 2 && posts[1].url === target, (pathForm.stderr || '').trim());

  const bad = await runAsync(process.execPath, [script, 'downloadx://add?url=' + encodeURIComponent('file:///C:/Windows/win.ini')], { env });
  check('protocol: rejects non-http URL', bad.status === 1 && posts.length === 2, (bad.stderr || '').trim());
  const badScheme = await runAsync(process.execPath, [script, 'notdownloadx://add'], { env });
  check('protocol: rejects malformed URI', badScheme.status === 1, (badScheme.stderr || '').trim());

  await new Promise((r) => mock.close(r));
}

/* ---------------- PowerShell scripts ---------------- */
if (WINDOWS) {
  for (const file of ['installer/install.ps1', 'installer/uninstall.ps1']) {
    const full = path.join(ROOT, file).replace(/'/g, "''");
    const script = `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${full}',[ref]$t,[ref]$e); if ($e.Count) { $e | ForEach-Object { Write-Output (($_.Extent.StartLineNumber).ToString() + ': ' + $_.Message) }; exit 1 }`;
    const r = powershell(script);
    check('powershell: parses ' + file, r.status === 0, ((r.stdout || '') + (r.stderr || '')).trim());
  }
} else {
  check('powershell: parses installer scripts (skipped on non-Windows)', true);
}

/* ---------------- installer dry run ---------------- */
if (WINDOWS) {
  const dryApp = path.join(TMP, 'dry-app');
  const dryData = path.join(TMP, 'dry-data');
  const r = run('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'installer', 'install.ps1'),
    '-DryRun', '-InstallDir', dryApp, '-DataDir', dryData, '-NoShortcuts', '-NoLaunch',
  ]);
  check('dry-run: exits 0', r.status === 0, ((r.stderr || '') + (r.stdout || '')).trim().slice(-400));
  check('dry-run: reports plan', /\[dry-run\]/.test(r.stdout || ''));
  check('dry-run: writes nothing', !fs.existsSync(dryApp) && !fs.existsSync(dryData));
  check('dry-run: resolves manual mode', (r.stdout || '').includes("extension mode resolves to 'manual'"));

  const missingApp = path.join(TMP, 'missing-app');
  const missingData = path.join(TMP, 'missing-data');
  const reg = 'HKCU:\\__dlx_test_' + crypto.randomBytes(6).toString('hex');
  try {
    const u = run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'installer', 'uninstall.ps1'),
      '-DryRun', '-Quiet', '-InstallDir', missingApp, '-DataDir', missingData, '-RegistryBase', reg,
    ]);
    check('uninstall dry-run: exits 0 without an install', u.status === 0, ((u.stderr || '') + (u.stdout || '')).trim().slice(-300));
    check('uninstall dry-run: writes nothing', !fs.existsSync(missingApp) && !fs.existsSync(missingData));
  } finally {
    cleanReg(reg);
  }
}

/* ---------------- sandboxed install + uninstall ---------------- */
if (WINDOWS) {
  const appDir = path.join(TMP, 'sandbox-app');
  const dataDir = path.join(TMP, 'sandbox-data');
  const reg = 'HKCU:\\__dlx_test_' + crypto.randomBytes(6).toString('hex');
  try {
    const ir = run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'installer', 'install.ps1'),
      '-InstallDir', appDir, '-DataDir', dataDir, '-RegistryBase', reg,
      '-NoExtension', '-NoShortcuts', '-NoAutostart', '-NoLaunch', '-Force',
    ]);
    check('install: exits 0', ir.status === 0, ((ir.stderr || '') + (ir.stdout || '')).trim().slice(-500));
    check('install: copies app', fs.existsSync(path.join(appDir, 'server.js')) && fs.existsSync(path.join(appDir, 'lib', 'protocol.js')));
    check('install: writes launchers', fs.existsSync(path.join(appDir, 'downloadX.cmd')) && fs.existsSync(path.join(appDir, 'downloadX-silent.vbs')) && fs.existsSync(path.join(appDir, 'downloadX-start.vbs')) && fs.existsSync(path.join(appDir, 'downloadx-protocol.vbs')));
    let json = null;
    try { json = JSON.parse(fs.readFileSync(path.join(appDir, 'install.json'), 'utf8')); } catch { /* missing */ }
    check('install: install.json', json && json.dataDir === dataDir && json.node);
    check('install: chooses a local port', !!json && json.port >= 9765 && json.port <= 9775, json && json.port);
    const cmdText = fs.readFileSync(path.join(appDir, 'downloadX.cmd'), 'utf8');
    check('install: launcher data dir', cmdText.includes('DLX_DATA_DIR=' + dataDir));
    check('install: launcher pins the chosen port', !!json && cmdText.includes('DLX_PORT=' + json.port));
    const vbsRaw = fs.readFileSync(path.join(appDir, 'downloadx-protocol.vbs'));
    const protoText = vbsRaw.toString('utf16le');
    check('install: protocol launcher', protoText.includes('protocol.js'));
    check('install: protocol launcher rejects injection', protoText.includes('Chr(34)') && protoText.includes('4096'));
    check('install: VBS launchers are Unicode', vbsRaw[0] === 0xff && vbsRaw[1] === 0xfe);
    const startText = fs.readFileSync(path.join(appDir, 'downloadX-start.vbs'), 'utf16le');
    check('install: start launcher opens UI', startText.includes('DLX_OPEN') && startText.includes('server.js'));
    check('install: start launcher pins the chosen port', !!json && startText.includes('DLX_PORT") = "' + json.port));
    check('install: uninstall registry entry', regExists(reg + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\downloadX'));
    check('install: protocol registry entry', regExists(reg + '\\Software\\Classes\\downloadx\\shell\\open\\command'));

    const ur = run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appDir, 'installer', 'uninstall.ps1'),
      '-InstallDir', appDir, '-DataDir', dataDir, '-RegistryBase', reg, '-Quiet',
    ]);
    check('uninstall: exits 0', ur.status === 0, ((ur.stderr || '') + (ur.stdout || '')).trim().slice(-500));
    check('uninstall: removes app', !fs.existsSync(appDir));
    check('uninstall: keeps history by default', fs.existsSync(dataDir));
    check('uninstall: removes registry entries', !regExists(reg + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\downloadX') && !regExists(reg + '\\Software\\Classes\\downloadx'));
  } finally {
    cleanReg(reg);
  }
}

/* ---------------- sandboxed install with extension + native host ---------------- */
if (WINDOWS) {
  const appDir = path.join(TMP, 'ext-app');
  const dataDir = path.join(TMP, 'ext-data');
  const fakeLocal = path.join(TMP, 'fake-local');
  const reg = 'HKCU:\\__dlx_test_' + crypto.randomBytes(6).toString('hex');
  const env = { ...process.env, LOCALAPPDATA: fakeLocal };
  try {
    const ir = run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'installer', 'install.ps1'),
      '-InstallDir', appDir, '-DataDir', dataDir, '-RegistryBase', reg,
      '-ExtensionMode', 'manual', '-NoShortcuts', '-NoAutostart', '-NoLaunch', '-Force',
    ], { env });
    check('extension install: exits 0', ir.status === 0, ((ir.stderr || '') + (ir.stdout || '')).trim().slice(-600));
    check('extension install: builds chrome package', fs.existsSync(path.join(appDir, 'extension', 'chrome', 'manifest.json')));
    check('extension install: builds firefox package', fs.existsSync(path.join(appDir, 'extension', 'firefox', 'manifest.json')));
    const shim = path.join(appDir, 'downloadX-native-host.exe');
    check('extension install: compiles native host', fs.existsSync(shim));
    let json = null;
    try { json = JSON.parse(fs.readFileSync(path.join(appDir, 'install.json'), 'utf8')); } catch { /* missing */ }
    check('extension install: records extension id', !!json && /^[a-p]{32}$/.test(json.extension.id), json && json.extension.id);
    const hostFile = path.join(appDir, 'native', 'com.downloadx.host.json');
    check('extension install: writes native host manifest', fs.existsSync(hostFile));
    const registered = powershell(`(Get-Item -LiteralPath '${(reg + '\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloadx.host').replace(/'/g, "''")}' -ErrorAction SilentlyContinue).GetValue('')`).stdout.trim();
    check('extension install: registers native host', registered.toLowerCase() === hostFile.toLowerCase(), registered);

    const portMock = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: '1.2.0', instance: 'test' }));
      }
      res.writeHead(404);
      res.end();
    });
    let portFound = null;
    if (json && json.port) {
      await new Promise((r) => portMock.listen(json.port, '127.0.0.1', r));
      portFound = await pingHost(shim, { LOCALAPPDATA: path.join(TMP, 'fake-local-port') });
      await new Promise((r) => portMock.close(r));
    }
    check('extension install: native host finds the chosen port', !!portFound && portFound.ok === true && portFound.server === true && !!json && portFound.port === json.port, JSON.stringify(portFound));

    const ur = run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appDir, 'installer', 'uninstall.ps1'),
      '-InstallDir', appDir, '-DataDir', dataDir, '-RegistryBase', reg, '-RemoveData', '-Quiet',
    ], { env });
    check('extension uninstall: exits 0', ur.status === 0, ((ur.stderr || '') + (ur.stdout || '')).trim().slice(-500));
    check('extension uninstall: removes app', !fs.existsSync(appDir));
    check('extension uninstall: removes data when asked', !fs.existsSync(dataDir) && !fs.existsSync(path.join(fakeLocal, 'downloadX')));
    check('extension uninstall: removes native host registration', !regExists(reg + '\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloadx.host'));
  } finally {
    cleanReg(reg);
  }
}

/* ---------------- native messaging host ---------------- */
if (WINDOWS) {
  const exe = path.join(TMP, 'downloadX-native-host.exe');
  const hostCs = path.join(ROOT, 'native', 'host.cs');
  const compile = powershell(`Add-Type -Path '${hostCs.replace(/'/g, "''")}' -OutputAssembly '${exe.replace(/'/g, "''")}' -OutputType ConsoleApplication`);
  check('native host: compiles', compile.status === 0 && fs.existsSync(exe), ((compile.stderr || '') + (compile.stdout || '')).trim().slice(-400));
  if (compile.status === 0 && fs.existsSync(exe)) {
    const reply = await pingHost(exe);
    check('native host: framed ping', !!reply && reply.ok === true && typeof reply.server === 'boolean', JSON.stringify(reply));

    const hostData = path.join(TMP, 'host-data');
    fs.mkdirSync(hostData, { recursive: true });
    const hostMock = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: '9.9.9-test' }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => hostMock.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(hostData, 'port'), String(hostMock.address().port));
    const found = await pingHost(exe, { DLX_DATA_DIR: hostData });
    check('native host: discovers server from data dir', !!found && found.ok === true && found.server === true && found.port === hostMock.address().port && found.version === '9.9.9-test', JSON.stringify(found));
    await new Promise((r) => hostMock.close(r));
  }
} else {
  check('native host: compiles (skipped on non-Windows)', true);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
