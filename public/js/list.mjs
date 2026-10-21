'use strict';
/*
 * Download list rendering: rows, per-segment progress bars and the details
 * panel. Rows are reused between frames — only their content is updated.
 */
import { $, el, toast } from './dom.mjs';
import { api } from './api.mjs';
import { I, catTile } from './icons.mjs';
import { fmtBytes, fmtSpeed, fmtEta, fmtDate, fmtPercent } from './format.mjs';
import { state, ui, rowMap, speedHistory, prevStatus, STATUS_LABEL } from './store.mjs';

/* ---------------- filtering & sorting ---------------- */

const STATUS_ORDER = { downloading: 0, probing: 0, queued: 1, paused: 2, completed: 3, failed: 4, canceled: 5 };

export function filteredItems() {
  const q = ui.search.toLowerCase();
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
    status: (a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.addedAt - a.addedAt),
    date: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }),
    size: (a, b) => (b.total || 0) - (a.total || 0),
    speed: (a, b) => (b.speed || 0) - (a.speed || 0),
  };
  return items.sort(cmp[ui.sort] || cmp.status);
}

/* ---------------- header / sparkline / status bar ---------------- */

export function updateHeader() {
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
  const c = $('#spark');
  if (!c) return;
  const ctx = c.getContext('2d');
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

export function updateCounts() {
  const vc = { all: state.items.length, downloading: 0, waiting: 0, completed: 0, failed: 0 };
  const cc = { all: state.items.length };
  for (const it of state.items) {
    if (it.status === 'downloading' || it.status === 'probing') vc.downloading++;
    else if (it.status === 'queued' || it.status === 'paused') vc.waiting++;
    else if (it.status === 'completed') vc.completed++;
    else if (it.status === 'failed') vc.failed++;
    cc[it.category] = (cc[it.category] || 0) + 1;
  }
  document.querySelectorAll('[data-count]').forEach((n) => {
    const [kind, key] = [n.dataset.count.split('-')[0], n.dataset.count.split('-').slice(1).join('-')];
    n.textContent = (kind === 'view' ? vc[key] : cc[key]) || 0;
  });
  const shown = filteredItems().length;
  $('#view-sub').textContent = `${shown} item${shown === 1 ? '' : 's'}`;
  $('#st-act').textContent = `${state.activeCount || 0} active · ${vc.waiting} waiting`;
  $('#st-total').textContent = `${vc.completed} completed`;
  $('#btn-retry-failed').hidden = vc.failed === 0;
  $('#btn-clear').hidden = (vc.completed + vc.failed) === 0;
}

export function refreshViewTitle() {
  const cat = ui.cat === 'all' ? '' : ' · ' + ui.cat;
  const label = { all: 'All downloads', downloading: 'Downloading', waiting: 'Waiting', completed: 'Completed', failed: 'Failed' }[ui.view] || 'Downloads';
  $('#view-title').textContent = label + cat;
  updateCounts();
}

/* ---------------- completion notifications ---------------- */

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
    if (settings.notifications !== false) desktopNotify('downloadX', msg);
    if (settings.notificationSound !== false) playDoneSound();
  }
  if (failed.length) {
    const msg = failed.length === 1 ? `${failed[0].filename} failed: ${failed[0].error || 'unknown error'}` : `${failed.length} downloads failed.`;
    toast(failed.length === 1 ? `Failed: ${failed[0].filename}` : `${failed.length} downloads failed`, 'err');
    if (sr) sr.textContent = msg;
    if (settings.notifications !== false) desktopNotify('downloadX', msg);
  }
}

/* ---------------- rows ---------------- */

export function renderList() {
  const list = $('#list');
  const items = filteredItems();
  $('#empty').classList.toggle('hidden', items.length > 0);
  const seen = new Set();
  const ordered = [];
  for (const it of items) {
    seen.add(it.id);
    if (!rowMap.has(it.id)) rowMap.set(it.id, buildRow());
    const row = rowMap.get(it.id);
    updateRow(row, it);
    ordered.push(row.el);
  }
  for (const [id, row] of rowMap) {
    if (!seen.has(id)) { row.el.remove(); rowMap.delete(id); }
  }
  // Re-append in sort order — appendChild moves existing nodes.
  for (const node of ordered) list.appendChild(node);
}

