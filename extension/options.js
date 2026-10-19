'use strict';
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const DEFAULTS = {
    apiBase: 'http://127.0.0.1:9765',
    intercept: true,
    mediaSniff: true,
    floatingButton: true,
    clipboardWatch: true,
    mediaMinSize: 1048576,
    excludeSites: [],
    skipExts: [],
  };

  function call(fn, arg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v || {}); } };
      try {
        const r = fn.call(api.storage.local, arg, (v) => finish(v));
        if (r && typeof r.then === 'function') r.then(finish, () => finish({}));
      } catch { finish({}); }
    });
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.toggleAttribute('data-error', !!isError);
  }

  function splitSites(value) {
    return String(value || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  }

  function splitExts(value) {
    return String(value || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  }

  function apiBase() {
    return String($('apiBase').value || '').trim().replace(/\/+$/, '') || DEFAULTS.apiBase;
  }

  async function load() {
    const stored = await call(api.storage.local.get, [
      'apiBase', 'intercept', 'mediaSniff', 'floatingButton', 'clipboardWatch',
      'mediaMinSize', 'excludeSites', 'skipExts',
    ]);
    $('apiBase').value = stored.apiBase || DEFAULTS.apiBase;
    $('intercept').checked = stored.intercept === undefined ? DEFAULTS.intercept : !!stored.intercept;
    $('mediaSniff').checked = stored.mediaSniff === undefined ? DEFAULTS.mediaSniff : !!stored.mediaSniff;
    $('floatingButton').checked = stored.floatingButton === undefined ? DEFAULTS.floatingButton : !!stored.floatingButton;
    $('clipboardWatch').checked = stored.clipboardWatch === undefined ? DEFAULTS.clipboardWatch : !!stored.clipboardWatch;
    const bytes = Number.isFinite(Number(stored.mediaMinSize)) ? Number(stored.mediaMinSize) : DEFAULTS.mediaMinSize;
    $('mediaMinSize').value = (bytes / 1048576).toFixed(bytes % 1048576 ? 1 : 0);
    $('excludeSites').value = (Array.isArray(stored.excludeSites) ? stored.excludeSites : []).join('\n');
    $('skipExts').value = (Array.isArray(stored.skipExts) ? stored.skipExts : []).join(', ');
  }

  async function save(event) {
    if (event) event.preventDefault();
    const mb = Math.max(0, Number($('mediaMinSize').value) || 0);
    const patch = {
      apiBase: apiBase(),
      intercept: $('intercept').checked,
      mediaSniff: $('mediaSniff').checked,
      floatingButton: $('floatingButton').checked,
      clipboardWatch: $('clipboardWatch').checked,
      mediaMinSize: Math.round(mb * 1048576),
      excludeSites: splitSites($('excludeSites').value),
      skipExts: splitExts($('skipExts').value),
    };
    await call(api.storage.local.set, patch);
    setStatus('Saved.', false);
  }

  async function testConnection() {
    setStatus('Checking\u2026', false);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, 2500);
    try {
      const res = await fetch(apiBase() + '/api/health', controller ? { signal: controller.signal } : undefined);
      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus('Connected. downloadX' + (data.version ? ' ' + data.version : '') + ' is running.', false);
      } else {
        setStatus('downloadX responded with HTTP ' + (res ? res.status : '?') + '.', true);
      }
    } catch {
      setStatus('downloadX is not reachable. Start the app and try again.', true);
    } finally {
      clearTimeout(timer);
    }
  }

  function openUi() {
    try { window.open(apiBase(), '_blank', 'noopener'); } catch { /* popup blocked */ }
  }

  $('opts').addEventListener('submit', save);
  $('test').addEventListener('click', testConnection);
  $('openUi').addEventListener('click', openUi);
  load().catch(() => setStatus('Could not read settings.', true));
})();
