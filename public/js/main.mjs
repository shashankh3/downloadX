'use strict';
/*
 * Application bootstrap: wires the toolbar, navigation, keyboard shortcuts,
 * theme, drag & drop and the live update feed together.
 */
import { $, toast, confirmDlg, setNav, injectIcons } from './dom.mjs';
import { api, connect } from './api.mjs';
import { ui } from './store.mjs';
import { I } from './icons.mjs';
import { initLanguage, t } from './i18n.mjs';
import { applySnapshot, renderList, refreshViewTitle, setConfirmDialog } from './list.mjs';
import { openAdd, initAddDialog, initSettingsDialog } from './dialogs.mjs';

setConfirmDialog(confirmDlg);

/* ---------------- navigation & filters ---------------- */

$('#nav-views').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  ui.view = b.dataset.view;
  setNav('#nav-views', 'view', ui.view);
  refreshViewTitle();
  renderList();
});

$('#nav-cats').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  ui.cat = b.dataset.cat;
  setNav('#nav-cats', 'cat', ui.cat);
  refreshViewTitle();
  renderList();
});

$('#search').addEventListener('input', (e) => { ui.search = e.target.value; renderList(); });
$('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; renderList(); });

/* ---------------- toolbar ---------------- */

$('#btn-pause-all').addEventListener('click', () => api('/api/pause-all', { method: 'POST', body: {} }).then(() => toast('Paused all'), (e) => toast(e.message, 'err')));
$('#btn-resume-all').addEventListener('click', () => api('/api/resume-all', { method: 'POST', body: {} }).then(() => toast('Resumed all'), (e) => toast(e.message, 'err')));
$('#btn-cancel-shutdown').addEventListener('click', () => api('/api/cancel-shutdown', { method: 'POST', body: {} }).then(() => toast('Shutdown cancelled', 'ok'), (e) => toast(e.message, 'err')));
$('#btn-retry-failed').addEventListener('click', () => api('/api/retry-failed', { method: 'POST', body: {} }).then((r) => toast(`Retrying ${r.retried} download${r.retried === 1 ? '' : 's'}`, 'ok'), (e) => toast(e.message, 'err')));
$('#btn-clear').addEventListener('click', async () => {
  const deleteFiles = await confirmDlg('Clear finished?', 'Completed, failed and canceled items will be removed from the list. Files already downloaded are kept.', 'Clear');
  if (!deleteFiles) return;
  api('/api/clear-finished', { method: 'POST', body: { deleteFiles: false } })
    .then((r) => toast(`Removed ${r.removed} item${r.removed === 1 ? '' : 's'}`, 'ok'), (e) => toast(e.message, 'err'));
});
$('#btn-add').addEventListener('click', () => openAdd());
$('#btn-add-empty').addEventListener('click', () => openAdd());

/* ---------------- drag & drop links ---------------- */

let dragDepth = 0;
const hasLinks = (e) => {
  const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
  return types.includes('text/uri-list') || types.includes('text/plain');
};
window.addEventListener('dragenter', (e) => {
  if (!hasLinks(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropzone').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropzone').classList.add('hidden');
});
window.addEventListener('dragover', (e) => { if (hasLinks(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasLinks(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').classList.add('hidden');
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
  const urls = text.split(/[\r\n]+/).map((s) => s.trim()).filter((s) => /^(https?|ftps?):\/\//i.test(s));
  if (urls.length) openAdd(urls.join('\n'));
});

/* ---------------- keyboard & paste ---------------- */

const SHORTCUTS = [
  ['Ctrl / ⌘ + F', 'Focus the search field'],
  ['Ctrl / ⌘ + N', 'New download'],
  ['Ctrl / ⌘ + K', 'Open the download list'],
  ['Enter / Space', 'Expand the focused row'],
  ['?', 'Show this shortcut list'],
  ['Esc', 'Close the open dialog'],
  ['Ctrl / ⌘ + V', 'Paste a link anywhere to start a download'],
];

function openShortcuts() {
  const dlg = $('#dlg-shortcuts');
  const list = $('#shortcut-list');
  list.textContent = '';
  for (const [keys, what] of SHORTCUTS) {
    const row = document.createElement('li');
    const kbd = document.createElement('kbd');
    kbd.textContent = keys;
    const span = document.createElement('span');
    span.textContent = what;
    row.append(kbd, span);
    list.appendChild(row);
  }
  dlg.showModal();
}
$('#shortcuts-ok').addEventListener('click', () => $('#dlg-shortcuts').close());

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement && document.activeElement.tagName) || '');
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!$('#dlg-add').open) openAdd(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#list').focus(); return; }
  if (e.key === '?' && !inField) { e.preventDefault(); openShortcuts(); return; }
  if (e.key === 'Escape') {
    const dlg = $('dialog[open]');
    if (dlg) dlg.close();
  }
});

document.addEventListener('paste', (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if ($('#dlg-add').open) return;
  const text = (e.clipboardData || window.clipboardData).getData('text') || '';
  const url = text.split(/[\r\n]+/).map((s) => s.trim()).find((s) => /^(https?|ftps?):\/\//i.test(s));
  if (url) openAdd(url);
});

/* ---------------- theme ---------------- */

const THEME_KEY = 'dlx-theme';
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#btn-theme');
  if (!btn) return;
  btn.querySelector('.nav-ico').innerHTML = dark ? I.sun : I.moon;
  $('#theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
  btn.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* private mode */ }
applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  applyTheme(next);
});

/* ---------------- update check ---------------- */

async function checkUpdates() {
  try {
    const r = await api('/api/update-check');
    if (!r.updateAvailable || !r.latest) return;
    let dismissed = '';
    try { dismissed = localStorage.getItem('dlx-update-dismissed') || ''; } catch { /* private mode */ }
    if (dismissed === r.latest) return;
    $('#update-version').textContent = 'v' + r.latest;
    const link = $('#update-link');
    if (r.url) link.href = r.url;
    else link.hidden = true;
    $('#update-banner').classList.remove('hidden');
    $('#update-dismiss').onclick = () => {
      try { localStorage.setItem('dlx-update-dismissed', r.latest); } catch { /* private mode */ }
      $('#update-banner').classList.add('hidden');
    };
  } catch { /* update check unavailable */ }
}

/* ---------------- boot ---------------- */

initLanguage();
injectIcons();
initAddDialog();
initSettingsDialog();
setNav('#nav-views', 'view', ui.view);
setNav('#nav-cats', 'cat', ui.cat);
refreshViewTitle();
connect({
  onSnapshot: applySnapshot,
  onStatus: (s) => {
    if (s === 'reconnecting') {
      $('#st-engine').textContent = t('Reconnecting…');
      $('#st-dot').classList.remove('busy');
    }
  },
});
checkUpdates();
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h && h.version && $('#side-version')) $('#side-version').textContent = 'downloadX v' + h.version;
}).catch(() => {});
