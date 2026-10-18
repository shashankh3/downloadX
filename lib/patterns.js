'use strict';

/**
 * Expand sequential URL patterns into concrete URLs.
 *   https://site/file[1-4].zip         -> file1..file4
 *   https://site/img[01-03].jpg        -> img01..img03 (zero-padded)
 *   https://site/[a-c].txt             -> a.txt b.txt c.txt
 *   https://site/[one,two].txt         -> one.txt two.txt
 * Multiple groups expand cartesian-style. Hard cap of 1000 URLs.
 */
function expandPattern(text) {
  const lines = String(text || '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (!/^https?:\/\//i.test(line)) continue;
    let variants = [''];
    const re = /\[([^\[\]]+)\]/g;
    let m, matched = false;
    while ((m = re.exec(line)) !== null) {
      matched = true;
      const parts = expandGroup(m[1]);
      if (!parts.length) return [];
      const next = [];
      for (const v of variants) for (const p of parts) next.push(v + p);
      variants = next;
      if (variants.length > 1000) return [];
    }
    if (!matched) { out.push(line); continue; }
    const tmpl = line.replace(/\[[^\[\]]+\]/g, '\u0000');
    for (const v of variants) out.push(tmpl.replace('\u0000', v));
    if (out.length > 1000) return out.slice(0, 1000);
  }
  return out;
}

function expandGroup(g) {
  if (g.includes(',')) {
    return g.split(',').map((s) => s.trim()).filter(Boolean);
  }
  let m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(g);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    const pad = m[1].replace('-', '').length;
    const step = a <= b ? 1 : -1;
    const parts = [];
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      parts.push(String(Math.abs(i)).padStart(pad, '0').replace(/^/, i < 0 ? '-' : ''));
      if (parts.length > 500) break;
    }
    return parts;
  }
  m = /^(\w)\s*-\s*(\w)$/.exec(g);
  if (m) {
    const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0);
    const step = a <= b ? 1 : -1;
    const parts = [];
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) parts.push(String.fromCharCode(i));
    return parts;
  }
  return [];
}

module.exports = { expandPattern };
