'use strict';
/* downloadX Connector — Chrome/Edge (MV3) and Firefox (MV3 event page).
 *
 * Catches browser downloads the way IDM does: when interception is on (default),
 * every download the browser starts is handed to the local downloadX server.
 * The browser copy is only cancelled AFTER downloadX accepted the job, so a
 * download is never lost when the server is down.
 *
 * The connector is wrapped in createConnector() so tests can drive it with a
 * mocked extension API; in a real browser it auto-wires below.
 */

const DEFAULT_API = 'http://127.0.0.1:9765';
const NATIVE_HOST = 'com.downloadx.host';
const SEEN_TTL_MS = 60000;
const DOWN_BACKOFF_MS = 20000;
const MEDIA_TTL_MS = 600000;
const MEDIA_PER_TAB = 25;

const SETTINGS_DEFAULTS = {
  intercept: true,
  mediaSniff: true,
  floatingButton: true,
  clipboardWatch: true,
  mediaMinSize: 1048576,
  excludeSites: [],
  skipExts: [],
};

const HLS_MIME = /(mpegurl|x-mpegurl|vnd\.apple\.mpegurl)/i;
const DASH_MIME = /dash\+xml/i;
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ts', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wav', 'opus', 'wma']);

function isDownloadUrl(value) {
  return /^(https?|ftps?):\/\//i.test(String(value || ''));
}

