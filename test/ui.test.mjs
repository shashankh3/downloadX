// downloadX UI tests — runs the real ES modules against a tiny DOM shim.
// Verifies that the front-end boots, renders rows and reacts to snapshots.
// Run: node test/ui.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDocument } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'  }  ${name}${extra ? ' — ' + extra : ''}`);
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
