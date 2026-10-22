'use strict';
/*
 * Filtering and sorting of the download list.
 * Kept apart so both the list and the rows can use it without an import
 * cycle.
 */
import { state, ui } from './store.mjs';

const STATUS_ORDER = { downloading: 0, probing: 0, queued: 1, paused: 2, completed: 3, failed: 4, canceled: 5 };

/** The downloads that match the current view, category, search and sort order. */
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
