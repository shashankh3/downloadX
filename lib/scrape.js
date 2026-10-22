'use strict';
/*
 * Find the download links of a web page.
 *
 * The page is fetched by the server (so the proxy and the cookies of the app
 * apply) and the links are extracted here. The result is a list of absolute
 * http(s) URLs with the file extension, ready to be handed to the queue.
 */

/** Asset types that are never downloads. */
const SKIP_EXTENSIONS = new Set([
  'css', 'js', 'mjs', 'json', 'xml', 'ico', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'avif', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'map', 'html', 'htm', 'php', 'aspx',
  'do', 'action', 'css2', 'mp4', 'm3u8', 'mpd',
]);

/** Extensions that are very likely to be a real download. */
const DOWNLOAD_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'img', 'exe', 'msi', 'apk',
  'deb', 'rpm', 'pdf', 'epub', 'mobi', 'azw3', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'flac', 'wav', 'aac', 'm4a', 'mkv', 'mov', 'avi', 'webm', 'm2ts', 'ts', 'csv',
  'dmg', 'pkg', 'jar', 'war', 'bin', 'dat', 'db', 'sql', 'bak', 'log',
]);

const ATTR_RE = /\b(href|src|data-src|data-href|data-url|data-file)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/gi;

/**
 * Extract the links of an HTML document.
 * @param {string} html the page source
 * @param {string} baseUrl the URL the page was fetched from
 * @param {{ includeAssets?: boolean }} [options]
 * @returns {{ url: string, ext: string, likely: boolean }[]}
 */
function extractLinks(html, baseUrl, options = {}) {
  const out = [];
  const seen = new Set();
  const source = String(html || '');
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source))) {
    const raw = String(m[2] || m[3] || m[4] || '').trim();
    if (!raw) continue;
    if (/^(javascript|data|mailto|tel|blob):/i.test(raw)) continue;
    if (raw.startsWith('#')) continue;
    let abs;
    try { abs = new URL(raw, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    const path = abs.split('?')[0].split('#')[0];
    const ext = ((path.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || '').toLowerCase();
    if (!options.includeAssets && ext && SKIP_EXTENSIONS.has(ext)) continue;
    seen.add(abs);
    out.push({ url: abs, ext, likely: !!ext && DOWNLOAD_EXTENSIONS.has(ext) });
  }
  // The likely downloads come first, the unknown ones last.
  out.sort((a, b) => (b.likely - a.likely) || a.url.localeCompare(b.url));
  return out;
}

module.exports = { extractLinks, SKIP_EXTENSIONS, DOWNLOAD_EXTENSIONS };
