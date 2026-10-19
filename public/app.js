'use strict';
/* downloadX UI — light "day" + "Driver Booster" dark theme. Vanilla JS, live via SSE. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let state = { items: [], settings: {}, globalSpeed: 0, activeCount: 0, activeConnections: 0 };
const ui = { view: 'all', cat: 'all', search: '', sort: 'status', expanded: new Set() };
const rowMap = new Map();
const speedHistory = [];

/* ================= icon set (lucide-style strokes) ================= */
const S = (inner, fill = false) =>
  `<svg viewBox="0 0 24 24" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${inner}</svg>`;
const I = {
  bolt:   S('<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/>', true),
  plus:   S('<path d="M12 5v14M5 12h14"/>'),
  pause:  S('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  play:   S('<path d="M7 4l13 8-13 8z"/>', true),
  stop:   S('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  gear:   S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  all:    S('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  down:   S('<circle cx="12" cy="12" r="10"/><path d="M12 8v8m-4-4 4 4 4-4"/>'),
  clock:  S('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  check:  S('<circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  xcirc:  S('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>'),
  folder: S('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  program:S('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  archive:S('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
  film:   S('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M7 12h10"/>'),
  music:  S('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  doc:    S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>'),
  image:  S('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.35-4.35L6 21"/>'),
  box:    S('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>'),
  trash:  S('<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>'),
  link:   S('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  retry:  S('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  alert:  S('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>'),
  download:S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
  copy:   S('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  external:S('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  sun:    S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'),
  moon:   S('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
};

const CATS = {
  Programs:   { cls: 'c-program', ico: 'program' },
  Compressed: { cls: 'c-archive', ico: 'archive' },
  Video:      { cls: 'c-video',   ico: 'film' },
  Music:      { cls: 'c-music',   ico: 'music' },
  Documents:  { cls: 'c-doc',     ico: 'doc' },
  Images:     { cls: 'c-image',   ico: 'image' },
  Others:     { cls: 'c-box',     ico: 'box' },
};
const catTile = (cat) => {
  const c = CATS[cat] || CATS.Others;
  return `<div class="ctile ${c.cls}">${I[c.ico]}</div>`;
};

/* inject static icons into placeholder spans */
$$('[data-ico]').forEach((n) => { n.innerHTML = I[n.dataset.ico] || ''; });

/* ================= helpers ================= */
function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}
const fmtSpeed = (n) => fmtBytes(n) + '/s';
function fmtEta(s) {
  if (s == null || s < 0) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const STATUS_LABEL = {
  queued: 'Waiting', probing: 'Checking…', downloading: 'Downloading',
  paused: 'Paused', completed: 'Done', failed: 'Failed', canceled: 'Canceled',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function toast(msg, type = '') {
  const iconName = type === 'ok' ? 'check' : type === 'err' ? 'xcirc' : 'bolt';
  const t = el('div', 'toast ' + type);
  t.innerHTML = `<span class="t-ico">${I[iconName]}</span><span></span>`;
  t.lastChild.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}

function confirmDlg(title, text, yesLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yesLabel;
    dlg.showModal();
    const done = (v) => { dlg.close(); resolve(v); };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    dlg.onclose = () => resolve(false);
  });
}

/* ================= SSE ================= */
let retryDelay = 1000;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    retryDelay = 1000;
    try { applySnapshot(JSON.parse(e.data)); } catch { /* partial frame */ }
  });
  es.onerror = () => {
    $('#st-engine').textContent = 'Reconnecting…';
    $('#st-dot').classList.remove('busy');
    es.close();
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

function applySnapshot(snap) {
  state = snap;
  trackFinished(snap.items || []);
  updateHeader();
  updateCounts();
  renderList();
  const armed = !!state.shutdownArmed;
  $('#shutdown-banner').classList.toggle('hidden', !armed);
  if (armed) $('#shutdown-count').textContent = state.shutdownIn || 60;
}

/* ================= completion notifications ================= */
const prevStatus = new Map();
let audioCtx = null;

function playDoneSound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1174.66, 0.12]].forEach(([freq, dt]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.18);
    });
  } catch { /* audio unavailable */ }
}

function desktopNotify(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/favicon.svg', tag: 'dlx-finished' });
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } };
  } catch { /* notifications blocked */ }
}

