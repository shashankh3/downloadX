// Builds dist/downloadX.exe — standalone Windows executable (no Node.js required).
// Run: npm run build:exe
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'downloadX.exe');
const ICO = path.join(DIST, 'downloadX.ico');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ---------------- icon rasterizer (bolt on a blue rounded tile) ---------------- */
const BOLT = [[13, 2], [4.5, 13.5], [11, 13.5], [9.5, 22], [19, 10], [12.5, 10]];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function insideRounded(x, y, size, r) {
  const dx = x - clamp(x, r, size - r);
  const dy = y - clamp(y, r, size - r);
  return dx * dx + dy * dy <= r * r;
}

function insidePoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function renderIcon(size) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const pad = size * 0.155;
  const scale = (size - pad * 2) / 24;
  const bolt = BOLT.map(([x, y]) => [pad + x * scale, pad + y * scale]);
  const c1 = [0x3d, 0xae, 0xff];
  const c2 = [0x08, 0x54, 0xd6];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0, gs = 0, bs = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = x + (sx + 0.5) / ss;
          const v = y + (sy + 0.5) / ss;
          if (!insideRounded(u, v, size, radius)) continue;
          const t = clamp((u + v) / (2 * size), 0, 1);
          let r = c1[0] + (c2[0] - c1[0]) * t;
          let g = c1[1] + (c2[1] - c1[1]) * t;
          let b = c1[2] + (c2[2] - c1[2]) * t;
          if (insidePoly(u, v, bolt)) { r = 255; g = 255; b = 255; }
          rs += r; gs += g; bs += b; hits++;
        }
      }
      const i = (y * size + x) * 4;
      if (hits) {
        out[i] = Math.round(rs / hits);
        out[i + 1] = Math.round(gs / hits);
        out[i + 2] = Math.round(bs / hits);
        out[i + 3] = Math.round((255 * hits) / (ss * ss));
      }
    }
  }
  return out;
}

function bmpIcon(size) {
  const px = renderIcon(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = px[src + 2];
      xor[dst + 1] = px[src + 1];
      xor[dst + 2] = px[src];
      xor[dst + 3] = px[src + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, xor, mask]);
}

function writeIcon(file) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, data: bmpIcon(size) }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  fs.writeFileSync(file, Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]));
}

/* ---------------- resources (applied to the base binary, before pkg) ----------------
 * pkg bakes absolute payload/prelude offsets into the base binary while packaging,
 * so patching resources after pkg would invalidate them. Instead we patch a copy of
 * the fetched base binary first and point pkg at it via PKG_NODE_PATH.
 */
const ResEdit = require('resedit');

/* ---------------- code signing (optional, env-gated) ---------------- */
function findSignTool() {
  const fromPath = spawnSync('where', ['signtool.exe'], { encoding: 'utf8' });
  if (fromPath.status === 0) {
    const found = String(fromPath.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found) return found;
  }
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  for (const root of roots) {
    const kits = path.join(root, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(kits)) continue;
    const versions = fs.readdirSync(kits).sort().reverse();
    for (const version of versions) {
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
  console.log('signing exe...');
  const result = spawnSync(signtool, args, { stdio: 'inherit' });
  if (result.status !== 0) console.error('code signing failed (exe stays unsigned)');
  else console.log('exe signed (SHA-256 Authenticode)');
}

function patchResources(bin, originalFilename) {
  const exe = ResEdit.NtExecutable.from(bin, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ICO));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map((i) => i.data));
  const [maj, min, pat] = String(pkgJson.version).split('.').map((n) => parseInt(n, 10) || 0);
  const vi = ResEdit.Resource.VersionInfo.create({
    lang: 1033,
    fixedInfo: {},
    strings: [{
      lang: 1033,
      codepage: 1200,
      values: {
        CompanyName: 'downloadX',
        FileDescription: 'downloadX - download manager',
        ProductName: 'downloadX',
        OriginalFilename: originalFilename,
        LegalCopyright: 'MIT License',
      },
    }],
  });
  vi.setFileVersion(maj, min, pat, 0);
  vi.setProductVersion(maj, min, pat, 0);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

/* ---------------- build ---------------- */
const pkgFetch = require('@yao-pkg/pkg-fetch');

async function build() {
  fs.mkdirSync(DIST, { recursive: true });
  writeIcon(ICO);
  console.log(`icon written: ${path.relative(ROOT, ICO)}`);

  const baseSrc = await pkgFetch.need({ nodeRange: 'node24', platform: 'win', arch: 'x64' });
  console.log(`base binary: ${baseSrc}`);
  const basePatched = path.join(DIST, '.base-win-x64.exe');
  fs.writeFileSync(basePatched, patchResources(fs.readFileSync(baseSrc), path.basename(OUT)));

  const pkgBin = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');
  const args = [pkgBin, '.', '--targets', 'node24-win-x64', '--compress', 'GZip', '--public', '--output', OUT];
  console.log('running pkg...');
  const buildResult = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PKG_NODE_PATH: basePatched },
  });
  fs.rmSync(basePatched, { force: true });
  if (buildResult.status !== 0 || !fs.existsSync(OUT)) {
    console.error('pkg build failed');
    process.exit(1);
  }

  const sizeMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`built ${path.relative(ROOT, OUT)} (${sizeMb} MB) with icon + version ${pkgJson.version}`);
  signExe();
}

build().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
