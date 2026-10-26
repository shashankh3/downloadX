'use strict';
/*
 * The REST API of downloadX.
 *
 * The router is a factory: everything it needs from the server (the engine,
 * the security headers, the live feed) is passed in, so this module stays
 * independent of how the server is started.
 */
const fs = require('fs');
const path = require('path');
const httpget = require('./httpget');
const { expandPatternDetailed } = require('./patterns');
const { extractLinks, DOWNLOAD_EXTENSIONS } = require('./scrape');
const { freeSpaceFor } = require('./util');
const { normalizeSettings } = require('./engine');
const { isPrivateOrReservedIp } = require('./origin');
const { readLocalIndex, extractEntry } = require('./zip');
const { normalizeSchedule } = require('./download');
const { sanitizeName } = require('./naming');
const dns = require('dns');

/**
 * Drop the links that point into a private network: a page must not be able to
 * hand the user a list of internal addresses to download.
 * @param {{ url: string }[]} links
 * @param {boolean} allowPrivate
 * @returns {Promise<{ url: string, ext: string, likely: boolean }[]>}
 */
async function filterPrivateLinks(links, allowPrivate) {
  if (allowPrivate) return links;
  const hosts = new Map();
  for (const link of links) {
    let host;
    try { host = new URL(link.url).hostname; } catch { continue; }
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push(link);
  }
  const blocked = new Set();
  await Promise.all([...hosts.keys()].map((host) => new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, list) => {
      if (!err && list) {
        for (const entry of list) {
          if (isPrivateOrReservedIp(entry.address)) { blocked.add(host); break; }
        }
      }
      resolve();
    });
  })));
  return links.filter((link) => {
    try { return !blocked.has(new URL(link.url).hostname); } catch { return false; }
  });
}

/**
 * Build the API router.
 * @param {{
 *   getEngine: () => object,
 *   instanceId: string,
 *   version: string,
 *   securityHeaders: Record<string, string>,
 *   sseClients: Set<object>,
 *   buildSnapshot: () => string,
 *   checkForUpdate: () => Promise<object>,
 *   readLimited: (stream: object, limit: number) => Promise<Buffer>,
 *   openPath: (target: string, select?: boolean) => void,
 *   extension: { mode: string, chromeStoreId: string, edgeStoreId: string,
 *     firefoxId: string, dir: string, folder: () => string },
 *   isAllowedOrigin: (origin: string) => boolean,
 *   quit: (code?: number) => void,
 * }} ctx
 */