function trackFinished(items) {
  const finished = [];
  const failed = [];
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    const before = prevStatus.get(it.id);
    if (before && before !== it.status) {
      if (it.status === 'completed') finished.push(it);
      else if (it.status === 'failed') failed.push(it);
    }
    prevStatus.set(it.id, it.status);
  }
  for (const id of prevStatus.keys()) if (!seen.has(id)) prevStatus.delete(id);
  if (!finished.length && !failed.length) return;

  const settings = state.settings || {};
  const sr = $('#sr-status');
  if (finished.length) {
    const msg = finished.length === 1 ? `${finished[0].filename} finished downloading.` : `${finished.length} downloads finished.`;
    toast(finished.length === 1 ? `Done: ${finished[0].filename}` : `${finished.length} downloads finished`, 'ok');
    if (sr) sr.textContent = msg;
    if (settings.notifications !== false) {
      desktopNotify('downloadX', finished.length === 1 ? `${finished[0].filename} finished downloading.` : `${finished.length} downloads finished.`);
    }
    if (settings.notificationSound !== false) playDoneSound();
  }
  if (failed.length) {
    const msg = failed.length === 1 ? `${failed[0].filename} failed: ${failed[0].error || 'unknown error'}` : `${failed.length} downloads failed.`;
    toast(failed.length === 1 ? `Failed: ${failed[0].filename}` : `${failed.length} downloads failed`, 'err');
    if (sr) sr.textContent = msg;
    if (settings.notifications !== false) desktopNotify('downloadX', msg);
  }
}

/* ================= header / spark / status bar ================= */
function updateHeader() {
  $('#global-speed').textContent = fmtBytes(state.globalSpeed || 0);
  const now = Date.now();
  speedHistory.push({ t: now, v: state.globalSpeed || 0 });
  while (speedHistory.length && now - speedHistory[0].t > 60000) speedHistory.shift();
  drawSpark();
  const busy = (state.activeCount || 0) > 0;
  $('#st-dot').classList.toggle('busy', busy);
  $('#st-engine').textContent = busy
    ? `Transferring — ${state.activeConnections || 0} connection${state.activeConnections === 1 ? '' : 's'}`
    : 'Engine ready';
  $('#st-conn').textContent = `${state.activeConnections || 0} connection${state.activeConnections === 1 ? '' : 's'}`;
}

function drawSpark() {
  const c = $('#spark'), ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (speedHistory.length < 2) return;
  const max = Math.max(1024, ...speedHistory.map((p) => p.v));
  const t0 = speedHistory[0].t, t1 = Math.max(t0 + 1, speedHistory[speedHistory.length - 1].t);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(109,124,255,.95)');
  grad.addColorStop(1, 'rgba(45,211,255,.95)');
  ctx.beginPath();
  speedHistory.forEach((p, i) => {
    const x = ((p.t - t0) / (t1 - t0)) * w;
    const y = h - 3 - (p.v / max) * (h - 7);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = 'rgba(45,211,255,.09)';
  ctx.fill();
}

const VIEW_LABEL = {
  all: 'All downloads', downloading: 'Downloading', waiting: 'Waiting',
  completed: 'Completed', failed: 'Failed',
};

function updateCounts() {
  const vc = { all: state.items.length, downloading: 0, waiting: 0, completed: 0, failed: 0 };
  const cc = { all: state.items.length };
  for (const it of state.items) {
    if (it.status === 'downloading' || it.status === 'probing') vc.downloading++;
    else if (it.status === 'queued' || it.status === 'paused') vc.waiting++;
    else if (it.status === 'completed') vc.completed++;
    else if (it.status === 'failed') vc.failed++;
    cc[it.category] = (cc[it.category] || 0) + 1;
  }
  $$('[data-count]').forEach((n) => {
    const [kind, key] = [n.dataset.count.split('-')[0], n.dataset.count.split('-').slice(1).join('-')];
    n.textContent = (kind === 'view' ? vc[key] : cc[key]) || 0;
  });
  const shown = filteredItems().length;
  $('#view-sub').textContent = `${shown} item${shown === 1 ? '' : 's'}`;
  const waiting = vc.waiting;
  $('#st-act').textContent = `${state.activeCount || 0} active · ${waiting} waiting`;
  $('#st-total').textContent = `${vc.completed} completed`;
  $('#btn-retry-failed').hidden = vc.failed === 0;
  $('#btn-clear').hidden = (vc.completed + vc.failed) === 0;
}

/* ================= list rendering ================= */
function filteredItems() {
  const q = ui.search.toLowerCase();
  const statusOrder = { downloading: 0, probing: 0, queued: 1, paused: 2, completed: 3, failed: 4, canceled: 5 };
  const items = state.items.filter((it) => {
    if (ui.view === 'downloading' && !(it.status === 'downloading' || it.status === 'probing')) return false;
    if (ui.view === 'waiting' && !(it.status === 'queued' || it.status === 'paused')) return false;
    if (ui.view === 'completed' && it.status !== 'completed') return false;
    if (ui.view === 'failed' && !(it.status === 'failed' || it.status === 'canceled')) return false;
    if (ui.cat !== 'all' && it.category !== ui.cat) return false;
    if (q && !(it.filename.toLowerCase().includes(q) || it.url.toLowerCase().includes(q))) return false;
    return true;
  });
  const cmp = {
    status: (a, b) => (statusOrder[a.status] - statusOrder[b.status]) || (b.addedAt - a.addedAt),
    date: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }),
    size: (a, b) => (b.total || 0) - (a.total || 0),
    speed: (a, b) => (b.speed || 0) - (a.speed || 0),
  };
  return items.sort(cmp[ui.sort] || cmp.status);
}

