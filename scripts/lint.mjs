// downloadX lint — dependency-free project hygiene checks.
// Run: node scripts/lint.mjs   (or: npm run lint)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(file, message) {
  problems.push(`${path.relative(ROOT, path.join(ROOT, file))}: ${message}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT);
const jsFiles = allFiles.filter((f) => /\.m?js$/.test(f));

/* ---------------- 1. syntax ---------------- */
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    const msg = (res.stderr || '').split('\n').filter((l) => l.includes('Error')).slice(0, 2).join(' ').trim();
    fail(path.relative(ROOT, file), `syntax error — ${msg || 'node --check failed'}`);
  }
}
notes.push(`${jsFiles.length} JavaScript files parse cleanly`);

/* ---------------- 2. source hygiene ---------------- */
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/\s+$/.test(line)) fail(rel, `trailing whitespace on line ${i + 1}`);
    if (/\t/.test(line)) fail(rel, `tab character on line ${i + 1}`);
  });
  if (/\bdebugger\b\s*;/.test(src)) fail(rel, 'leftover `debugger` statement');
  if (/\bconsole\.log\(/.test(src) && rel.startsWith('lib' + path.sep)) {
    fail(rel, 'console.log in lib/ — use console.error for diagnostics');
  }
  if (/(^|[^.\w])it\.only\(|(^|[^.\w])describe\.only\(/.test(src)) fail(rel, 'focused test (.only) left in the suite');
  if (/\.only\(/.test(src) && rel.startsWith('test' + path.sep)) fail(rel, 'focused test (.only) left in the suite');
  const isCjs = file.endsWith('.js');
  if (isCjs && !/^'use strict';/m.test(src.split('\n').slice(0, 4).join('\n'))) {
    fail(rel, "missing 'use strict' header");
  }
}

/* ---------------- 3. requires resolve ---------------- */
for (const file of jsFiles) {
  if (file.endsWith('.mjs')) continue;
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), spec);
    const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
    if (!candidates.some((c) => fs.existsSync(c))) fail(rel, `require('${spec}') does not resolve`);
  }
}

/* ---------------- 4. no unused imports ---------------- */
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const names = [];
  const destructure = /const\s*\{([^}]+)\}\s*=\s*require\(/g;
  let m;
  while ((m = destructure.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (name) names.push(name);
    }
  }
  const plain = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/g;
  while ((m = plain.exec(src))) names.push(m[1]);
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  while ((m = importRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.push(name);
    }
  }
  const defaultImport = /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"]/g;
  while ((m = defaultImport.exec(src))) names.push(m[1]);

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const uses = src.match(new RegExp('(?<![\\w$])' + escaped + '(?![\\w$])', 'g')) || [];
    // One occurrence is the import itself.
    if (uses.length <= 1) fail(rel, `unused import "${name}"`);
  }
}

/* ---------------- 5. version consistency ---------------- */{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    fail('extension/manifest.json', `version ${manifest.version} does not match package.json ${pkg.version}`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (lock.version !== pkg.version) {
    fail('package-lock.json', `version ${lock.version} does not match package.json ${pkg.version}`);
  }
  notes.push(`version ${pkg.version} is consistent across package.json, lock file and extension`);
}

/* ---------------- 5. UI entry points exist ---------------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    const target = path.join(ROOT, 'public', src.replace(/^\//, ''));
    if (!fs.existsSync(target)) fail('public/index.html', `script ${src} does not exist`);
  }
  const styles = [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of styles) {
    if (/^https?:/i.test(href)) continue;
    const target = path.join(ROOT, 'public', href.replace(/^\//, ''));
    if (!fs.existsSync(target)) fail('public/index.html', `stylesheet ${href} does not exist`);
  }
  notes.push(`${scripts.length} script and ${styles.length} stylesheet references in index.html resolve`);
}

/* ---------------- 6. no stray debug files ---------------- */
for (const file of allFiles) {
  const rel = path.relative(ROOT, file);
  if (/\.(orig|rej|bak|tmp)$/i.test(rel)) fail(rel, 'stray backup file');
  if (/\.dxpart$/i.test(rel)) fail(rel, 'leftover partial download');
}

/* ---------------- report ---------------- */
for (const n of notes) console.log('  ' + n);
if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nlint: no problems found');
