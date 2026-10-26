// Builds dist/desktop/downloadX.exe — a native Windows window for downloadX.
//
// The result is a single executable: it contains the download engine, the
// WebView2 UI host, the WebView2 loader, the browser extension and the native
// messaging host. On first start it unpacks the engine into
// %LOCALAPPDATA%\downloadX\app\<version> and opens the local UI in a real
// window instead of a browser tab.
//
// Run: npm run build:desktop
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readLocalIndex, extractEntry } = require('../lib/zip.js');
const crx = require('./crx.js');
const { chromeManifest, firefoxManifest } = require('./extension-tools.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST, 'desktop');
const OUT = path.join(OUT_DIR, 'downloadX.exe');
const SERVER_EXE = path.join(DIST, 'downloadX.exe');
const ICON = path.join(DIST, 'downloadX.ico');
const EXTENSION_SRC = path.join(ROOT, 'extension');
const EXTENSION_PUBLIC_KEY = path.join(ROOT, 'desktop', 'extension-public-key.txt');
const NATIVE_HOST_SRC = path.join(ROOT, 'native', 'host.cs');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'downloadx');
const WV_VERSION = '1.0.4314.35';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DESKTOP_FIREFOX_ID = 'downloadx-desktop@local';
const DESKTOP_EXTENSION_GENERATED = new Set([
  'chrome', 'firefox', 'downloadx.crx', 'updates.xml', 'build-info.json',
]);

const REBUILD_SERVER = process.argv.includes('--rebuild-server');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  return result;
}

function findInstalledCsc() {
  const candidates = [];
  if (process.env.DLX_CSC) candidates.push(process.env.DLX_CSC);

  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const result = spawnSync(vswhere, [
      '-latest', '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.Roslyn.Compiler',
      '-find', 'MSBuild\\**\\Bin\\Roslyn\\csc.exe',
    ], { encoding: 'utf8' });
    if (result.status === 0) {
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        if (line.trim()) candidates.push(line.trim());
      }
    }
  }

  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!base) continue;
    const vs = path.join(base, 'Microsoft Visual Studio');
    if (!fs.existsSync(vs)) continue;
    for (const year of fs.readdirSync(vs)) {
      const yearDir = path.join(vs, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const edition of fs.readdirSync(yearDir)) {
        const candidate = path.join(yearDir, edition, 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
        if (fs.existsSync(candidate)) candidates.push(candidate);
      }
    }
  }

  const where = spawnSync('where', ['csc.exe'], { encoding: 'utf8' });
  if (where.status === 0) {
    for (const line of String(where.stdout || '').split(/\r?\n/)) {
      if (line.trim()) candidates.push(line.trim());
    }
  }

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const version = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
    const text = String(version.stdout || '') + String(version.stderr || '');
    if (!/4\.0\.30319/.test(text)) return candidate;
  }
  return '';
}

