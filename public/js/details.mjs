'use strict';
/*
 * The details panel of an expanded row: URL, destination, connection counts,
 * the checksum tools and the timestamps.
 */
import { el, toast } from './dom.mjs';
import { api } from './api.mjs';
import { fmtDate } from './format.mjs';
import { state } from './store.mjs';
import { t } from './i18n.mjs';

export function renderDetails(row, it) {
  const d = row.details;
  const segList = it.segments || [];
  const sig = [it.id, it.status, it.error, it.expectedChecksum, it.checksumAlgo, it.speedLimit,
    it.checksum && it.checksum.at, segList.length, it.segmentsWanted, it.completedAt,
    it.activeConnections, it.stream, it.received, it.total, it.priority, it.dependsOn,
    it.url, it.blockedBy, JSON.stringify(it.schedule || null)].join('|');
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
  dl(t('URL'), el('span', 'mono', it.url));
  if (it.urls && it.urls.length > 1) dl(t('Mirrors'), it.urls.slice(1).join(', '));
  dl(t('Saved to'), el('span', 'mono', it.path));
  if (it.stream) {
    dl(t('Media stream'), `${it.stream.toUpperCase()} — ${it.received} of ${it.total} parts`);
    dl(t('Connections'), '1 (sequential stream)');
    if (it.stream === 'dash') dl(t('Audio track'), el('span', 'mono', it.path.replace(/\.mp4$/i, '.audio.m4a')));
  } else {
    const segCount = segList.length;
    dl(t('Connections'), `${it.activeConnections || 0} active / ${segCount} segment${segCount === 1 ? '' : 's'} (max ${it.segmentsWanted})`);
  }
  dl(t('Resumable'), it.canResume ? 'Yes' : 'No — single stream');
  if (it.expectedChecksum) dl(t('Expected hash'), el('span', 'mono', it.expectedChecksum));
  if (it.error) dl(t('Error'), el('span', 'mono', it.error));

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
  dl(t('Integrity'), box);
  dl(t('Limit'), limitBox);

  /* Quality picker: a stream can offer several resolutions or bitrates. */
  if (it.variants && it.variants.length > 1) {
    const qBox = el('div', 'checksum-form');
    const select = el('select', 'input select');
    for (const v of it.variants) {
      const o = el('option', null, v.label || ('Quality ' + (v.index + 1)));
      o.value = String(v.index);
      select.appendChild(o);
    }
    select.value = String(it.variantIndex >= 0 ? it.variantIndex : 0);
    const apply = el('button', 'btn ghost', t('Change'));
    apply.onclick = () => {
      const index = parseInt(select.value, 10);
      if (index === it.variantIndex) return;
      apply.disabled = true;
      api(`/api/downloads/${it.id}/quality`, { method: 'POST', body: { index } })
        .then(() => toast('Switching quality…', 'ok'))
        .catch((e) => toast(e.message, 'err'))
        .finally(() => { apply.disabled = false; });
    };
    qBox.append(select, apply);
    dl(t('Quality'), qBox);
  }

  /* Per-download scheduler and dependency. */
  const sched = it.schedule || {};
  const schedBox = el('div', 'checksum-form');
  const start = el('input', 'input');
  start.type = 'time'; start.title = 'Window start'; start.value = sched.windowStart || '';
  const end = el('input', 'input');
  end.type = 'time'; end.title = 'Window end'; end.value = sched.windowEnd || '';
  const days = el('div', 'days');
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  for (let i = 0; i < 7; i++) {
    const lab = el('label');
    lab.title = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i];
    const cb = el('input');
    cb.type = 'checkbox'; cb.value = String(i);
    cb.checked = (sched.days || []).includes(i);
    lab.append(cb, el('span', null, dayNames[i]));
    days.appendChild(lab);
  }
  const schedLimit = el('input', 'input');
  schedLimit.type = 'number'; schedLimit.min = '0';
  schedLimit.placeholder = 'KB/s';
  schedLimit.value = sched.speedLimit ? Math.round(sched.speedLimit / 1024) : '';
  const parent = el('select', 'input select');
  const none = el('option', null, 'No parent'); none.value = '';
  parent.appendChild(none);
  for (const item of state.items || []) {
    if (item.id === it.id || item.status === 'completed' || item.status === 'canceled') continue;
    const o = el('option', null, item.filename); o.value = item.id;
    parent.appendChild(o);
  }
  parent.value = it.dependsOn || '';
  const schedSave = el('button', 'btn ghost', 'Save');
  schedSave.onclick = () => {
    const picked = [...days.children]
      .map((lab) => lab.querySelector('input'))
      .filter((cb) => cb && cb.checked)
      .map((cb) => parseInt(cb.value, 10));
    api(`/api/downloads/${it.id}/schedule`, {
      method: 'POST',
      body: {
        schedule: {
          windowStart: start.value,
          windowEnd: end.value,
          days: picked,
          speedLimit: (parseInt(schedLimit.value, 10) || 0) * 1024,
        },
        dependsOn: parent.value || null,
      },
    }).then(() => toast('Schedule saved', 'ok'), (e) => toast(e.message, 'err'));
  };
  schedBox.append(start, end, days, schedLimit, parent, schedSave);
  dl(t('Schedule'), schedBox);
  if (it.blockedBy) dl(t('Waiting for'), it.blockedBy);

  const queueBox = el('div', 'checksum-form');
  const priority = el('input', 'input');
  priority.type = 'number'; priority.min = '-100'; priority.max = '100';
  priority.value = String(it.priority || 0);
  priority.title = 'Higher runs first';
  const prioritySave = el('button', 'btn ghost', 'Set');
  prioritySave.onclick = () => api(`/api/downloads/${it.id}/priority`, {
    method: 'POST', body: { value: parseInt(priority.value, 10) || 0 },
  }).then(() => toast('Priority saved', 'ok'), (e) => toast(e.message, 'err'));
  queueBox.append(priority, prioritySave);
  dl(t('Queue'), queueBox);

  const urlBox = el('div', 'checksum-form');
  const newUrl = el('input', 'input');
  newUrl.value = it.url || '';
  newUrl.title = 'Refresh the download address';
  const refresh = el('button', 'btn ghost', 'Refresh');
  refresh.onclick = () => api(`/api/downloads/${it.id}/refresh`, {
    method: 'POST', body: { url: newUrl.value.trim() },
  }).then(() => toast('Address refreshed', 'ok'), (e) => toast(e.message, 'err'));
  urlBox.append(newUrl, refresh);
  dl(t('Address'), urlBox);

  if (it.checksum) {
    const b = el('span', 'badge ' + (it.checksum.ok ? 'ok' : 'bad'),
      it.checksum.ok ? 'verified ✓' : 'MISMATCH');
    const note = el('span', 'mono', `${it.checksum.algo}: ${it.checksum.actual || it.checksum.error || ''}`);
    dl(t('Result'), [b, note]);
  }
  dl(t('Added'), fmtDate(it.addedAt));
  if (it.completedAt) dl(t('Completed'), fmtDate(it.completedAt));
}
