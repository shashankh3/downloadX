'use strict';
/*
 * The download rows: building them, keeping them up to date and the action
 * buttons of a row. The details panel lives in details.mjs and the per
 * segment progress bar in segments.mjs.
 */
import { $, el, toast } from './dom.mjs';
import { api } from './api.mjs';
import { I, catTile } from './icons.mjs';
import { t } from './i18n.mjs';
import { fmtBytes, fmtSpeed, fmtEta, fmtPercent } from './format.mjs';
import { state, ui, rowMap, STATUS_LABEL } from './store.mjs';
import { filteredItems } from './filter.mjs';
import { renderSegbar } from './segments.mjs';
import { renderDetails } from './details.mjs';

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
  row.mstat.append(el('span', 'dot ' + it.status), el('span', null, t(STATUS_LABEL[it.status] || it.status)));

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
  const copyUrl = () => navigator.clipboard.writeText(it.url).then(() => toast(t('URL copied'), 'ok'), () => {});
  if (['downloading', 'probing', 'queued'].includes(it.status)) {
    add('pause', t('Pause'), () => act('pause'));
    add('stop', t('Stop & remove'), async () => {
      if (await confirmRemove(t('Stop download?'), `"${it.filename}" will be stopped and its partial data removed.`, 'Stop')) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
      }
    }, true);
  } else if (it.status === 'paused') {
    add('play', t('Resume'), () => act('resume'));
    add('stop', t('Remove'), async () => {
      if (await confirmRemove(t('Remove download?'), `"${it.filename}" and its partial data will be removed.`, t('Remove'))) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
      }
    }, true);
  } else if (it.status === 'failed' || it.status === 'canceled') {
    add('retry', t('Retry'), () => act('retry'));
    add('stop', t('Remove from list'), () => api(`/api/downloads/${it.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err')), true);
  } else if (it.status === 'completed') {
    add('folder', t('Open folder'), () => act('open-folder'));
    add('doc', t('Open file'), () => act('open-file'));
    add('retry', t('Download again'), async () => {
      if (await confirmRemove(t('Download again?'), `"${it.filename}" will be downloaded from scratch and the existing file kept if the name is taken.`, 'Download')) {
        api(`/api/downloads/${it.id}/restart`, { method: 'POST', body: {} }).catch((e) => toast(e.message, 'err'));
      }
    });
    add('trash', t('Delete file'), async () => {
      if (await confirmRemove(t('Delete file?'), `"${it.filename}" will be permanently deleted from disk.`)) {
        api(`/api/downloads/${it.id}?file=1`, { method: 'DELETE' }).then(() => toast(t('Deleted'), 'ok'), (e) => toast(e.message, 'err'));
      }
    }, true);
  }
  add('link', t('Copy URL'), copyUrl);
}

/** Wrapper so the list module can show confirmations without a circular import. */
let confirmImpl = async () => false;
export function setConfirmDialog(fn) { confirmImpl = fn; }
const confirmRemove = (...args) => confirmImpl(...args);
