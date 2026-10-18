'use strict';
/* downloadX Connector — talks to the local downloadX server (127.0.0.1:9765) */

const API = 'http://127.0.0.1:9765';

async function sendToDownloadX(url, filename, referer) {
  try {
    await fetch(API + '/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename, referer }),
    });
  } catch (e) {
    console.warn('downloadX not reachable at', API, e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dlx-link', title: 'Download with downloadX', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'dlx-video', title: 'Download video with downloadX', contexts: ['video'] });
    chrome.contextMenus.create({ id: 'dlx-audio', title: 'Download audio with downloadX', contexts: ['audio'] });
    chrome.contextMenus.create({ id: 'dlx-image', title: 'Download image with downloadX', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'dlx-selection', title: 'Download URL in selection with downloadX', contexts: ['selection'] });
  });
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
  if (!url) return;
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
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
});

const seen = new Set();   // prevent cancel→forward→detect loops

chrome.downloads.onCreated.addListener(async (item) => {
  if (!(await getIntercept())) return;
  if (!item.url || !/^https?:/i.test(item.url) || item.url.startsWith(API)) return;
  const key = item.url + '|' + (item.filename || '');
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 500) seen.clear();
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch { /* already finished */ }
  const name = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
  sendToDownloadX(item.finalUrl || item.url, name, undefined);
});
