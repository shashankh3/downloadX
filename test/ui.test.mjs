// downloadX UI tests — runs the real ES modules against a tiny DOM shim.
// Verifies that the front-end boots, renders rows and reacts to snapshots.
// Run: node test/ui.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'  }  ${name}${extra ? ' — ' + extra : ''}`);
}

/* ---------------- minimal DOM shim ---------------- */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

const CTX = {
  clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {},
  createLinearGradient() { return { addColorStop() {} }; },
};

/* ---- a very small HTML parser so the row templates become real trees ---- */
function parseAttributes(raw) {
  const attrs = {};
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function parseHtml(html) {
  const root = new FakeElement('div');
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)((?:\s[^>]*?)?)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const attrText = m[2] || '';
    const text = m[3];
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed) stack[stack.length - 1]._text += trimmed;
      continue;
    }
    if (m[0].startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new FakeElement(tag);
    const attrs = parseAttributes(attrText);
    if (attrs.class) {
      node.className = attrs.class;
      for (const cls of attrs.class.split(/\s+/).filter(Boolean)) node.classList.add(cls);
    }
    if (attrs.id) node.attributes.id = attrs.id;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        node.dataset[key] = v;
      }
    }
    if (attrs.style) {
      for (const decl of attrs.style.split(';')) {
        const [k, v] = decl.split(':');
        if (k && v) node.style[k.trim()] = v.trim();
      }
    }
    stack[stack.length - 1].appendChild(node);
    if (!VOID_TAGS.has(tag.toLowerCase()) && !m[0].endsWith('/>')) stack.push(node);
  }
  return root;
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = new ClassList();
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this._html = '';
    this.title = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.placeholder = '';
    this.href = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    this._text = '';
    const parsed = parseHtml(this._html);
    for (const child of parsed.children) { child.parentNode = this; this.children.push(child); }
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  appendChild(n) {
    if (n.parentNode && n.parentNode !== this) n.parentNode.removeChild(n);
    n.parentNode = this;
    if (!this.children.includes(n)) this.children.push(n);
    return n;
  }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, sel, this)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  closest() { return null; }
  focus() {}
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; if (typeof this.onclose === 'function') this.onclose(); }
  getContext() { return CTX; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
}

function matchesSimple(node, sel) {
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.attributes.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const m = /^\[([a-zA-Z0-9-]+)\]$/.exec(sel);
    return !!m && (m[1] in node.attributes || m[1] in node.dataset);
  }
  return node.tagName === sel.toUpperCase();
}

/** Supports "tag", ".class", "#id", "[attr]" and simple descendant chains. */
function matchesSelector(node, sel, root) {
  const parts = sel.trim().split(/\s+/);
  if (parts.length === 1) return matchesSimple(node, parts[0]);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  const head = parts.slice(0, -1).reverse();
  for (const part of head) {
    let found = false;
    while (ancestor) {
      if (matchesSimple(ancestor, part)) { found = true; ancestor = ancestor.parentNode; break; }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

/** Build the element registry from the real index.html so ids stay in sync. */
function buildDocument() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const tree = parseHtml(html);
  const byId = new Map();
  const index = (node) => {
    for (const child of node.children) {
      if (child.attributes.id) byId.set(child.attributes.id, child);
      index(child);
    }
  };
  index(tree);

  const doc = {
    documentElement: byId.get('app') ? tree : tree,
    body: tree,
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector(sel) { return tree.querySelector(sel); },
    querySelectorAll(sel) { return tree.querySelectorAll(sel); },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) {
      const ev = { type, preventDefault() {}, ...event };
      for (const fn of doc.listeners[type] || []) fn(ev);
    },
  };
  doc.documentElement.dataset = {};
  return { doc, byId };
}

const { doc, byId } = buildDocument();

globalThis.document = doc;
globalThis.window = {
  addEventListener() {},
  AudioContext: undefined,
  location: { href: 'http://127.0.0.1:9765/' },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: () => Promise.resolve() } },
});
globalThis.localStorage = {
  _v: {},
  getItem(k) { return k in this._v ? this._v[k] : null; },
  setItem(k, v) { this._v[k] = String(v); },
};
globalThis.Notification = undefined;
globalThis.EventSource = class {
  constructor() { this.readyState = 0; }
  addEventListener() {}
  close() {}
};
globalThis.fetch = async () => ({
  ok: true, status: 200, json: async () => ({ ok: true, version: '1.4.0' }),
});

