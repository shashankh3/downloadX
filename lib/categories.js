'use strict';
/*
 * Category detection: which folder a finished download belongs in.
 * The extension table mirrors what desktop download managers use; the MIME map
 * is the fallback when a URL carries no useful file extension.
 */
const path = require('path');

const CATEGORIES = {
  Programs: ['exe', 'msi', 'msix', 'appx', 'appxbundle', 'msixbundle', 'apk', 'apks', 'xapk', 'dmg', 'pkg', 'deb',
    'rpm', 'appimage', 'snap', 'flatpak', 'jar', 'war', 'bat', 'cmd', 'sh', 'ps1', 'vbs', 'crx', 'xpi', 'air',
    'run', 'gadget', 'sis', 'sisx', 'ipa', 'nupkg', 'vsix', 'unitypackage', 'epk'],
  Compressed: ['zip', 'zipx', 'rar', 'r00', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst',
    'lz4', 'lzh', 'lha', 'ace', 'arj', 'arc', 'cab', 'iso', 'img', 'wim', 'esd', 'vhd', 'vhdx', 'dmgpart', 'partimg',
    'z01', 'z02', 'z03', 'spl', 'sit', 'sitx', 'pea', 'paq', 'uha', 'sqx'],
  Music: ['mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'ac3', 'eac3', 'dts', 'wma', 'aiff',
    'aif', 'alac', 'ape', 'mka', 'mid', 'midi', 'ra', 'wv', 'tta', 'dsf', 'dff', 'amr', 'awb', 'xm', 'mod', 'it', 's3m'],
  Video: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'qt', 'wmv', 'asf', 'flv', 'f4v', 'ts', 'mts',
    'm2ts', 'mpg', 'mpeg', 'mpe', 'm2v', '3gp', '3g2', 'ogv', 'ogm', 'rm', 'rmvb', 'divx', 'vob', 'ifo', 'bik',
    'dvr-ms', 'wtv', 'amv', 'mxf'],
  Documents: ['pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'ppt', 'pptx',
    'pptm', 'pps', 'ppsx', 'txt', 'text', 'rtf', 'csv', 'tsv', 'odt', 'ods', 'odp', 'odg', 'epub', 'mobi', 'azw',
    'azw3', 'fb2', 'chm', 'djvu', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'xhtml', 'log',
    'tex', 'bib', 'pages', 'numbers', 'key', 'one', 'msg', 'eml', 'oft', 'vsd', 'vsdx', 'pub', 'xps', 'oxps', 'ps',
    'eps', 'srt', 'vtt', 'ass', 'ssa', 'sub', 'lrc'],
  Images: ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'heic', 'heif', 'svg', 'svgz',
    'bmp', 'dib', 'ico', 'cur', 'tif', 'tiff', 'psd', 'psb', 'xcf', 'raw', 'dng', 'cr2', 'cr3', 'nef', 'nrw',
    'arw', 'srf', 'orf', 'rw2', 'raf', 'pef', 'srw', '3fr', 'jp2', 'j2k', 'jpf', 'jxl', 'wmf', 'emf', 'ai', 'cdr',
    'sketch', 'fig', 'pdn', 'kra'],
};

const MIME_CATEGORY = {
  'application/pdf': 'Documents',
  'application/epub+zip': 'Documents',
  'application/msword': 'Documents',
  'application/vnd.ms-excel': 'Documents',
  'application/vnd.ms-powerpoint': 'Documents',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Documents',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Documents',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Documents',
  'application/rtf': 'Documents',
  'application/json': 'Documents',
  'application/xml': 'Documents',
  'application/zip': 'Compressed',
  'application/x-zip-compressed': 'Compressed',
  'application/x-rar-compressed': 'Compressed',
  'application/vnd.rar': 'Compressed',
  'application/x-7z-compressed': 'Compressed',
  'application/x-tar': 'Compressed',
  'application/gzip': 'Compressed',
  'application/x-xz': 'Compressed',
  'application/zstd': 'Compressed',
  'application/x-iso9660-image': 'Compressed',
  'application/x-msdownload': 'Programs',
  'application/x-msdos-program': 'Programs',
  'application/vnd.microsoft.portable-executable': 'Programs',
  'application/x-apple-diskimage': 'Programs',
  'application/vnd.android.package-archive': 'Programs',
  'application/vnd.debian.binary-package': 'Programs',
  'application/x-rpm': 'Programs',
  'application/java-archive': 'Programs',
  'application/x-msi': 'Programs',
  'application/vnd.apple.mpegurl': 'Video',
  'application/x-mpegurl': 'Video',
  'audio/mpegurl': 'Video',
  'audio/x-mpegurl': 'Video',
  'application/dash+xml': 'Video',
  'video/vnd.dlna.mpeg-tts': 'Video',
};

const CATEGORY_NAMES = [...Object.keys(CATEGORIES), 'Others'];

/**
 * Normalize a user supplied category name; unknown values fall back to 'auto'.
 * @param {unknown} value
 * @returns {string} a category name or 'auto'
 */
function normalizeCategory(value) {
  if (!value || value === 'auto') return 'auto';
  const s = String(value).trim().toLowerCase();
  return CATEGORY_NAMES.find((c) => c.toLowerCase() === s) || 'auto';
}

/**
 * Pick a category from the file extension first, then from the MIME type.
 * @param {string} mime
 * @param {string} filename
 * @returns {string} the category name
 */
function categoryFor(mime, filename) {
  const ext = (path.extname(filename || '').toLowerCase().replace('.', ''));
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  if (MIME_CATEGORY[type]) return MIME_CATEGORY[type];
  const m = type.split('/')[0];
  if (m === 'video') return 'Video';
  if (m === 'audio') return 'Music';
  if (m === 'image') return 'Images';
  if (m === 'text' && type.startsWith('text/')) return 'Documents';
  return 'Others';
}

module.exports = { CATEGORIES, MIME_CATEGORY, CATEGORY_NAMES, normalizeCategory, categoryFor };
