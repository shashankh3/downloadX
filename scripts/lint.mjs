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

/* ---------------- 4. static style rules ---------------- */

/** Remove comments and string/template literals so token scans stay accurate. */
function stripLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const keepNewlines = (text) => text.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          // Keep template expressions: they contain real code.
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      const literal = src.slice(start, i);
      out += keepNewlines(literal).slice(0, -1) + '"';
      continue;
    }
    if (c === '/' && !isRegexStart(out)) {
      // division operator - keep as is
      out += c;
      i++;
      continue;
    }
    if (c === '/' && isRegexStart(out)) {
      // regular expression literal
      const start = i;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      const literal = src.slice(start, i);
      out += keepNewlines(literal).slice(0, -1) + 'R';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** True when a "/" starts a regular expression rather than a division. */
function isRegexStart(before) {
  const trimmed = before.replace(/\s+$/, '');
  if (!trimmed) return true;
  const last = trimmed[trimmed.length - 1];
  return '(,=:[!&|?{};+-*%^~<>'.includes(last);
}

/**
 * How many function bodies enclose each offset.
 * A brace belongs to a function when the code in front of it ends with ")" or
 * "=>" — that covers function declarations, methods and arrow functions while
 * leaving plain blocks (try, if, object literals) alone.
 */
function functionScopes(code) {
  const depths = new Int32Array(code.length + 1);
  const stack = [];
  let fnDepth = 0;
  for (let i = 0; i < code.length; i++) {
    depths[i] = fnDepth;
    const c = code[i];
    if (c === '{') {
      const trimmed = code.slice(Math.max(0, i - 200), i).replace(/\s+$/, '');
      const isFn = /\)$/.test(trimmed) || /=>$/.test(trimmed);
      stack.push(isFn);
      if (isFn) fnDepth++;
    } else if (c === '}') {
      const wasFn = stack.pop();
      if (wasFn) fnDepth--;
    }
  }
  depths[code.length] = fnDepth;
  return depths;
}

const warnings = [];

for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const code = stripLiterals(src);

  // `var` is not used anywhere in this project.
  const varRe = /(?<![\w$.])var\s/g;
  let m;
  while ((m = varRe.exec(code))) {
    const line = code.slice(0, m.index).split('\n').length;
    fail(rel, `use const/let instead of "var" (line ${line})`);
  }

  // Loose equality hides coercion bugs.
  const eqRe = /(?<![=!<>])(==|!=)(?!=)/g;
  while ((m = eqRe.exec(code))) {
    const after = code.slice(m.index, m.index + 12);
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/^(==|!=)\s*null\b/.test(after) || /null\s*(==|!=)$/.test(before)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    fail(rel, `use ${m[1] === '==' ? '===' : '!=='} instead of "${m[1]}" (line ${line})`);
  }

  // require() belongs in the module header, not inside a function.
  const depths = functionScopes(code);
  const reqRe = /require\s*\(/g;
  while ((m = reqRe.exec(code))) {
    if (depths[m.index] > 0) {
      const line = code.slice(0, m.index).split('\n').length;
      fail(rel, `require() inside a function body (line ${line})`);
    }
  }

  // Size budgets: reported, but they do not fail the run.
  const isTest = rel.startsWith('test' + path.sep);
  const lines = src.split(/\r?\n/).length;
  if (lines > 800) warnings.push(`${rel}: ${lines} lines (consider splitting it)`);

  // Long functions are hard to review. Test files are naturally long, so only
  // the shipped code is measured.
  if (!isTest) {
    const fnRe = /(^|\n)\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*|^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|^\s*get\s+[A-Za-z_$][\w$]*\s*\(/gm;
    const starts = [];
    while ((m = fnRe.exec(code))) starts.push(m.index);
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i];
      const to = i + 1 < starts.length ? starts[i + 1] : code.length;
      const bodyLines = code.slice(from, to).split('\n').length;
      if (bodyLines > 120) {
        const line = code.slice(0, from).split('\n').length;
        warnings.push(`${rel}: a function of about ${bodyLines} lines starts at line ${line}`);
      }
    }
  }
}

/* ---------------- 5. no unused imports ---------------- */
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

/* ---------------- 6. version consistency ---------------- */
{
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

/* ---------------- 7. UI entry points exist ---------------- */
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

/* ---------------- 8. no stray debug files ---------------- */
for (const file of allFiles) {
  const rel = path.relative(ROOT, file);
  if (/\.(orig|rej|bak|tmp)$/i.test(rel)) fail(rel, 'stray backup file');
  if (/\.dxpart$/i.test(rel)) fail(rel, 'leftover partial download');
}

/* ---------------- 9. every translatable string has a translation ---------------- */
{
  const { LANGS, DICT } = await import('../public/js/i18n.mjs');
  const keys = new Set();
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) keys.add(m[1]);
  const uiDir = path.join(ROOT, 'public', 'js');
  for (const file of fs.readdirSync(uiDir)) {
    if (!file.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(uiDir, file), 'utf8');
    for (const m of src.matchAll(/\bt\('([^']+)'\)/g)) keys.add(m[1]);
  }
  for (const code of Object.keys(LANGS)) {
    if (code === 'en') continue;
    const table = DICT[code] || {};
    const missing = [...keys].filter((k) => !(k in table));
    if (missing.length) {
      warnings.push(`${code}: ${missing.length} untranslated string(s), for example "${missing[0]}"`);
    } else {
      notes.push(`the ${code} translation covers all ${keys.size} strings`);
    }
  }
  for (const key of keys) {
    if (key.includes('{') && !/^\{[a-z]+\}/.test(key)) continue;
  }
}

/* ---------------- report ---------------- */
for (const n of notes) console.log('  ' + n);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log('  ! ' + w);
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nlint: no problems found');
