'use strict';
/*
 * The per segment progress bar of a row. Every segment of the file gets one
 * slice, filled in proportion to how much of it has been downloaded.
 */
import { el } from './dom.mjs';

export function renderSegbar(row, it) {
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