function extOf(value) {
  try {
    const base = new URL(value).pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

function isExcluded(url, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const href = u.href.toLowerCase();
  return patterns.some((raw) => {
    const p = String(raw || '').trim().toLowerCase();
    if (!p) return false;
    if (p.includes('://')) return href === p || href.startsWith(p.endsWith('/') ? p : p + '/') || href.startsWith(p);
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    const bare = p.replace(/^\./, '');
    return host === bare || host.endsWith('.' + bare);
  });
}

function classifyMedia(url, mime, size) {
  if (!isDownloadUrl(url)) return null;
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  const ext = extOf(url);
  let kind = null;
  if (HLS_MIME.test(type) || ext === 'm3u8') kind = 'hls';
  else if (DASH_MIME.test(type) || ext === 'mpd') kind = 'dash';
  else if (/^video\//.test(type) || VIDEO_EXT.has(ext)) kind = 'video';
  else if (/^audio\//.test(type) || AUDIO_EXT.has(ext)) kind = 'audio';
  if (!kind) return null;
  return { url, kind, type, size: size > 0 ? size : 0 };
}

function createConnector(ext, deps = {}) {
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const now = deps.now || (() => Date.now());
  const setTimeoutImpl = deps.setTimeout || setTimeout;
  const clearTimeoutImpl = deps.clearTimeout || clearTimeout;

  let menuChain = Promise.resolve();
  let lastDownAt = 0;
  const seen = new Map();
  const mediaByTab = new Map();

  /* Works with both promise-based (Firefox browser.*) and callback-based
   * (Chrome chrome.*) extension APIs. */
  function apiCall(fn, self, args) {
    return new Promise((resolve) => {
      let settled = false;
      const cb = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const r = fn.apply(self, args.concat([cb]));
        if (r && typeof r.then === 'function') r.then(cb, () => cb(undefined));
      } catch {
        cb(undefined);
      }
    });
  }

  async function getApi() {
    const stored = await apiCall(ext.storage.local.get, ext.storage.local, ['apiBase']);
    return String((stored && stored.apiBase) || DEFAULT_API).replace(/\/+$/, '');
  }

  async function setApiBase(port) {
    const p = parseInt(port, 10) || 0;
    if (!p || p === 9765) return;
    await apiCall(ext.storage.local.set, ext.storage.local, [{ apiBase: 'http://127.0.0.1:' + p }]);
  }

  async function setBadge(text, color) {
    await apiCall(ext.action.setBadgeText, ext.action, [{ text }]);
    if (color) await apiCall(ext.action.setBadgeBackgroundColor, ext.action, [{ color }]);
  }

  async function getSettings() {
    const keys = Object.keys(SETTINGS_DEFAULTS);
    const stored = (await apiCall(ext.storage.local.get, ext.storage.local, [keys])) || {};
    const out = {};
    out.intercept = stored.intercept === undefined ? SETTINGS_DEFAULTS.intercept : !!stored.intercept;
    out.mediaSniff = stored.mediaSniff === undefined ? SETTINGS_DEFAULTS.mediaSniff : !!stored.mediaSniff;
    out.floatingButton = stored.floatingButton === undefined ? SETTINGS_DEFAULTS.floatingButton : !!stored.floatingButton;
    out.clipboardWatch = stored.clipboardWatch === undefined ? SETTINGS_DEFAULTS.clipboardWatch : !!stored.clipboardWatch;
    out.mediaMinSize = Number.isFinite(Number(stored.mediaMinSize)) && Number(stored.mediaMinSize) >= 0
      ? Number(stored.mediaMinSize) : SETTINGS_DEFAULTS.mediaMinSize;
    out.excludeSites = Array.isArray(stored.excludeSites) ? stored.excludeSites : [];
    out.skipExts = Array.isArray(stored.skipExts) ? stored.skipExts : [];
    return out;
  }

  async function getIntercept() {
    return (await getSettings()).intercept;
  }

  async function refreshBadge() {
    const on = await getIntercept();
    await setBadge(on ? 'ON' : '', '#6366f1');
  }

  function mediaForTab(tabId) {
    const at = now();
    const list = mediaByTab.get(tabId) || [];
    const alive = list.filter((m) => at - m.at < MEDIA_TTL_MS);
    if (alive.length !== list.length) mediaByTab.set(tabId, alive);
    return alive.map((m) => ({ url: m.url, kind: m.kind, type: m.type, size: m.size }));
  }

  async function addMedia(tabId, entry) {
    if (tabId < 0) return;
    const list = mediaByTab.get(tabId) || [];
    const dup = list.findIndex((m) => m.url === entry.url);
    if (dup >= 0) list.splice(dup, 1);
    list.unshift(Object.assign({ at: now() }, entry));
    mediaByTab.set(tabId, list.slice(0, MEDIA_PER_TAB));
    await notifyTab(tabId);
  }

  async function notifyTab(tabId) {
    if (!ext.tabs || typeof ext.tabs.sendMessage !== 'function') return;
    await apiCall(ext.tabs.sendMessage, ext.tabs, [tabId, { type: 'dlx:media', items: mediaForTab(tabId) }]);
  }

  async function shouldIntercept(item, settings) {
    const s = settings || (await getSettings());
    if (!s.intercept) return false;
    const url = (item && (item.finalUrl || item.url)) || '';
    if (!isDownloadUrl(url)) return false;
    if (isExcluded(url, s.excludeSites)) return false;
    const ext = extOf(url);
    const skip = s.skipExts.map((e) => String(e || '').trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    if (ext && skip.includes(ext)) return false;
    return true;
  }

  async function onHeadersReceived(details) {
    try {
      if (!details || typeof details.url !== 'string') return;
      if (typeof details.tabId === 'number' && details.tabId < 0) return;
      const settings = await getSettings();
      if (!settings.mediaSniff) return;
      if (isExcluded(details.url, settings.excludeSites)) return;
      const headers = details.responseHeaders || [];
      let mime = '';
      let size = 0;
      for (const h of headers) {
        const name = String(h.name || '').toLowerCase();
        if (name === 'content-type') mime = String(h.value || '');
        else if (name === 'content-length') size = parseInt(h.value, 10) || 0;
      }
      const entry = classifyMedia(details.url, mime, size);
      if (!entry) return;
      const playlist = entry.kind === 'hls' || entry.kind === 'dash';
      if (!playlist && settings.mediaMinSize > 0 && entry.size > 0 && entry.size < settings.mediaMinSize) return;
      await addMedia(typeof details.tabId === 'number' ? details.tabId : -1, entry);
    } catch { /* never break the browser */ }
  }

  function onMessage(msg, sender, sendResponse) {
    const type = msg && msg.type;
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
    const respond = typeof sendResponse === 'function' ? sendResponse : () => {};
    if (type === 'dlx:getMedia') {
      respond({ ok: true, items: mediaForTab(tabId) });
      return false;
    }
    if (type === 'dlx:settings') {
      getSettings().then((settings) => respond({ ok: true, settings }), () => respond({ ok: false }));
      return true;
    }
    if (type === 'dlx:download') {
      (async () => {
        const url = msg.url;
        if (!isDownloadUrl(url)) return respond({ ok: false, error: 'invalid url' });
        const payload = { url };
        if (msg.filename) payload.filename = String(msg.filename).split(/[\\/]/).pop();
        const referer = msg.referer || (sender && sender.tab && sender.tab.url);
        if (referer && isDownloadUrl(referer)) payload.referer = referer;
        const cookies = await collectCookies(url);
        if (cookies) payload.cookies = cookies;
        respond(await handoff(payload));
      })();
      return true;
    }
    if (type === 'dlx:openOptions') {
      if (ext.runtime && typeof ext.runtime.openOptionsPage === 'function') {
        apiCall(ext.runtime.openOptionsPage, ext.runtime, []);
      }
      respond({ ok: true });
      return false;
    }
    return false;
  }

  async function pingServer(api, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(api + '/api/health', { signal: controller.signal });
      return !!(res && res.ok);
    } catch {
      return false;
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  async function postDownload(api, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(api + '/api/downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      return await res.json().catch(() => ({}));
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  function sendNative(msg) {
    if (!ext.runtime || typeof ext.runtime.sendNativeMessage !== 'function') return Promise.resolve(null);
    return apiCall(ext.runtime.sendNativeMessage, ext.runtime, [NATIVE_HOST, msg]).then((r) => r || null);
  }

  async function collectCookies(url) {
    if (!ext.cookies || typeof ext.cookies.getAll !== 'function') return '';
    try {
      const list = await apiCall(ext.cookies.getAll, ext.cookies, [{ url }]);
      if (!Array.isArray(list) || !list.length) return '';
      return list.map((c) => c.name + '=' + c.value).join('; ');
    } catch {
      return '';
    }
  }

  async function ensureHandoff(payload) {
    const api = await getApi();
    if (await pingServer(api, 1200)) {
      await postDownload(api, payload, 6000);
      const port = parseInt((api.match(/:(\d+)$/) || [])[1], 10) || 0;
      return { ok: true, port, via: 'http' };
    }
    const reply = await sendNative(Object.assign({ cmd: 'add' }, payload));
    if (reply && reply.ok) {
      await setApiBase(reply.port);
      return { ok: true, port: reply.port || 0, via: 'native' };
    }
    return { ok: false, error: (reply && reply.error) || 'downloadX unreachable' };
  }

  async function handoff(payload) {
    try {
      const result = await ensureHandoff(payload);
      if (result.ok) {
        await setBadge('✓', '#22c55e');
        setTimeoutImpl(() => { refreshBadge().catch(() => {}); }, 2500);
        return result;
      }
      lastDownAt = now();
      await setBadge('!', '#ef4444');
      return result;
    } catch (e) {
      lastDownAt = now();
      await setBadge('!', '#ef4444');
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function createMenus() {
    if (!ext.contextMenus) return Promise.resolve();
    return apiCall(ext.contextMenus.removeAll, ext.contextMenus, []).then(() => {
      const items = [
        { id: 'dlx-link', title: 'Download with downloadX', contexts: ['link'] },
        { id: 'dlx-video', title: 'Download video with downloadX', contexts: ['video', 'audio'] },
        { id: 'dlx-image', title: 'Download image with downloadX', contexts: ['image'] },
        { id: 'dlx-selection', title: 'Download URL in selection with downloadX', contexts: ['selection'] },
        { id: 'dlx-page', title: 'Download this page with downloadX', contexts: ['page'] },
      ];
      for (const item of items) {
        try { ext.contextMenus.create(item); } catch { /* duplicate id */ }
      }
    });
  }

  function setupMenus() {
    menuChain = menuChain.then(createMenus).catch(() => {});
    return menuChain;
  }

  function guessName(urlStr, info) {
    try {
      if (info && info.fileName) return info.fileName;
      const u = new URL(urlStr);
      const base = u.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(base.split(/[?#]/)[0]) || undefined;
    } catch {
      return undefined;
    }
  }

  async function onMenuClicked(info, tab) {
    let url = null;
    switch (info.menuItemId) {
      case 'dlx-link': url = info.linkUrl; break;
      case 'dlx-video': url = info.srcUrl || (tab && tab.url); break;
      case 'dlx-image': url = info.srcUrl || info.linkUrl; break;
      case 'dlx-selection': {
        const s = (info.selectionText || '').trim();
        if (isDownloadUrl(s)) url = s;
        break;
      }
      case 'dlx-page': url = tab && tab.url; break;
      default: return;
    }
    if (!url || !isDownloadUrl(url)) return;
    const payload = { url, filename: guessName(url, null) };
    if (tab && isDownloadUrl(tab.url)) payload.referer = tab.url;
    const cookies = await collectCookies(url);
    if (cookies) payload.cookies = cookies;
    await handoff(payload);
  }

  async function onActionClicked() {
    const on = !(await getIntercept());
    await apiCall(ext.storage.local.set, ext.storage.local, [{ intercept: on }]);
    await setBadge(on ? 'ON' : '', '#6366f1');
  }

  async function onCreated(item) {
    const settings = await getSettings();
    if (!(await shouldIntercept(item, settings))) return;
    const api = await getApi();
    if (item.url.startsWith(api)) return;
    const nowMs = now();
    if (nowMs - lastDownAt < DOWN_BACKOFF_MS) return;
    const key = item.url + '|' + (item.filename || '');
    if (seen.has(key) && nowMs - seen.get(key) < SEEN_TTL_MS) return;
    seen.set(key, nowMs);
    if (seen.size > 500) {
      for (const [k, t] of seen) if (nowMs - t > SEEN_TTL_MS) seen.delete(k);
      if (seen.size > 500) seen.clear();
    }
    const url = item.finalUrl || item.url;
    const name = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
    const payload = { url };
    if (name) payload.filename = name;
    if (item.referrer) payload.referer = item.referrer;
    const cookies = await collectCookies(url);
    if (cookies) payload.cookies = cookies;
    const result = await handoff(payload);
    if (!result.ok) return;
    try {
      await apiCall(ext.downloads.cancel, ext.downloads, [item.id]);
      await apiCall(ext.downloads.erase, ext.downloads, [{ id: item.id }]);
    } catch { /* already finished */ }
  }

  async function onInstalled() {
    const keys = Object.keys(SETTINGS_DEFAULTS);
    const stored = (await apiCall(ext.storage.local.get, ext.storage.local, [keys])) || {};
    const patch = {};
    for (const k of keys) if (stored[k] === undefined) patch[k] = SETTINGS_DEFAULTS[k];
    if (Object.keys(patch).length) await apiCall(ext.storage.local.set, ext.storage.local, [patch]);
    await setupMenus();
    await refreshBadge();
  }

  async function onRemoved(tabId) {
    mediaByTab.delete(tabId);
  }

  async function onStartup() {
    await setupMenus();
    await refreshBadge();
  }

  function init() {
    if (ext.runtime && ext.runtime.onInstalled) ext.runtime.onInstalled.addListener(onInstalled);
    if (ext.runtime && ext.runtime.onStartup) ext.runtime.onStartup.addListener(onStartup);
    if (ext.runtime && ext.runtime.onMessage) ext.runtime.onMessage.addListener(onMessage);
    if (ext.contextMenus && ext.contextMenus.onClicked) ext.contextMenus.onClicked.addListener(onMenuClicked);
    if (ext.downloads && ext.downloads.onCreated) ext.downloads.onCreated.addListener(onCreated);
    if (ext.action && ext.action.onClicked) ext.action.onClicked.addListener(onActionClicked);
    if (ext.webRequest && ext.webRequest.onHeadersReceived) {
      try {
        ext.webRequest.onHeadersReceived.addListener(
          onHeadersReceived,
          { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
          ['responseHeaders']
        );
      } catch { /* unsupported browser */ }
    }
    if (ext.tabs && ext.tabs.onRemoved) ext.tabs.onRemoved.addListener(onRemoved);
    setupMenus();
    refreshBadge().catch(() => {});
  }

  return {
    init, onInstalled, onStartup, onCreated, onMenuClicked, onActionClicked,
    setupMenus, handoff, ensureHandoff, getApi, getSettings, getIntercept, guessName, collectCookies,
    onHeadersReceived, onMessage, onRemoved, mediaForTab, shouldIntercept, classifyMedia, isExcluded, extOf,
    state: () => ({ lastDownAt, seen, mediaByTab }),
  };
}

const globalApi = typeof globalThis !== 'undefined' && (globalThis.browser || globalThis.chrome);
if (globalApi) createConnector(globalApi).init();

if (typeof module !== 'undefined' && module.exports) module.exports = { createConnector };