async function ensureRoslyn() {
  const version = '4.14.0';
  const nupkg = path.join(CACHE, `microsoft.net.compilers.toolset.${version}.nupkg`);
  await download(
    `https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/${version}/microsoft.net.compilers.toolset.${version}.nupkg`,
    nupkg);
  const dir = path.join(CACHE, `roslyn-${version}`);
  const csc = path.join(dir, 'csc.exe');
  if (!fs.existsSync(csc)) {
    console.log('extracting the Roslyn C# compiler...');
    const index = await readLocalIndex(nupkg);
    if (!index) throw new Error(`Not a valid zip archive: ${nupkg}`);
    for (const entry of index.entries) {
      if (!entry.name.startsWith('tasks/net472/') || entry.name.endsWith('/')) continue;
      const target = path.join(dir, entry.name.slice('tasks/net472/'.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const result = await extractEntry(nupkg, entry, target);
      if (!result.ok) throw new Error(`Could not extract ${entry.name}: ${result.error || 'unknown error'}`);
    }
  }
  if (!fs.existsSync(csc)) throw new Error('The Roslyn package did not contain csc.exe');
  return csc;
}

function findSignTool() {
  const fromPath = spawnSync('where', ['signtool.exe'], { encoding: 'utf8' });
  if (fromPath.status === 0) {
    const found = String(fromPath.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return found;
  }
  for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
    const kits = path.join(root, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(kits)) continue;
    for (const version of fs.readdirSync(kits).sort().reverse()) {
      for (const arch of ['x64', 'x86', 'arm64']) {
        const candidate = path.join(kits, version, arch, 'signtool.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function signExe() {
  const cert = process.env.DLX_SIGN_CERT || '';
  const thumbprint = process.env.DLX_SIGN_THUMBPRINT || '';
  if (!cert && !thumbprint) {
    console.log('code signing skipped (set DLX_SIGN_CERT or DLX_SIGN_THUMBPRINT to enable)');
    return;
  }
  const signtool = process.env.DLX_SIGNTOOL || findSignTool();
  if (!signtool) {
    console.log('code signing skipped: signtool.exe not found');
    return;
  }
  const args = [
    'sign', '/fd', 'SHA256',
    '/tr', process.env.DLX_SIGN_TIMESTAMP || 'http://timestamp.digicert.com',
    '/td', 'SHA256',
  ];
  if (cert) {
    args.push('/f', cert);
    if (process.env.DLX_SIGN_PASSWORD) args.push('/p', process.env.DLX_SIGN_PASSWORD);
  } else {
    args.push('/sha1', thumbprint, '/s', process.env.DLX_SIGN_STORE || 'My');
  }
  args.push(OUT);
  console.log('signing the desktop exe...');
  const result = spawnSync(signtool, args, { stdio: 'inherit' });
  if (result.status !== 0) console.error('code signing failed (the exe stays unsigned)');
  else console.log('desktop exe signed (SHA-256 Authenticode)');
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const temp = file + '.tmp';
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, file);
  return file;
}

async function extractOne(zip, name, target) {
  const index = await readLocalIndex(zip);
  if (!index) throw new Error(`Not a valid zip archive: ${zip}`);
  const entry = index.entries.find((item) => item.name === name);
  if (!entry) throw new Error(`Missing ${name} in ${zip}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = await extractEntry(zip, entry, target);
  if (!result.ok) throw new Error(`Could not extract ${name}: ${result.error || 'unknown error'}`);
}

function copyExtensionSource(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (DESKTOP_EXTENSION_GENERATED.has(entry.name) || /\.(pem|crx|xpi)$/i.test(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyExtensionSource(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

// The desktop build uses its own port range and native-host name so it can
// coexist with the installed downloadX app on the same PC.
function rewriteDesktopExtension(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDesktopExtension(file);
      continue;
    }
    if (!/\.(js|html|json)$/i.test(entry.name)) continue;
    let text = fs.readFileSync(file, 'utf8');
    text = text
      .replace(/com\.downloadx\.host/g, 'com.downloadx.desktop.host')
      .replace(/127\.0\.0\.1:9765/g, '127.0.0.1:9785')
      .replace(/\b9765\b/g, '9785')
      .replace(/\b9775\b/g, '9795');
    fs.writeFileSync(file, text);
  }
}

function buildDesktopExtension(buildDir) {
  const publicKey = fs.readFileSync(EXTENSION_PUBLIC_KEY, 'utf8').trim();
  if (!publicKey) throw new Error(`Missing the extension public key in ${path.relative(ROOT, EXTENSION_PUBLIC_KEY)}`);
  const publicDer = Buffer.from(publicKey, 'base64');
  const id = crx.extensionId(publicDer);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_SRC, 'manifest.json'), 'utf8'));

  const out = path.join(buildDir, 'extension');
  fs.rmSync(out, { recursive: true, force: true });
  copyExtensionSource(EXTENSION_SRC, path.join(out, 'chrome'));
  copyExtensionSource(EXTENSION_SRC, path.join(out, 'firefox'));
  rewriteDesktopExtension(path.join(out, 'chrome'));
  rewriteDesktopExtension(path.join(out, 'firefox'));

  fs.writeFileSync(
    path.join(out, 'chrome', 'manifest.json'),
    JSON.stringify(chromeManifest(sourceManifest, pkg.version, publicKey), null, 2) + '\n');
  fs.writeFileSync(
    path.join(out, 'firefox', 'manifest.json'),
    JSON.stringify(firefoxManifest(sourceManifest, pkg.version, DESKTOP_FIREFOX_ID), null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({
    id,
    version: pkg.version,
    firefoxId: DESKTOP_FIREFOX_ID,
    publicKey,
    chromeDir: 'chrome',
    firefoxDir: 'firefox',
  }, null, 2) + '\n');

  const zip = path.join(buildDir, 'desktop-extension.zip');
  fs.writeFileSync(zip, crx.zipStore(crx.readTree(out), new Date()));
  return { id, zip, version: pkg.version };
}

function buildNativeHost(csc, framework, buildDir) {
  const out = path.join(buildDir, 'downloadX-native-host.exe');
  const args = [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    '/out:' + out,
    '/reference:' + path.join(framework, 'System.dll'),
    '/reference:' + path.join(framework, 'System.Core.dll'),
    NATIVE_HOST_SRC,
  ];
  console.log('compiling the browser native host...');
  run(csc, args);
  if (!fs.existsSync(out)) throw new Error('The compiler did not produce the browser native host');
  return out;
}

async function ensureWebView2() {
  const nupkg = path.join(CACHE, `microsoft.web.webview2.${WV_VERSION}.nupkg`);
  await download(
    `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WV_VERSION}/microsoft.web.webview2.${WV_VERSION}.nupkg`,
    nupkg);

  const dir = path.join(CACHE, `webview2-${WV_VERSION}`);
  const files = {
    core: path.join(dir, 'Microsoft.Web.WebView2.Core.dll'),
    winforms: path.join(dir, 'Microsoft.Web.WebView2.WinForms.dll'),
    loader: path.join(dir, 'WebView2Loader.dll'),
  };
  if (!Object.values(files).every((file) => fs.existsSync(file) && fs.statSync(file).size > 0)) {
    console.log('extracting WebView2 SDK...');
    await extractOne(nupkg, 'lib/net462/Microsoft.Web.WebView2.Core.dll', files.core);
    await extractOne(nupkg, 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', files.winforms);
    await extractOne(nupkg, 'runtimes/win-x64/native/WebView2Loader.dll', files.loader);
  }
  return files;
}

function ensureServer() {
  if (REBUILD_SERVER || !fs.existsSync(SERVER_EXE)) {
    console.log('building the downloadX server executable...');
    run(process.execPath, [path.join(ROOT, 'installer', 'build-exe.mjs')]);
  }
  if (!fs.existsSync(SERVER_EXE)) throw new Error(`Missing ${path.relative(ROOT, SERVER_EXE)}`);
  if (!fs.existsSync(ICON)) {
    throw new Error(`Missing ${path.relative(ROOT, ICON)} — run npm run build:exe first`);
  }
}

function writeDesktopInfo(buildDir, buildId, nativeHostBuild, extensionId) {
  const infoFile = path.join(buildDir, 'DesktopInfo.cs');
  const versionParts = String(pkg.version).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  while (versionParts.length < 4) versionParts.push(0);
  const assemblyVersion = versionParts.slice(0, 4).join('.');
  fs.writeFileSync(infoFile, [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("downloadX")]',
    '[assembly: AssemblyDescription("downloadX desktop download manager")]',
    '[assembly: AssemblyProduct("downloadX")]',
    '[assembly: AssemblyCompany("downloadX")]',
    `[assembly: AssemblyVersion("${assemblyVersion}")]`,
    `[assembly: AssemblyFileVersion("${assemblyVersion}")]`,
    `[assembly: AssemblyInformationalVersion("${pkg.version}")]`,
    'namespace DownloadX { internal static class DesktopInfo { ' +
      `internal const string Version = ${JSON.stringify(pkg.version)}; ` +
      `internal const string BuildId = ${JSON.stringify(buildId)}; ` +
      `internal const string NativeHostBuild = ${JSON.stringify(nativeHostBuild)}; ` +
      `internal const string ExtensionId = ${JSON.stringify(extensionId)}; ` +
      `internal const string FirefoxId = ${JSON.stringify(DESKTOP_FIREFOX_ID)}; } }`,
    '',
  ].join('\n'));
  return infoFile;
}

function writeDesktopReadme(buildId) {
  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), [
    'downloadX desktop',
    '',
    'Double-click downloadX.exe to open the download manager in its own window.',
    'Closing the window keeps downloadX running in the notification area (system tray).',
    'Right-click the tray icon to reopen it or exit.',
    '',
    'Browser downloads: on first start downloadX asks to install the browser extension',
    'and prepares the Chrome/Edge/Firefox extension plus the native helper. Open',
    '"Browser integration..." from the tray (or Settings > Install browser extension)',
    'for the one-time Load unpacked step.',
    'Chrome and Edge do not allow a local extension to install silently; "Open with',
    'downloadX" in that window starts a separate profile with the extension already loaded.',
    '',
    'Requirements: Windows 10/11 and the Microsoft Edge WebView2 Runtime.',
    'Windows 11 includes it. If it is missing, the app shows a download link.',
    '',
    `First start unpacks the engine to %LOCALAPPDATA%\\downloadX\\app\\${pkg.version}-${buildId}.`,
    'Downloads and settings live in the data folder next to the exe (or in',
    '%LOCALAPPDATA%\\downloadX\\data when that folder is not writable).',
    '',
    'The executable is unsigned, so Windows SmartScreen may ask for confirmation',
    'the first time you run it.',
    '',
  ].join('\r\n'));
}

async function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  ensureServer();
  const webview = await ensureWebView2();
  let csc = process.env.DLX_FORCE_ROSLYN === '1' ? '' : findInstalledCsc();
  if (!csc) csc = await ensureRoslyn();

  const buildDir = path.join(OUT_DIR, '.build');
  fs.mkdirSync(buildDir, { recursive: true });
  const extension = buildDesktopExtension(buildDir);
  const buildId = crypto.createHash('sha256').update(fs.readFileSync(SERVER_EXE)).digest('hex').slice(0, 12);
  const framework = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const nativeHost = buildNativeHost(csc, framework, buildDir);
  const nativeHostBuild = crypto.createHash('sha256')
    .update(fs.readFileSync(nativeHost)).digest('hex').slice(0, 12);
  const infoFile = writeDesktopInfo(buildDir, buildId, nativeHostBuild, extension.id);

  const references = [
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Net.Http.dll',
    'System.Web.Extensions.dll',
    'System.Runtime.Serialization.dll',
    'System.Xml.dll',
    'System.IO.Compression.dll',
    'System.IO.Compression.FileSystem.dll',
  ].map((name) => path.join(framework, name));

  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/langversion:latest',
    '/main:DownloadX.Program',
    '/win32icon:' + ICON,
    '/win32manifest:' + path.join(ROOT, 'desktop', 'app.manifest'),
    '/out:' + OUT,
  ];
  for (const reference of references) args.push('/reference:' + reference);
  args.push('/reference:' + webview.core);
  args.push('/reference:' + webview.winforms);
  args.push('/resource:' + SERVER_EXE + ',downloadX-server.exe');
  args.push('/resource:' + webview.core + ',Microsoft.Web.WebView2.Core.dll');
  args.push('/resource:' + webview.winforms + ',Microsoft.Web.WebView2.WinForms.dll');
  args.push('/resource:' + webview.loader + ',WebView2Loader.dll');
  args.push('/resource:' + extension.zip + ',desktop-extension.zip');
  args.push('/resource:' + nativeHost + ',downloadX-native-host.exe');
  args.push(path.join(ROOT, 'desktop', 'BrowserIntegration.cs'));
  args.push(path.join(ROOT, 'desktop', 'BrowserSetupForm.cs'));
  args.push(path.join(ROOT, 'desktop', 'Program.cs'));
  args.push(infoFile);

  if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true });
  console.log('compiling the desktop window...');
  run(csc, args);

  if (!fs.existsSync(OUT)) throw new Error('The compiler did not produce ' + OUT);
  signExe();
  try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { }
  const sizeMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  writeDesktopReadme(buildId);
  console.log(`built ${path.relative(ROOT, OUT)} (${sizeMb} MB) with the download engine inside`);
  console.log('run it directly — it opens a native window, not a browser tab');
}

build().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
