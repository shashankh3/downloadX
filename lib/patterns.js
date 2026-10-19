'use strict';

/**
 * Expand sequential URL patterns into concrete URLs.
 *
 *   https://site/file[1-4].zip          -> file1..file4
 *   https://site/img[01-03].jpg         -> img01..img03 (zero-padded)
 *   https://site/[a-c].txt              -> a.txt b.txt c.txt
 *   https://site/[one,two].txt          -> one.txt two.txt
 *   https://site/part[1-20:2].bin       -> part1, part3, ... (step support)
 *   https://site/a[1-3]-b[x,z].txt      -> cartesian product of every group
 *
 * Invalid groups are left untouched (so IPv6 literals such as [::1] still work).
 * Hard cap: 1000 URLs per request.
 */

const MAX_URLS = 1000;

function expandPattern(text) {
  return expandPatternDetailed(text).urls;
}

function expandPatternDetailed(text) {
  const urls = [];
  const seen = new Set();
  const errors = [];
  const lines = String(text == null ? '' : text)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!/^https?:\/\//i.test(line)) {
      errors.push({ line, error: 'Not an http(s) URL' });
      continue;
    }
    let variants;
    try {
      variants = expandLine(line);
    } catch (e) {
      errors.push({ line, error: e.message });
      continue;
    }
    if (!variants.length) {
      errors.push({ line, error: 'Pattern produced no URLs' });
      continue;
    }
    for (const url of variants) {
      if (seen.has(url)) continue;
      if (urls.length >= MAX_URLS) {
        errors.push({ line, error: `Limit of ${MAX_URLS} URLs reached` });
        break;
      }
      seen.add(url);
      urls.push(url);
    }
    if (urls.length >= MAX_URLS) break;
  }
  return { urls, errors };
}

function expandLine(line) {
  const parts = [];
  let last = 0;
  let matched = false;
  const re = /\[([^[\]]*)\]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const group = expandGroup(m[1]);
    if (!group) continue; // not a pattern: keep the literal brackets
    parts.push(line.slice(last, m.index));
    parts.push(group);
    last = m.index + m[0].length;
    matched = true;
  }
  if (!matched) return [line];
  parts.push(line.slice(last));

  let out = [''];
  for (const part of parts) {
    if (typeof part === 'string') {
      out = out.map((v) => v + part);
      continue;
    }
    const next = [];
    for (const prefix of out) {
      for (const value of part) {
        if (next.length >= MAX_URLS) break;
        next.push(prefix + value);
      }
      if (next.length >= MAX_URLS) break;
    }
    out = next;
    if (!out.length) break;
  }
  return out;
}

function expandGroup(group) {
  const raw = String(group).trim();
  if (!raw) return null;

  if (raw.includes(',')) {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.some((p) => !p)) return null;
    return parts;
  }

  let m = /^(-?\d+)\s*-\s*(-?\d+)(?:\s*:\s*(\d+))?$/.exec(raw);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const step = Math.max(1, parseInt(m[3] || '1', 10) || 1);
    const width = m[1].replace('-', '').length;
    const dir = a <= b ? 1 : -1;
    const out = [];
    for (let i = a; dir > 0 ? i <= b : i >= b; i += dir * step) {
      const abs = String(Math.abs(i)).padStart(width, '0');
      out.push((i < 0 ? '-' : '') + abs);
      if (out.length >= MAX_URLS) break;
    }
    return out;
  }

  m = /^([A-Za-z])\s*-\s*([A-Za-z])$/.exec(raw);
  if (m) {
    const a = m[1].charCodeAt(0);
    const b = m[2].charCodeAt(0);
    const dir = a <= b ? 1 : -1;
    const out = [];
    for (let i = a; dir > 0 ? i <= b : i >= b; i += dir) {
      out.push(String.fromCharCode(i));
      if (out.length >= MAX_URLS) break;
    }
    return out;
  }

  return null;
}

module.exports = { expandPattern, expandPatternDetailed, expandGroup, MAX_URLS };
