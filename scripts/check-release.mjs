// Release readiness check.
//
// Verifies that the published artefacts and the packaging manifests agree with
// the version in package.json and with the built EXE. Run before a release:
//
//   npm run build:exe && npm run package:manifests && npm run check:release
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(message) { problems.push(message); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
notes.push(`version ${VERSION}`);

/* ---------------- the version must be the same everywhere ---------------- */
{
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (lock.version !== VERSION) fail(`package-lock.json is ${lock.version}, expected ${VERSION}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (manifest.version !== VERSION) fail(`extension/manifest.json is ${manifest.version}, expected ${VERSION}`);
}

/* ---------------- the winget manifest ---------------- */
const wingetDir = path.join(ROOT, 'packaging', 'winget', 'manifests', 's', 'ShashankH3', 'DownloadX', VERSION);
if (!fs.existsSync(wingetDir)) {
  fail(`no winget manifest for ${VERSION} (expected ${path.relative(ROOT, wingetDir)})`);
} else {
  const installer = path.join(wingetDir, 'ShashankH3.DownloadX.installer.yaml');
  const locale = path.join(wingetDir, 'ShashankH3.DownloadX.locale.en-US.yaml');
  const base = path.join(wingetDir, 'ShashankH3.DownloadX.yaml');
  for (const file of [installer, locale, base]) {
    if (!fs.existsSync(file)) fail(`missing ${path.relative(ROOT, file)}`);
  }
  if (fs.existsSync(installer)) {
    const text = fs.readFileSync(installer, 'utf8');
    const url = /InstallerUrl:\s*(\S+)/.exec(text);
    const sha = /InstallerSha256:\s*(\S+)/.exec(text);
    const expectedUrl = `https://github.com/shashankh3/downloadX/releases/download/v${VERSION}/downloadX.exe`;
    if (!url || url[1] !== expectedUrl) fail(`winget InstallerUrl is ${url ? url[1] : 'missing'}, expected ${expectedUrl}`);
    if (!sha) fail('winget InstallerSha256 is missing');
    else {
      const exe = path.join(ROOT, 'dist', 'downloadX.exe');
      if (fs.existsSync(exe)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
        if (actual !== sha[1].toLowerCase()) {
          fail(`winget InstallerSha256 does not match dist/downloadX.exe\n`
            + `        manifest: ${sha[1].toLowerCase()}\n`
            + `        built:    ${actual}\n`
            + '        run "npm run package:manifests" after "npm run build:exe"');
        } else {
          notes.push('winget checksum matches the built EXE');
        }
      } else {
        notes.push('dist/downloadX.exe not built - checksum not verified');
      }
    }
  }
}

/* ---------------- the chocolatey package ---------------- */
{
  const install = path.join(ROOT, 'packaging', 'choco', 'tools', 'chocolateyinstall.ps1');
  const nuspec = path.join(ROOT, 'packaging', 'choco', 'downloadx.nuspec');
  for (const file of [install, nuspec]) {
    if (!fs.existsSync(file)) fail(`missing ${path.relative(ROOT, file)}`);
  }
  if (fs.existsSync(install)) {
    const text = fs.readFileSync(install, 'utf8');
    const url = /\$url\s*=\s*'([^']+)'/.exec(text);
    const sha = /\$checksum\s*=\s*'([^']+)'/.exec(text);
    const expectedUrl = `https://github.com/shashankh3/downloadX/releases/download/v${VERSION}/downloadX.exe`;
    if (!url || url[1] !== expectedUrl) fail(`chocolatey url is ${url ? url[1] : 'missing'}, expected ${expectedUrl}`);
    if (!sha) fail('chocolatey checksum is missing');
    else {
      const exe = path.join(ROOT, 'dist', 'downloadX.exe');
      if (fs.existsSync(exe)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
        if (actual !== sha[1].toLowerCase()) {
          fail(`chocolatey checksum does not match dist/downloadX.exe\n`
            + `        manifest: ${sha[1].toLowerCase()}\n`
            + `        built:    ${actual}\n`
            + '        run "npm run package:manifests" after "npm run build:exe"');
        } else {
          notes.push('chocolatey checksum matches the built EXE');
        }
      }
    }
  }
  if (fs.existsSync(nuspec)) {
    const text = fs.readFileSync(nuspec, 'utf8');
    const v = /<version>([^<]+)<\/version>/.exec(text);
    if (!v || v[1] !== VERSION) fail(`chocolatey nuspec is ${v ? v[1] : 'missing'}, expected ${VERSION}`);
  }
}

/* ---------------- the files the release needs ---------------- */
{
  const required = [
    ['LICENSE', 'the licence'],
    ['README.md', 'the readme'],
    ['CHANGELOG.md', 'the changelog'],
  ];
  for (const [file, what] of required) {
    if (!fs.existsSync(path.join(ROOT, file))) fail(`missing ${what} (${file})`);
  }
  const exe = path.join(ROOT, 'dist', 'downloadX.exe');
  if (!fs.existsSync(exe)) notes.push('dist/downloadX.exe is not built (needed for the release asset)');
}

/* ---------------- report ---------------- */
for (const n of notes) console.log('  ' + n);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nrelease check: ready');
