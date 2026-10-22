'use strict';
/*
 * Serving the local files: the web UI and the browser extension package.
 *
 * Nothing outside the public folder can be reached, and every response carries
 * the security headers.
 */
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.crx': 'application/x-chrome-extension',
  '.xml': 'text/xml; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** True when `child` is inside `parent`. */
function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the static file handlers.
 * @param {{ publicDir: string, extDir: string, isPkg?: boolean }} options
 */
function createStaticHandlers(options) {
  const PUBLIC = options.publicDir;
  const EXT_DIR = options.extDir;
  const IS_PKG = !!options.isPkg;

  /* The head must already be written when this is called. */
  const send = (res, file) => {
    if (IS_PKG) {
      try { res.end(fs.readFileSync(file)); } catch { try { res.destroy(); } catch { /* gone */ } }
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
  };

  /** Serve a file from the public folder. */
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Method not allowed');
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
    if (rel === '/' || rel === '') rel = '/index.html';
    rel = rel.replace(/\\/g, '/').replace(/\0/g, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!isPathInside(PUBLIC, file)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Forbidden');
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
        return res.end();
      }
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        ...SECURITY_HEADERS,
      };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      send(res, file);
    });
  }

  /** Serve the built extension package (updates.xml or the CRX). */
  function serveExtensionFile(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Method not allowed');
    }
    const isCrx = pathname.endsWith('.crx');
    const file = path.join(EXT_DIR, isCrx ? 'downloadx.crx' : 'updates.xml');
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('Extension package not built. Run the installer or node installer/prepare-extension.mjs');
    }
    res.writeHead(200, {
      'Content-Type': isCrx ? 'application/x-chrome-extension' : 'text/xml; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    send(res, file);
  }

  return { serveStatic, serveExtensionFile, MIME, SECURITY_HEADERS, isPathInside };
}

module.exports = { createStaticHandlers, MIME, SECURITY_HEADERS, isPathInside, CSP };