function createApiRouter(ctx) {
  function json(res, code, obj) {
    if (res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...ctx.securityHeaders,
      ...corsHeaders(res.__origin),
    });
    res.end(body);
  }

  function corsHeaders(origin) {
    if (!origin || !ctx.isAllowedOrigin(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        reject(err);
        req.resume();
      };
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > 1024 * 1024) return fail(Object.assign(new Error('Body too large'), { status: 413 }));
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
      });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  async function handleApi(req, res, pathname, query) {
    const method = req.method;

    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true, instance: ctx.instanceId, version: ctx.version, uptime: Math.round(process.uptime()),
        pid: process.pid, platform: process.platform, node: process.version,
      });
    }

    if (pathname === '/api/state') return json(res, 200, ctx.getEngine().snapshot());

    if (pathname === '/api/free-space' && method === 'GET') {
      const dir = ctx.getEngine().settings.rootDir;
      const free = freeSpaceFor(dir);
      return json(res, 200, {
        ok: true,
        dir,
        free: free == null ? null : Math.round(free),
      });
    }

    if (pathname === '/api/update-check' && method === 'GET') {
      try {
        return json(res, 200, { ok: true, ...(await ctx.checkForUpdate()) });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message, current: ctx.version });
      }
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...ctx.securityHeaders,
        ...corsHeaders(req.headers.origin),
      });
      res.write(`retry: 2000\n\nevent: snapshot\ndata: ${ctx.buildSnapshot()}\n\n`);
      ctx.getEngine().dirty = false;
      ctx.sseClients.add(res);
      const cleanup = () => ctx.sseClients.delete(res);
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    if (pathname === '/api/expand' && method === 'POST') {
      const body = await readBody(req);
      const result = expandPatternDetailed(body.text || body.url || '');
      return json(res, 200, result);
    }

    if (pathname === '/api/scrape' && method === 'POST') {
      const body = await readBody(req);
      const pageUrl = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(pageUrl)) {
        return json(res, 400, { error: 'A http(s) page URL is required' });
      }
      const depth = Math.max(0, Math.min(3, parseInt(body.depth, 10) || 0));
      const sameOrigin = body.sameOrigin !== false;
      const includeAssets = !!body.includeAssets;
      const includeMedia = !!body.includeMedia;
      const maxPages = Math.max(1, Math.min(50, parseInt(body.maxPages, 10) || (depth ? 10 : 1)));
      const maxLinks = Math.max(1, Math.min(5000, parseInt(body.maxLinks, 10) || 2000));
      const extFilter = (Array.isArray(body.extensions)
        ? body.extensions
        : String(body.extensions || '').split(/[\s,;]+/))
        .map((ext) => String(ext).trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      let origin = '';
      try { origin = new URL(pageUrl).origin; } catch { /* validated above */ }

      const queue = [{ url: pageUrl, depth: 0 }];
      const pagesSeen = new Set();
      const links = new Map();
      const pageErrors = [];
      const allowPrivate = ctx.getEngine().allowsPrivateNetworks();

      const isPageCandidate = (link, baseUrl) => {
        if (link.media || (link.ext && DOWNLOAD_EXTENSIONS.has(link.ext))) return false;
        if (link.ext && !link.page) return false;
        if (sameOrigin) {
          try { if (new URL(link.url).origin !== origin) return false; } catch { return false; }
        }
        return link.url !== baseUrl;
      };

      try {
        while (queue.length && pagesSeen.size < maxPages && links.size < maxLinks) {
          const item = queue.shift();
          if (pagesSeen.has(item.url)) continue;
          pagesSeen.add(item.url);
          let page;
          let finalUrl = item.url;
          try {
            const r = await httpget.request(item.url, {
              headers: { accept: 'text/html,application/xhtml+xml,*/*' },
              proxy: ctx.getEngine().settings.proxy,
              rejectUnauthorized: !ctx.getEngine().settings.allowInvalidTls,
              timeoutMs: 20000,
            });
            page = r.res;
            finalUrl = r.url || item.url;
          } catch (e) {
            pageErrors.push({ url: item.url, error: e.message });
            continue;
          }
          const type = String(page.headers['content-type'] || '').toLowerCase();
          if (!/text\/html|application\/xhtml|text\/plain/.test(type)) {
            page.resume();
            continue;
          }
          let html = '';
          try {
            html = (await ctx.readLimited(page, 4 * 1024 * 1024)).toString('utf8');
          } catch (e) {
            pageErrors.push({ url: item.url, error: e.message });
            continue;
          }
          const found = extractLinks(html, finalUrl, { includeAssets, includeMedia, includePages: depth > 0 });
          const safe = await filterPrivateLinks(found, allowPrivate);
          for (const link of safe) {
            if (!links.has(link.url) && links.size < maxLinks) links.set(link.url, link);
            if (item.depth < depth && isPageCandidate(link, finalUrl)) {
              if (!pagesSeen.has(link.url) && !queue.some((q) => q.url === link.url)) {
                queue.push({ url: link.url, depth: item.depth + 1 });
              }
            }
          }
        }
        const result = [...links.values()]
          .filter((link) => !link.page && (!extFilter.length || extFilter.includes(link.ext)))
          .slice(0, maxLinks);
        return json(res, 200, {
          ok: true,
          url: pageUrl,
          count: result.length,
          links: result,
          pages: pagesSeen.size,
          errors: pageErrors,
          skipped: Math.max(0, links.size - result.length),
        });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (pathname === '/api/downloads/export' && method === 'GET') {
      const payload = JSON.stringify(ctx.getEngine().exportList(), null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Content-Disposition': 'attachment; filename="downloadx-tasks.json"',
        'Cache-Control': 'no-store',
        ...ctx.securityHeaders,
      });
      return res.end(payload);
    }

    if (pathname === '/api/downloads/import' && method === 'POST') {
      const body = await readBody(req);
      const result = ctx.getEngine().importList(body, {
        startNow: !!(body && body.startNow),
      });
      return json(res, 201, result);
    }

    if (pathname === '/api/downloads' && method === 'POST') {
      const body = await readBody(req);
      let urls = [];
      if (Array.isArray(body.urls)) urls = body.urls;
      else if (typeof body.url === 'string') urls = [body.url];
      else if (typeof body.text === 'string') urls = expandPatternDetailed(body.text).urls;
      urls = urls.filter((u) => /^(https?|ftps?):\/\//i.test(String(u).trim())).map((u) => String(u).trim());
      urls = [...new Set(urls)];
      if (!urls.length) return json(res, 400, { error: 'No valid http(s) or ftp(s) URL supplied' });
      const mirrors = Array.isArray(body.mirrors)
        ? body.mirrors.filter((u) => /^(https?|ftps?):\/\//i.test(String(u))).map((u) => String(u).trim())
        : [];
      const mirrorList = [...new Set(mirrors)].filter((m) => !urls.includes(m));
      const base = {
        filename: typeof body.filename === 'string' ? body.filename : '',
        category: typeof body.category === 'string' ? body.category : undefined,
        segments: body.segments,
        speedLimitKBs: body.speedLimitKBs ? body.speedLimitKBs * 1024 : body.speedLimit,
        referer: body.referer,
        cookies: body.cookies,
        headers: body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers) ? body.headers : undefined,
        username: typeof body.username === 'string' ? body.username : '',
        password: typeof body.password === 'string' ? body.password : '',
        proxy: typeof body.proxy === 'string' ? body.proxy : '',
        dir: body.dir,
        startedPaused: !!body.startedPaused,
        expectedChecksum: body.expectedChecksum || body.checksum || '',
        checksumAlgo: body.checksumAlgo || body.algo || '',
        priority: body.priority,
        schedule: body.schedule,
        dependsOn: body.dependsOn,
      };
      try {
        if (urls.length > 1) {
          const created = urls.map((u) => ctx.getEngine().add({
            urls: [u, ...mirrorList],
            ...base,
            filename: '',
            skipSave: true,
          }));
          ctx.getEngine().saveNow();
          return json(res, 201, { batch: created.map((d) => d.snapshot()), count: created.length });
        }
        const d = ctx.getEngine().add({ urls: [urls[0], ...mirrorList], ...base });
        return json(res, 201, d.snapshot());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    let m = /^\/api\/downloads\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      const d = ctx.getEngine().get(m[1]);
      return d ? json(res, 200, d.snapshot()) : json(res, 404, { error: 'Download not found' });
    }

    m = /^\/api\/downloads\/([^/]+)\/(.+)$/.exec(pathname);
    if (m) {
      const [, id, action] = m;
      const d = ctx.getEngine().get(id);
      if (!d) return json(res, 404, { error: 'Download not found' });
      if (method === 'POST') {
        const body = action.includes('open') ? {} : await readBody(req).catch(() => ({}));
        switch (action) {
          case 'pause': await d.pause('user'); return json(res, 200, d.snapshot());
          case 'resume': d.resume(); ctx.getEngine().markDirty(); return json(res, 200, d.snapshot());
          case 'retry': d.retry(); return json(res, 200, d.snapshot());
          case 'restart': await d.restart(); return json(res, 200, d.snapshot());
          case 'cancel': await d.cancel(); return json(res, 200, d.snapshot());
          case 'refresh': {
            const next = String(body.url || '').trim();
            if (!/^(https?|ftps?):\/\//i.test(next)) {
              return json(res, 400, { error: 'A valid http(s) or ftp(s) URL is required' });
            }
            d.urls = [next, ...(d.urls || []).filter((u) => u !== next)];
            d.finalUrl = next;
            d._urlIdx = 0;
            d._probeIdx = 0;
            await d.restart();
            ctx.getEngine().saveNow();
            return json(res, 200, d.snapshot());
          }
          case 'priority':
            d.priority = Math.max(-100, Math.min(100, parseInt(body.value, 10) || 0));
            ctx.getEngine().saveNow();
            return json(res, 200, d.snapshot());
          case 'limit':
            d.setSpeedLimit((parseInt(body.kbs, 10) || 0) * 1024);
            ctx.getEngine().saveNow();
            return json(res, 200, d.snapshot());
          case 'segments':
            if (!['queued', 'paused', 'failed'].includes(d.status)) {
              return json(res, 409, { error: 'Pause the download before changing connections' });
            }
            d.segmentsWanted = Math.max(1, Math.min(64, parseInt(body.value, 10) || d.segmentsWanted));
            ctx.getEngine().saveNow();
            return json(res, 200, d.snapshot());
          case 'quality': {
            const index = parseInt(body.index, 10);
            if (!Number.isInteger(index) || index < 0 || index >= (d.variants || []).length) {
              return json(res, 400, { error: 'Unknown quality' });
            }
            d.variantIndex = index;
            // Another quality is a different file: throw the old one away.
            try { fs.unlinkSync(d.finalPath); } catch { /* nothing there */ }
            await d.restart();
            ctx.getEngine().saveNow();
            return json(res, 200, d.snapshot());
          }
          case 'zip-entries': {
          if (!fs.existsSync(d.finalPath)) return json(res, 404, { error: 'The file is not on disk yet' });
          let index;
          try {
            index = await readLocalIndex(d.finalPath);
          } catch (e) {
            return json(res, 500, { error: e.message });
          }
          if (!index) return json(res, 400, { error: 'Not a ZIP archive' });
          return json(res, 200, {
            ok: true,
            count: index.entries.length,
            entries: index.entries.map((e) => ({
              name: sanitizeName(e.name),
              size: e.uncompressedSize,
              compressed: e.compressedSize,
              method: e.method,
            })),
          });
        }
        case 'extract-entries': {
          if (!fs.existsSync(d.finalPath)) return json(res, 404, { error: 'The file is not on disk yet' });
          const wanted = Array.isArray(body.names) ? body.names.map((n) => String(n)) : [];
          if (!wanted.length) return json(res, 400, { error: 'No entries were named' });
          let index;
          try {
            index = await readLocalIndex(d.finalPath);
          } catch (e) {
            return json(res, 500, { error: e.message });
          }
          if (!index) return json(res, 400, { error: 'Not a ZIP archive' });
          const extracted = [];
          const failed = [];
          for (const name of wanted) {
            const entry = index.entries.find((e) => e.name === name || sanitizeName(e.name) === sanitizeName(name));
            if (!entry) { failed.push({ name, error: 'Not in the archive' }); continue; }
            const out = path.join(d.destDir, path.basename(sanitizeName(entry.name)));
            const result = await extractEntry(d.finalPath, entry, out);
            if (result.ok) extracted.push({ name: entry.name, path: out, bytes: result.bytes });
            else failed.push({ name: entry.name, error: result.error });
          }
          return json(res, 200, { ok: failed.length === 0, extracted, failed });
        }
        case 'schedule': {
          if (body.schedule === null) d.schedule = null;
          else d.schedule = normalizeSchedule(body.schedule);
          if ('dependsOn' in body) {
            const parent = typeof body.dependsOn === 'string' && body.dependsOn ? body.dependsOn : null;
            if (parent && !ctx.getEngine().items.has(parent)) {
              return json(res, 400, { error: 'The download it should wait for does not exist' });
            }
            d.dependsOn = parent;
            if (parent && !ctx.getEngine()._noCycle(d.id)) {
              d.dependsOn = null;
              return json(res, 400, { error: 'That would create a loop between the downloads' });
            }
          }
          ctx.getEngine().saveNow();
          return json(res, 200, d.snapshot());
        }
        case 'verify': {
            try {
              const result = await d.verifyChecksum(body.algo || d.checksumAlgo, body.expected || d.expectedChecksum || '');
              return json(res, 200, result);
            } catch (e) { return json(res, 400, { error: e.message }); }
          }
          case 'open-file': {
            if (!fs.existsSync(d.finalPath)) return json(res, 404, { error: 'File not found on disk' });
            ctx.openPath(d.finalPath, false);
            return json(res, 200, { ok: true });
          }
          case 'open-folder': {
            if (!fs.existsSync(d.destDir)) return json(res, 404, { error: 'Folder not found on disk' });
            ctx.openPath(d.finalPath, true);
            return json(res, 200, { ok: true });
          }
          default: return json(res, 400, { error: 'Unknown action' });
        }
      }
    }

    m = /^\/api\/downloads\/([^/]+)$/.exec(pathname);
    if (m && method === 'DELETE') {
      const ok = await ctx.getEngine().remove(m[1], query.get('file') === '1');
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
    }

    if (pathname === '/api/settings' && method === 'GET') return json(res, 200, ctx.getEngine().settings);
    if (pathname === '/api/settings' && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      const allowed = ['rootDir', 'maxConcurrent', 'maxConnections', 'defaultSegments', 'globalSpeedLimit',
        'organizeByCategory', 'scheduleEnabled', 'scheduleFrom', 'scheduleTo', 'shutdownWhenDone', 'proxy',
        'allowInvalidTls', 'notifications', 'notificationSound', 'updateUrl', 'maxRetries', 'webhookUrl',
        'allowPrivateNetworks', 'avScanEnabled', 'avTimeoutMs', 'writeMarkOfTheWeb', 'hourlyQuota'];
      const patch = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      ctx.getEngine().settings = normalizeSettings(patch, ctx.getEngine().settings);
      ctx.getEngine().bucket.setRate(ctx.getEngine().settings.globalSpeedLimit);
      try { fs.mkdirSync(ctx.getEngine().settings.rootDir, { recursive: true }); } catch { /* best effort */ }
      ctx.getEngine().saveNow();
      return json(res, 200, ctx.getEngine().settings);
    }

    if (pathname === '/api/pause-all' && method === 'POST') { ctx.getEngine().pauseAll('user'); return json(res, 200, { ok: true }); }
    if (pathname === '/api/resume-all' && method === 'POST') { ctx.getEngine().resumeAll(); return json(res, 200, { ok: true }); }
    if (pathname === '/api/cancel-shutdown' && method === 'POST') { ctx.getEngine().cancelShutdown(); return json(res, 200, { ok: true }); }
    if (pathname === '/api/retry-failed' && method === 'POST') { return json(res, 200, { retried: ctx.getEngine().retryAllFailed() }); }
    if (pathname === '/api/clear-finished' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const removed = await ctx.getEngine().clearFinished(!!body.deleteFiles);
      return json(res, 200, { removed });
    }
    if (pathname === '/api/extension/info' && method === 'GET') {
      const dir = ctx.extension.dir;
      return json(res, 200, {
        ok: true,
        mode: ctx.extension.mode,
        folder: ctx.extension.folder(),
        chromeFolder: path.join(dir, 'chrome'),
        firefoxFolder: path.join(dir, 'firefox'),
        chromeStoreId: ctx.extension.chromeStoreId,
        edgeStoreId: ctx.extension.edgeStoreId,
        firefoxAddonId: ctx.extension.firefoxId,
        crx: fs.existsSync(path.join(dir, 'downloadx.crx')),
        updates: fs.existsSync(path.join(dir, 'updates.xml')),
      });
    }
    if (pathname === '/api/extension/install' && method === 'POST') {
      const folder = ctx.extension.folder();
      const storeUrl = ctx.extension.chromeStoreId
        ? `https://chromewebstore.google.com/detail/${encodeURIComponent(ctx.extension.chromeStoreId)}`
        : '';
      const mode = (ctx.extension.mode === 'store' || ctx.extension.mode === 'auto') && storeUrl ? 'store' : 'folder';
      ctx.openPath(mode === 'store' ? storeUrl : folder, false);
      return json(res, 200, {
        ok: true,
        mode,
        storeUrl,
        folder,
        chromeStoreId: ctx.extension.chromeStoreId,
        edgeStoreId: ctx.extension.edgeStoreId,
        firefoxAddonId: ctx.extension.firefoxId,
        crx: fs.existsSync(path.join(ctx.extension.dir, 'downloadx.crx')),
      });
    }
    if (pathname === '/api/quit' && method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => ctx.quit(0), 100);
      return;
    }

    return json(res, 404, { error: 'Unknown API route' });
  }

  return { handleApi, json, readBody, corsHeaders };
}

module.exports = { createApiRouter };
