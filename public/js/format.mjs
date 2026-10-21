'use strict';
/*
 * Formatting helpers for the downloadX UI.
 * Pure functions only — no DOM access, so they are easy to reason about.
 */

/** Human readable byte size (1024 based). */
export function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < u.length - 1) { value /= 1024; i++; }
  if (i === 0) return value + ' B';
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return text.replace(/\.0$/, '') + ' ' + u[i];
}

/** Transfer rate. */
export function fmtSpeed(n) {
  return fmtBytes(n) + '/s';
}

/** Remaining time in seconds as a compact "1h 02m" style string. */
export function fmtEta(s) {
  if (s == null || s < 0) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

/** Local date and time for a timestamp (0 / undefined renders as an em dash). */
export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Percentage with at most one decimal, clamped to 0..100. */
export function fmtPercent(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}