function renderList() {
  const list = $('#list');
  const items = filteredItems();
  $('#empty').classList.toggle('hidden', items.length > 0);
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    if (!rowMap.has(it.id)) rowMap.set(it.id, buildRow());
    const row = rowMap.get(it.id);
    if (!row.el.isConnected) list.appendChild(row.el);
    updateRow(row, it);
  }
  for (const [id, row] of rowMap) {
    if (!seen.has(id)) { row.el.remove(); rowMap.delete(id); }
  }
  for (const it of items) list.appendChild(rowMap.get(it.id).el);
}

function buildRow() {
  const el_ = el('div', 'row');
  el_.innerHTML = `
    <div class="row-main">
      <div class="tilebox"></div>
      <div class="rinfo">
        <div class="rname"></div>
        <div class="rmeta">
          <span class="mstat"></span><span class="msize"></span>
          <span class="mspeed"></span><span class="meta"></span><span class="merr"></span>
        </div>
        <div class="bar-wrap"><div class="segbar"></div></div>
      </div>
      <div class="rside"><div class="pct"></div><div class="raction"></div></div>
    </div>
    <div class="rdetails" style="display:none"></div>`;
  const q = (s) => el_.querySelector(s);
  const row = {
    el: el_, tilebox: q('.tilebox'), rname: q('.rname'), mstat: q('.mstat'), msize: q('.msize'),
    mspeed: q('.mspeed'), meta: q('.meta'), merr: q('.merr'),
    barWrap: q('.bar-wrap'), segbar: q('.segbar'), pct: q('.pct'),
    actions: q('.raction'), details: q('.rdetails'), actionsFor: '', detailsBuilt: false,
  };
  const main = el_.querySelector('.row-main');
  main.tabIndex = 0;
  main.setAttribute('role', 'button');
  main.setAttribute('aria-expanded', 'false');
  main.addEventListener('click', (e) => {
    if (e.target.closest('.rbtn')) return;
    toggleDetails(el_.dataset.id);
  });
  main.addEventListener('keydown', (e) => {
    if (e.target.closest('.rbtn')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDetails(el_.dataset.id);
    }
  });
  return row;
}

function toggleDetails(id) {
  if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id);
  const it = state.items.find((i) => i.id === id);
  const row = rowMap.get(id);
  if (it && row) { row.detailsBuilt = false; updateRow(row, it); }
}