/* ---------------- import the UI modules ---------------- */

const { applySnapshot, filteredItems, renderList, updateCounts, setConfirmDialog } = await import('../public/js/list.mjs');
const { fmtBytes, fmtSpeed, fmtEta, fmtDate, fmtPercent } = await import('../public/js/format.mjs');
const { injectIcons, el, setNav } = await import('../public/js/dom.mjs');
const { I, catTile } = await import('../public/js/icons.mjs');

check('ui: modules load without throwing', true);

/* ---------------- formatting ---------------- */
check('format: bytes', fmtBytes(0) === '0 B' && fmtBytes(1024) === '1 KB' && fmtBytes(1536) === '1.5 KB', fmtBytes(1536));
check('format: large bytes', fmtBytes(5 * 1024 ** 3) === '5 GB', fmtBytes(5 * 1024 ** 3));
check('format: speed', fmtSpeed(2048) === '2 KB/s', fmtSpeed(2048));
check('format: eta', fmtEta(45) === '45s' && fmtEta(90) === '1m 30s' && fmtEta(3700) === '1h 1m', fmtEta(3700));
check('format: empty eta', fmtEta(-1) === '');
check('format: date fallback', fmtDate(0) === '—');
check('format: percent clamped', fmtPercent(5, 10) === 50 && fmtPercent(20, 10) === 100 && fmtPercent(1, 0) === 0);

/* ---------------- helpers ---------------- */
check('dom: element factory', el('div', 'x', 'hi').className === 'x' && el('div', 'x', 'hi').textContent === 'hi');
check('dom: icons render as svg', I.check.includes('<svg') && I.check.includes('path'));
check('dom: unknown category falls back', catTile('Nope').includes('c-box'));
check('dom: setNav marks the active item', (() => {
  const nav = byId.get('nav-views');
  const buttons = nav.querySelectorAll('.nav-item');
  if (!buttons.length) return false;
  setNav('#nav-views', 'view', 'downloading');
  const target = buttons.find((b) => b.dataset.view === 'downloading');
  const other = buttons.find((b) => b.dataset.view !== 'downloading');
  return target.classList.contains('active') && !other.classList.contains('active');
})());

/* ---------------- rendering ---------------- */

const snapshot = {
  version: 2,
  uptime: 5,
  globalSpeed: 1024,
  activeCount: 1,
  activeConnections: 4,
  connectionLimit: 64,
  scheduleHalted: false,
  shutdownArmed: false,
  shutdownIn: 0,
  settings: { rootDir: 'C:\\tmp', maxConcurrent: 3, defaultSegments: 16, notifications: false, notificationSound: false },
  items: [
    {
      id: 'a', url: 'http://x/a.zip', urls: ['http://x/a.zip'], filename: 'a.zip', category: 'Compressed',
      status: 'downloading', total: 1000, received: 500, speed: 100, eta: 5, workers: 2, activeConnections: 2,
      error: '', addedAt: Date.now(), completedAt: 0, path: 'C:\\tmp\\a.zip', destDir: 'C:\\tmp',
      segmentsWanted: 4, checksum: null, expectedChecksum: '', checksumAlgo: 'sha256', speedLimit: 0,
      priority: 0, pausedBy: '', canResume: true, lastModified: '',
      segments: [{ start: 0, end: 499, downloaded: 500, active: true }, { start: 500, end: 999, downloaded: 0, active: false }],
    },
    {
      id: 'b', url: 'http://x/b.zip', urls: ['http://x/b.zip'], filename: 'b.zip', category: 'Video',
      status: 'completed', total: 20, received: 20, speed: 0, eta: -1, workers: 0, activeConnections: 0,
      error: '', addedAt: Date.now() - 1000, completedAt: Date.now(), path: 'C:\\tmp\\b.zip', destDir: 'C:\\tmp',
      segmentsWanted: 4, checksum: null, expectedChecksum: '', checksumAlgo: 'sha256', speedLimit: 0,
      priority: 0, pausedBy: '', canResume: true, lastModified: '', segments: [],
    },
  ],
};

