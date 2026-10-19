'use strict';
/* downloadX Connector — talks to the local downloadX server (127.0.0.1:9765) */

const DEFAULT_API = 'http://127.0.0.1:9765';
const SEEN_TTL_MS = 60000;

async function getApi() {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  return (apiBase || DEFAULT_API).replace(/\/+$/, '');
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

async function sendToDownloadX(url, filename, referer) {
  const api = await getApi();
  try {
    const res = await fetch(api + '/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename, referer }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    await setBadge('✓', '#22c55e');
    setTimeout(() => refreshBadge(), 2500);
    return true;
  } catch (e) {
    console.warn('downloadX not reachable at', api, e.message);
    await setBadge('!', '#ef4444');
    return false;
  }
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dlx-link', title: 'Download with downloadX', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'dlx-video', title: 'Download video with downloadX', contexts: ['video'] });
    chrome.contextMenus.create({ id: 'dlx-audio', title: 'Download audio with downloadX', contexts: ['audio'] });
    chrome.contextMenus.create({ id: 'dlx-image', title: 'Download image with downloadX', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'dlx-selection', title: 'Download URL in selection with downloadX', contexts: ['selection'] });
  });
}

async function refreshBadge() {
  const { intercept } = await chrome.storage.local.get('intercept');
  await setBadge(intercept ? 'ON' : '', '#6366f1');
}

chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  createMenus();
  await refreshBadge();
});

function guessName(urlStr, info) {
  try {
    if (info && info.fileName) return info.fileName;
    const u = new URL(urlStr);
    const base = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(base.split(/[?#]/)[0]) || undefined;
  } catch { return undefined; }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url = null;
  if (info.menuItemId === 'dlx-link') url = info.linkUrl;
  else if (info.menuItemId === 'dlx-video') url = info.srcUrl || info.pageUrl;
  else if (info.menuItemId === 'dlx-audio') url = info.srcUrl;
  else if (info.menuItemId === 'dlx-image') url = info.srcUrl || info.linkUrl;
  else if (info.menuItemId === 'dlx-selection') {
    const s = (info.selectionText || '').trim();
    if (/^https?:\/\//i.test(s)) url = s;
  }
  if (!url || !/^https?:\/\//i.test(url)) return;
  sendToDownloadX(url, guessName(url, null), tab && tab.url);
});

/* ---- click the toolbar icon to toggle full interception of browser downloads ---- */
async function getIntercept() {
  const { intercept } = await chrome.storage.local.get('intercept');
  return !!intercept;
}

chrome.action.onClicked.addListener(async () => {
  const on = !(await getIntercept());
  await chrome.storage.local.set({ intercept: on });
  await setBadge(on ? 'ON' : '', '#6366f1');
});

const seen = new Map();

chrome.downloads.onCreated.addListener(async (item) => {
  if (!(await getIntercept())) return;
  if (!item.url || !/^https?:/i.test(item.url)) return;
  const api = await getApi();
  if (item.url.startsWith(api)) return;
  const key = item.url + '|' + (item.filename || '');
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < SEEN_TTL_MS) return;
  seen.set(key, now);
  if (seen.size > 500) {
    for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
    if (seen.size > 500) seen.clear();
  }
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch { /* already finished */ }
  const name = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
  await sendToDownloadX(item.finalUrl || item.url, name, undefined);
});
