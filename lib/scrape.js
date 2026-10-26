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

/** Extensions that are navigation pages, not files to download. */
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp']);

/** Media formats that the built-in HLS/DASH/download engine can capture. */
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm2ts', 'ts',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  'm3u8', 'mpd', 'ism', 'f4m',
]);

const ATTR_RE = /\b(href|src|data-src|data-href|data-url|data-file)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/gi;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_ATTR_RE = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
const MEDIA_META = /^(og:video|og:video:url|og:video:secure_url|og:audio|twitter:player:stream|contenturl|embedurl)$/i;

/** Parse the attributes of a single tag. */
function tagAttrs(tag) {
  const out = {};
  META_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = META_ATTR_RE.exec(tag))) {
    out[m[1].toLowerCase()] = String(m[2] || m[3] || m[4] || '').trim();
  }
  return out;
}

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
  const add = (raw) => {
    if (!raw) return;
    if (/^(javascript|data|mailto|tel|blob):/i.test(raw)) return;
    if (raw.startsWith('#')) return;
    let abs;
    try { abs = new URL(raw, baseUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(abs)) return;
    if (seen.has(abs)) return;
    const path = abs.split('?')[0].split('#')[0];
    const ext = ((path.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || '').toLowerCase();
    const media = MEDIA_EXTENSIONS.has(ext);
    const page = PAGE_EXTENSIONS.has(ext);
    if (page && !options.includePages) return;
    if (!options.includeAssets && ext && SKIP_EXTENSIONS.has(ext) && !(options.includeMedia && media) && !page) return;
    seen.add(abs);
    out.push({
      url: abs,
      ext,
      media,
      page,
      likely: media && !!options.includeMedia ? true : (!!ext && DOWNLOAD_EXTENSIONS.has(ext)),
    });
  };

  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source))) add(String(m[2] || m[3] || m[4] || '').trim());

  // Media players often expose the stream only in a meta tag.
  META_TAG_RE.lastIndex = 0;
  while ((m = META_TAG_RE.exec(source))) {
    const attrs = tagAttrs(m[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && MEDIA_META.test(key) && attrs.content) add(attrs.content);
  }

  // The likely downloads come first, the unknown ones last.
  out.sort((a, b) => (b.likely - a.likely) || a.url.localeCompare(b.url));
  return out;
}

module.exports = { extractLinks, SKIP_EXTENSIONS, DOWNLOAD_EXTENSIONS, MEDIA_EXTENSIONS };
