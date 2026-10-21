'use strict';
/*
 * The details panel of an expanded row: URL, destination, connection counts,
 * the checksum tools and the timestamps.
 */
import { el, toast } from './dom.mjs';
import { api } from './api.mjs';
import { fmtDate } from './format.mjs';

export function renderDetails(row, it) {
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