function buildRow() {
  const root = el('div', 'row');
  root.innerHTML = `
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
  const q = (s) => root.querySelector(s);
  const row = {
    el: root, tilebox: q('.tilebox'), rname: q('.rname'), mstat: q('.mstat'), msize: q('.msize'),
    mspeed: q('.mspeed'), meta: q('.meta'), merr: q('.merr'),
    barWrap: q('.bar-wrap'), segbar: q('.segbar'), pct: q('.pct'),
    actions: q('.raction'), details: q('.rdetails'), actionsFor: '', detailsBuilt: false, sig: '',
  };
  const main = q('.row-main');
  main.tabIndex = 0;
  main.setAttribute('role', 'button');
  main.setAttribute('aria-expanded', 'false');
  main.addEventListener('click', (e) => {
    if (e.target.closest('.rbtn')) return;
    toggleDetails(root.dataset.id);
  });
  main.addEventListener('keydown', (e) => {
    if (e.target.closest('.rbtn')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDetails(root.dataset.id);
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

/**
 * A cheap fingerprint of everything a row renders. When it does not change the
 * row is left alone, so a long history does not re-write itself every frame.
 */
function rowSignature(it) {
  return [
    it.status, it.filename, it.category, it.received, it.total,
    Math.round((it.speed || 0) / 1024), it.eta, it.error,
    it.activeConnections, it.stream || '',
    it.segments ? it.segments.length : 0,
    it.checksum ? it.checksum.at : 0,
    ui.expanded.has(it.id) ? 'x' : '-',
  ].join('|');
}

function updateRow(row, it) {
  row.el.dataset.id = it.id;
  const sig = rowSignature(it);
  if (row.sig === sig) return;
  row.sig = sig;
  row.el.className = 'row ' + it.status;
  row.tilebox.innerHTML = catTile(it.category);
  row.rname.textContent = it.filename;
  row.rname.title = it.filename;

  const pctVal = fmtPercent(it.received, it.total);
  row.pct.textContent = it.status === 'completed' ? '✓'
    : it.status === 'failed' ? '!' : (pctVal > 0 ? pctVal.toFixed(pctVal >= 10 ? 0 : 1) + '%' : '');

  row.mstat.textContent = '';
  row.mstat.append(el('span', 'dot ' + it.status), el('span', null, STATUS_LABEL[it.status] || it.status));

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
  renderActions(row, it);

  const expanded = ui.expanded.has(it.id);
  row.details.style.display = expanded ? 'grid' : 'none';
  const main = row.el.querySelector('.row-main');
  if (main) main.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (expanded) renderDetails(row, it);
  else row.detailsBuilt = false;
}

function renderActions(row, it) {
  if (row.actionsFor === it.status) return;
  row.actionsFor = it.status;
  row.actions.textContent = '';
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
      if (await confirmRemove('Stop download?', `"${it.filename}" will be stopped and its partial data removed.`, 'Stop')) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
      }
    }, true);
  } else if (it.status === 'paused') {
    add('play', 'Resume', () => act('resume'));
    add('stop', 'Remove', async () => {
      if (await confirmRemove('Remove download?', `"${it.filename}" and its partial data will be removed.`, 'Remove')) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
      }
    }, true);
  } else if (it.status === 'failed' || it.status === 'canceled') {
    add('retry', 'Retry', () => act('retry'));
    add('stop', 'Remove from list', () => api(`/api/downloads/${it.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err')), true);
  } else if (it.status === 'completed') {
    add('folder', 'Open folder', () => act('open-folder'));
    add('doc', 'Open file', () => act('open-file'));
    add('retry', 'Download again', async () => {
      if (await confirmRemove('Download again?', `"${it.filename}" will be downloaded from scratch and the existing file kept if the name is taken.`, 'Download')) {
        api(`/api/downloads/${it.id}/restart`, { method: 'POST', body: {} }).catch((e) => toast(e.message, 'err'));
      }
    });
    add('trash', 'Delete file', async () => {
      if (await confirmRemove('Delete file?', `"${it.filename}" will be permanently deleted from disk.`)) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).then(() => toast('Deleted', 'ok'), (e) => toast(e.message, 'err'));
      }
    }, true);
  }
  add('link', 'Copy URL', copyUrl);
}

/** Wrapper so the list module can show confirmations without a circular import. */
let confirmImpl = async () => false;
export function setConfirmDialog(fn) { confirmImpl = fn; }
const confirmRemove = (...args) => confirmImpl(...args);

function renderSegbar(row, it) {
  const bar = row.segbar;
  if (it.stream) {
    row.barWrap.classList.remove('indeterminate');
    if (bar.children.length !== 1) {
      bar.textContent = '';
      const s = el('div', 'seg');
      s.append(el('div', 'fill'));
      bar.appendChild(s);
    }
    const segEl = bar.firstChild;
    const pct = fmtPercent(it.received, it.total);
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
  while (bar.children.length < want) { const s = el('div', 'seg'); s.append(el('div', 'fill')); bar.appendChild(s); }
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
  d.textContent = '';
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
  dl('Added', fmtDate(it.addedAt));
  if (it.completedAt) dl('Completed', fmtDate(it.completedAt));
}

/* ---------------- snapshot handling ---------------- */

export function applySnapshot(snap) {
  Object.assign(state, snap);
  trackFinished(snap.items || []);
  updateHeader();
  updateCounts();
  renderList();
  const armed = !!state.shutdownArmed;
  $('#shutdown-banner').classList.toggle('hidden', !armed);
  if (armed) $('#shutdown-count').textContent = state.shutdownIn || 60;
}