function updateRow(row, it) {
  row.el.dataset.id = it.id;
  row.el.className = 'row ' + it.status;
  row.tilebox.innerHTML = catTile(it.category);
  row.rname.textContent = it.filename;
  row.rname.title = it.filename;
  const pctVal = it.total > 0 ? Math.min(100, (it.received / it.total) * 100) : 0;
  row.pct.textContent = it.status === 'completed' ? '✓'
    : it.status === 'failed' ? '!' : (pctVal > 0 ? pctVal.toFixed(pctVal >= 10 ? 0 : 1) + '%' : '');

  row.mstat.innerHTML = `<span class="dot ${it.status}"></span><span>${STATUS_LABEL[it.status] || it.status}</span>`;
  if (it.stream) {
    row.msize.textContent = `${it.received} / ${it.total} parts`;
    row.mspeed.textContent = it.status === 'downloading' ? fmtSpeed(it.speed) : '';
    row.meta.textContent = it.status === 'downloading'
      ? (it.stream === 'dash' ? 'DASH stream' : 'HLS stream')
      : '';
  } else {
    row.msize.textContent = it.total > 0 ? `${fmtBytes(it.received)} / ${fmtBytes(it.total)}` : fmtBytes(it.received);
    row.mspeed.textContent = it.status === 'downloading' ? fmtSpeed(it.speed) : '';
    row.meta.textContent = it.status === 'downloading' && it.eta >= 0 ? 'ETA ' + fmtEta(it.eta) : '';
  }
  row.merr.textContent = it.error || '';
  row.merr.title = it.error || '';

  renderSegbar(row, it);

  if (row.actionsFor !== it.status) {
    row.actionsFor = it.status;
    row.actions.innerHTML = '';
    const add = (icon, title, fn, danger) => {
      const b = el('button', 'rbtn' + (danger ? ' danger' : ''));
      b.innerHTML = I[icon];
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      row.actions.appendChild(b);
    };
    const act = (a) => api(`/api/downloads/${it.id}/${a}`, { method: 'POST', body: {} }).catch((e) => toast(e.message, 'err'));
    const copyUrl = () => navigator.clipboard.writeText(it.url).then(() => toast('URL copied', 'ok'), () => {});
    if (['downloading', 'probing', 'queued'].includes(it.status)) {
      add('pause', 'Pause', () => act('pause'));
      add('stop', 'Stop & remove', async () => {
        if (await confirmDlg('Stop download?', `"${it.filename}" will be stopped and its partial data removed.`, 'Stop')) {
          api(`/api/downloads/${it.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
        }
      }, true);
    } else if (it.status === 'paused') {
      add('play', 'Resume', () => act('resume'));
      add('stop', 'Remove', async () => {
        if (await confirmDlg('Remove download?', `"${it.filename}" and its partial data will be removed.`, 'Remove')) {
          api(`/api/downloads/${it.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
        }
      }, true);
    } else if (it.status === 'failed' || it.status === 'canceled') {
      add('retry', 'Retry', () => act('retry'));
      add('stop', 'Remove from list', () => api(`/api/downloads/${it.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err')), true);
    } else if (it.status === 'completed') {
      add('folder', 'Open folder', () => act('open-folder'));
      add('doc', 'Open file', () => act('open-file'));
      add('retry', 'Download again', async () => {
        if (await confirmDlg('Download again?', `"${it.filename}" will be downloaded from scratch and the existing file kept if the name is taken.`, 'Download')) {
          api(`/api/downloads/${it.id}/restart`, { method: 'POST', body: {} }).catch((e) => toast(e.message, 'err'));
        }
      });
      add('trash', 'Delete file', async () => {
        if (await confirmDlg('Delete file?', `"${it.filename}" will be permanently deleted from disk.`)) {
          api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).then(() => toast('Deleted', 'ok'), (e) => toast(e.message, 'err'));
        }
      }, true);
    }
    add('link', 'Copy URL', copyUrl);
  }

  const expanded = ui.expanded.has(it.id);
  row.details.style.display = expanded ? 'grid' : 'none';
  const main = row.el.querySelector('.row-main');
  if (main) main.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (expanded) renderDetails(row, it);
  else row.detailsBuilt = false;
}

function renderSegbar(row, it) {
  const bar = row.segbar;
  if (it.stream) {
    row.barWrap.classList.remove('indeterminate');
    if (bar.children.length !== 1) {
      bar.textContent = '';
      const s = el('div', 'seg');
      s.appendChild(el('div', 'fill'));
      bar.appendChild(s);
    }
    const segEl = bar.firstChild;
    const pct = it.total > 0 ? Math.min(100, (it.received / it.total) * 100) : 0;
    segEl.classList.toggle('done', it.status === 'completed');
    segEl.classList.toggle('active', it.status === 'downloading');
    segEl.firstChild.style.width = it.status === 'completed' ? '100%' : pct + '%';
    return;
  }
  const segs = it.segments || [];
  const indeterminate = it.total <= 0 && ['downloading', 'queued', 'paused', 'probing'].includes(it.status);
  row.barWrap.classList.toggle('indeterminate', indeterminate && segs.length === 0);
  const want = Math.min(segs.length, 64);
  while (bar.children.length > want) bar.lastChild.remove();
  while (bar.children.length < want) { const s = el('div', 'seg'); s.appendChild(el('div', 'fill')); bar.appendChild(s); }
  segs.slice(0, 64).forEach((s, i) => {
    const segEl = bar.children[i];
    const span = s.end >= 0 ? s.end - s.start + 1 : Math.max(1, it.total - s.start);
    const done = s.end >= 0 ? s.downloaded >= s.end - s.start + 1 : false;
    segEl.style.flexGrow = Math.max(1, Math.round(span / Math.max(1, it.total / 64)));
    segEl.classList.toggle('done', done || it.status === 'completed');
    segEl.classList.toggle('active', !!s.active && !done);
    segEl.firstChild.style.width = (it.status === 'completed' || done) ? '100%'
      : span > 0 ? Math.min(100, (s.downloaded / span) * 100) + '%' : '0%';
  });
}

function renderDetails(row, it) {
  const d = row.details;
  const segList = it.segments || [];
  const sig = [it.id, it.status, it.error, it.expectedChecksum, it.checksumAlgo, it.speedLimit,
    it.checksum && it.checksum.at, segList.length, it.segmentsWanted, it.completedAt,
    it.activeConnections, it.stream, it.received, it.total].join('|');
  if (row.detailsSig === sig && d.childElementCount) return;
  if (row.detailsBuilt && d.contains(document.activeElement)) return;
  row.detailsBuilt = true;
  row.detailsSig = sig;
  const dl = (label, valueNode) => {
    const dt = el('dt', null, label);
    const dd = el('dd');
    if (typeof valueNode === 'string') dd.textContent = valueNode;
    else dd.append(...(Array.isArray(valueNode) ? valueNode : [valueNode]));
    d.append(dt, dd);
  };
  d.innerHTML = '';
  dl('URL', el('span', 'mono', it.url));
  if (it.urls && it.urls.length > 1) dl('Mirrors', it.urls.slice(1).join(', '));
  dl('Saved to', el('span', 'mono', it.path));
  if (it.stream) {
    dl('Media stream', `${it.stream.toUpperCase()} — ${it.received} of ${it.total} parts`);
    dl('Connections', '1 (sequential stream)');
    if (it.stream === 'dash') dl('Audio track', el('span', 'mono', it.path.replace(/\.mp4$/i, '.audio.m4a')));
  } else {
    const segCount = segList.length;
    dl('Connections', `${it.activeConnections || 0} active / ${segCount} segment${segCount === 1 ? '' : 's'} (max ${it.segmentsWanted})`);
  }
  dl('Resumable', it.canResume ? 'Yes' : 'No — single stream');
  if (it.expectedChecksum) dl('Expected hash', el('span', 'mono', it.expectedChecksum));
  if (it.error) dl('Error', el('span', 'mono', it.error));

  const limitBox = el('div', 'checksum-form');
  const limitInput = el('input', 'input');
  limitInput.type = 'number'; limitInput.min = '0';
  limitInput.placeholder = 'Speed limit KB/s (0 = none)';
  limitInput.value = it.speedLimit > 0 ? Math.round(it.speedLimit / 1024) : '';
  const limitBtn = el('button', 'btn ghost', 'Set');
  limitBtn.onclick = () => api(`/api/downloads/${it.id}/limit`, { method: 'POST', body: { kbs: parseInt(limitInput.value, 10) || 0 } })
    .then(() => toast('Speed limit updated', 'ok'), (e) => toast(e.message, 'err'));
  limitBox.append(limitInput, limitBtn);

  const box = el('div', 'checksum-form');
  const algo = el('select', 'input select');
  for (const a of ['sha256', 'sha1', 'md5', 'sha512']) {
    const o = el('option', null, a); o.value = a; algo.appendChild(o);
  }
  if (it.checksumAlgo) algo.value = it.checksumAlgo;
  const hashInput = el('input', 'input');
  hashInput.placeholder = 'Expected checksum (verify integrity)';
  hashInput.value = it.expectedChecksum || '';
  const btn = el('button', 'btn ghost', 'Verify');
  btn.onclick = () => {
    if (!hashInput.value.trim()) return toast('Paste the expected checksum first', 'err');
    btn.disabled = true; btn.textContent = 'Verifying…';
    api(`/api/downloads/${it.id}/verify`, { method: 'POST', body: { algo: algo.value, expected: hashInput.value.trim() } })
      .then((r) => toast(r.ok ? 'Checksum OK ✓' : 'CHECKSUM MISMATCH!', r.ok ? 'ok' : 'err'))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Verify'; });
  };
  box.append(algo, hashInput, btn);
  dl('Integrity', box);
  dl('Limit', limitBox);

  if (it.checksum) {
    const b = el('span', 'badge ' + (it.checksum.ok ? 'ok' : 'bad'),
      it.checksum.ok ? 'verified ✓' : 'MISMATCH');
    const note = el('span', 'mono', `${it.checksum.algo}: ${it.checksum.actual || it.checksum.error || ''}`);
    dl('Result', [b, note]);
  }
  dl('Added', new Date(it.addedAt).toLocaleString());
  if (it.completedAt) dl('Completed', new Date(it.completedAt).toLocaleString());
}

/* ================= add dialog ================= */
function openAdd(prefill) {
  const dlg = $('#dlg-add');
  $('#add-urls').value = prefill || '';
  $('#add-filename').value = '';
  $('#add-preview').textContent = '';
  $('#add-category').value = 'auto';
  const segs = (state && state.settings && state.settings.defaultSegments) || 16;
  $('#add-segments').value = segs;
  $('#add-segv').textContent = segs;
  $('#add-limit').value = '0';
  $('#add-mirrors').value = '';
  $('#add-referer').value = '';
  $('#add-cookies').value = '';
  $('#add-username').value = '';
  $('#add-password').value = '';
  $('#add-proxy').value = '';
  $('#add-headers').value = '';
  $('#add-checksum').value = '';
  $('#add-dir').value = '';
  $('#add-paused').checked = false;
  const adv = dlg.querySelector('details.advanced');
  if (adv) adv.open = false;
  dlg.showModal();
  $('#add-urls').focus();
}

let expandTimer = null;
$('#add-urls').addEventListener('input', () => {
  clearTimeout(expandTimer);
  expandTimer = setTimeout(async () => {
    const text = $('#add-urls').value.trim();
    if (!text) { $('#add-preview').textContent = ''; return; }
    try {
      const r = await api('/api/expand', { method: 'POST', body: { text } });
      if (r.errors && r.errors.length && !r.urls.length) {
        $('#add-preview').textContent = r.errors[0].error;
        return;
      }
      $('#add-preview').textContent = r.urls.length > 1 ? `Will add ${r.urls.length} downloads` : '';
    } catch { /* ignore */ }
  }, 350);
});
$('#add-segments').addEventListener('input', (e) => $('#add-segv').textContent = e.target.value);

$('#add-ok').addEventListener('click', async () => {
  const text = $('#add-urls').value.trim();
  if (!text) return toast('Enter at least one URL', 'err');
  const body = {
    text,
    filename: $('#add-filename').value.trim() || undefined,
    category: $('#add-category').value,
    segments: parseInt($('#add-segments').value, 10) || 16,
    speedLimitKBs: parseInt($('#add-limit').value, 10) || 0,
    mirrors: $('#add-mirrors').value.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean),
    referer: $('#add-referer').value.trim() || undefined,
    cookies: $('#add-cookies').value.trim() || undefined,
    username: $('#add-username').value.trim() || undefined,
    password: $('#add-password').value || undefined,
    proxy: $('#add-proxy').value.trim() || undefined,
    headers: (() => {
      const out = {};
      for (const line of $('#add-headers').value.split(/[\r\n]+/)) {
        const m = /^([^:]+):\s*(.+)$/.exec(line.trim());
        if (m) out[m[1].trim()] = m[2].trim();
      }
      return Object.keys(out).length ? out : undefined;
    })(),
    expectedChecksum: $('#add-checksum').value.trim() || undefined,
    dir: $('#add-dir').value.trim() || undefined,
    startedPaused: $('#add-paused').checked,
  };
  const btn = $('#add-ok');
  btn.disabled = true;
  try {
    const r = await api('/api/downloads', { method: 'POST', body });
    $('#dlg-add').close();
    toast(r.batch ? `Added ${r.batch.length} downloads` : `Added: ${r.filename || 'download started'}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; }
});
$('#add-cancel').addEventListener('click', () => $('#dlg-add').close());
$('#btn-add').addEventListener('click', () => openAdd());
$('#btn-add-empty').addEventListener('click', () => openAdd());

/* ================= settings ================= */
function openSettings() {
  const s = state.settings;
  $('#set-root').value = s.rootDir || '';
  $('#set-concurrent').value = s.maxConcurrent ?? 3;
  $('#set-segments').value = s.defaultSegments ?? 16;
  $('#set-globallimit').value = s.globalSpeedLimit ? Math.round(s.globalSpeedLimit / 1024) : 0;
  $('#set-proxy').value = s.proxy || '';
  $('#set-organize').checked = !!s.organizeByCategory;
  $('#set-invalid-tls').checked = !!s.allowInvalidTls;
  $('#set-update-url').value = s.updateUrl || '';
  $('#set-sched-enabled').checked = !!s.scheduleEnabled;
  $('#set-sched-from').value = s.scheduleFrom || '23:00';
  $('#set-sched-to').value = s.scheduleTo || '07:00';
  $('#set-shutdown').checked = !!s.shutdownWhenDone;
  $('#set-notify').checked = s.notifications !== false;
  $('#set-notify-sound').checked = s.notificationSound !== false;
  $('#dlg-settings').showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-ok').addEventListener('click', async () => {
  const body = {
    rootDir: $('#set-root').value.trim(),
    maxConcurrent: parseInt($('#set-concurrent').value, 10) || 3,
    defaultSegments: parseInt($('#set-segments').value, 10) || 16,
    globalSpeedLimit: (parseInt($('#set-globallimit').value, 10) || 0) * 1024,
    proxy: $('#set-proxy').value.trim(),
    organizeByCategory: $('#set-organize').checked,
    allowInvalidTls: $('#set-invalid-tls').checked,
    updateUrl: $('#set-update-url').value.trim(),
    scheduleEnabled: $('#set-sched-enabled').checked,
    scheduleFrom: $('#set-sched-from').value,
    scheduleTo: $('#set-sched-to').value,
    shutdownWhenDone: $('#set-shutdown').checked,
    notifications: $('#set-notify').checked,
    notificationSound: $('#set-notify-sound').checked,
  };
  try {
    if (body.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    await api('/api/settings', { method: 'PUT', body });
    $('#dlg-settings').close();
    toast('Settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
$('#set-cancel').addEventListener('click', () => $('#dlg-settings').close());
$('#set-extension').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await api('/api/extension/install', { method: 'POST' });
    toast(r.mode === 'store' ? 'Opening the browser add-on store…' : 'Opening the extension folder…', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ================= sidebar / toolbar ================= */
function setNav(container, attr, value) {
  $$(container + ' .nav-item').forEach((b) => {
    const on = b.dataset[attr] === value;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}
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
function refreshViewTitle() {
  const cat = ui.cat === 'all' ? '' : ' · ' + ui.cat;
  $('#view-title').textContent = (VIEW_LABEL[ui.view] || 'Downloads') + cat;
  updateCounts();
}
$('#search').addEventListener('input', (e) => { ui.search = e.target.value; renderList(); });
$('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; renderList(); });

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

/* ================= drag & drop links ================= */
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

/* ================= keyboard / paste ================= */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!$('#dlg-add').open) openAdd(); }
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

/* ================= theme ================= */
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

/* ================= update check ================= */
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

/* ================= boot ================= */
setNav('#nav-views', 'view', ui.view);
setNav('#nav-cats', 'cat', ui.cat);
refreshViewTitle();
connect();
checkUpdates();
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h && h.version && $('#side-version')) $('#side-version').textContent = 'downloadX v' + h.version;
}).catch(() => {});
