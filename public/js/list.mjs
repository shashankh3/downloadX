'use strict';
/*
 * The live view of the download list: filtering, the header, the counters and
 * the snapshot handling. The rows themselves live in rows.mjs, their segment
 * bars in segments.mjs and the details panel in details.mjs.
 */
import { $, toast } from './dom.mjs';
import { fmtBytes } from './format.mjs';
import { state, ui, speedHistory, prevStatus } from './store.mjs';
import { renderList } from './rows.mjs';
import { filteredItems } from './filter.mjs';

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

export { filteredItems } from './filter.mjs';
export { renderList, setConfirmDialog } from './rows.mjs';
export { renderSegbar } from './segments.mjs';
export { renderDetails } from './details.mjs';