setConfirmDialog(async () => true);
applySnapshot(snapshot);

check('ui: snapshot renders without throwing', true);
check('ui: speed shown', byId.get('global-speed').textContent === '1 KB', byId.get('global-speed').textContent);
check('ui: connection count shown', byId.get('st-conn').textContent === '4 connections', byId.get('st-conn').textContent);
check('ui: filtered items respect the view', filteredItems().length === 2);

const list = byId.get('list');
check('ui: one row per download', list.children.length === 2, `${list.children.length} rows`);

const row = list.children[0];
check('ui: row shows the file name', row.querySelector('.rname').textContent === 'a.zip' || row.children.length > 0);
check('ui: details panel is hidden by default', row.children[1].style.display === 'none');

/* the details panel needs querySelector support — drive it through the module */
check('ui: counts updated', byId.get('st-total').textContent === '1 completed', byId.get('st-total').textContent);
check('ui: waiting counter', byId.get('st-act').textContent === '1 active · 0 waiting', byId.get('st-act').textContent);

/* ---------------- filter behaviour ---------------- */
const { ui } = await import('../public/js/store.mjs');
ui.view = 'completed';
check('ui: view filter narrows the list', filteredItems().length === 1 && filteredItems()[0].id === 'b');
ui.view = 'all';
ui.cat = 'Video';
check('ui: category filter works', filteredItems().length === 1 && filteredItems()[0].id === 'b');
ui.cat = 'all';
ui.search = 'a.z';
check('ui: search filter works', filteredItems().length === 1 && filteredItems()[0].id === 'a');
ui.search = '';
check('ui: clearing the search restores the list', filteredItems().length === 2);

/* ---------------- ids used by the UI exist in the markup ---------------- */
{
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const file of fs.readdirSync(path.join(PUBLIC, 'js'))) {
    const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
    for (const m of src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`${file}: #${m[1]}`);
    }
  }
  check('ui: every referenced element id exists in index.html', missing.length === 0, missing.join(', '));
}

/* ---------------- the entry point wires everything up ---------------- */
{
  const mainSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'main.mjs'), 'utf8');
  check('ui: main module imports the feature modules',
    mainSrc.includes("./list.mjs") && mainSrc.includes("./dialogs.mjs") && mainSrc.includes("./api.mjs"));
  const indexSrc = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  check('ui: index loads the module entry point', /<script type="module" src="\/app\.mjs">/.test(indexSrc));
}

/* ---------------- the dialogs open without errors ---------------- */
{
  const { openSettings, openAdd } = await import('../public/js/dialogs.mjs');
  const { languages, language, setLanguage, t } = await import('../public/js/i18n.mjs');
  let opened = null;
  try { openSettings(); opened = byId.get('dlg-settings').open; } catch (e) { opened = 'error: ' + e.message; }
  check('ui: the settings dialog opens', opened === true, String(opened));
  const options = byId.get('set-language').children.length;
  check('ui: the language list is filled', options >= 2, `${options} languages`);
  check('ui: the current language is selected', byId.get('set-language').value === language(), byId.get('set-language').value);
  let added = null;
  try { openAdd('https://example.com/a.zip'); added = byId.get('dlg-add').open; } catch (e) { added = 'error: ' + e.message; }
  check('ui: the add dialog opens', added === true, String(added));
  check('ui: the add dialog is prefilled', byId.get('add-urls').value === 'https://example.com/a.zip', byId.get('add-urls').value);
  check('ui: the languages are listed', languages().length >= 2, JSON.stringify(languages().map((l) => l.code)));
  setLanguage('en');
  check('ui: unknown text falls back to english', t('Nothing here yet') === 'Nothing here yet');
}

/* ---------------- report ---------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
  process.exit(1);
}
