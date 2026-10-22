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
const { extractLinks } = require('./scrape');
const { freeSpaceFor } = require('./util');
const { normalizeSettings } = require('./engine');

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
      try {
        const { res: page } = await httpget.request(pageUrl, {
          headers: { accept: 'text/html,application/xhtml+xml,*/*' },
          proxy: ctx.getEngine().settings.proxy,
          rejectUnauthorized: !ctx.getEngine().settings.allowInvalidTls,
          timeoutMs: 20000,
        });
        const html = (await ctx.readLimited(page, 4 * 1024 * 1024)).toString('utf8');
        const links = extractLinks(html, pageUrl, { includeAssets: !!body.includeAssets });
        return json(res, 200, { ok: true, url: pageUrl, count: links.length, links });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
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
        'allowInvalidTls', 'notifications', 'notificationSound', 'updateUrl', 'maxRetries', 'webhookUrl'];
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
