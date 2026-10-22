'use strict';
/* downloadX floating button + clipboard watcher.
 *
 * Runs on every page. Shows a small "downloadX" button when the background
 * connector sniffed media for this tab, and offers a one-click chip when the
 * user copies a downloadable link. All UI lives in a shadow root so page CSS
 * cannot break it. Nothing here is required for basic interception: if the
 * background is unavailable the content script stays dormant.
 */
(() => {
  if (typeof window === 'undefined' || window.__dlxContent) return;
  window.__dlxContent = true;
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;
  /*
   * Firefox exposes the promise based "browser.*" API, Chrome the callback
   * based "chrome.*" API. Firefox treats a second argument as the options
   * object, so passing a callback there would silently break every message.
   */
  const promiseStyle = !!globalThis.browser && !globalThis.chrome;

  function send(msg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
      try {
        if (promiseStyle) {
          const r = api.runtime.sendMessage(msg);
          if (r && typeof r.then === 'function') r.then(finish, () => finish(null));
          else finish(null);
        } else {
          api.runtime.sendMessage(msg, (resp) => finish(resp));
        }
      } catch { finish(null); }
    });
  }

  let settings = { floatingButton: true, clipboardWatch: true };
  let media = [];
  let host = null;
  let shadow = null;
  let toggleBtn = null;
  let panel = null;
  let listEl = null;
  let statusEl = null;
  let chipWrap = null;
  let chip = null;
  let chipTimer = 0;
  let pendingClipboard = '';

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .dlx-btn, .dlx-chip, .dlx-x, .dlx-opts, .dlx-dl {
      font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
      border: 0; border-radius: 8px; cursor: pointer;
    }
    .dlx-btn {
      background: #6366f1; color: #fff; padding: 9px 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,.28);
    }
    .dlx-btn:hover, .dlx-btn:focus-visible { background: #4f46e5; }
    .dlx-btn:focus-visible, .dlx-chip:focus-visible, .dlx-dl:focus-visible,
    .dlx-x:focus-visible, .dlx-opts:focus-visible { outline: 2px solid #facc15; outline-offset: 2px; }
    .dlx-count { opacity: .85; margin-left: 4px; }
    .dlx-panel {
      width: 340px; max-width: calc(100vw - 32px); margin-bottom: 8px;
      background: #111827; color: #e5e7eb; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,.4); overflow: hidden;
      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .dlx-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
    .dlx-head strong { font-size: 12px; letter-spacing: .02em; }
    .dlx-x { background: transparent; color: #9ca3af; font-size: 16px; padding: 2px 6px; }
    .dlx-x:hover { color: #fff; }
    .dlx-list { list-style: none; margin: 0; padding: 0 8px 8px; max-height: 46vh; overflow: auto; }
    .dlx-item { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 7px 6px; border-top: 1px solid #1f2937; }
    .dlx-kind { background: #1f2937; color: #a5b4fc; border-radius: 6px; padding: 2px 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .dlx-meta { overflow: hidden; }
    .dlx-host { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e5e7eb; }
    .dlx-sub { display: block; color: #9ca3af; font-size: 10px; }
    .dlx-dl { background: #374151; color: #fff; padding: 5px 9px; }
    .dlx-dl:hover:not(:disabled) { background: #4b5563; }
    .dlx-dl:disabled { opacity: .55; cursor: default; }
    .dlx-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-top: 1px solid #1f2937; }
    .dlx-status { color: #86efac; flex: 1; min-height: 14px; }
    .dlx-status[data-error="1"] { color: #fca5a5; }
    .dlx-opts { background: transparent; color: #9ca3af; padding: 2px 4px; }
    .dlx-opts:hover { color: #fff; }
    .dlx-chipwrap { margin-bottom: 8px; display: flex; justify-content: flex-end; }
    .dlx-chip { background: #0f172a; color: #e5e7eb; border: 1px solid #334155; padding: 8px 11px; box-shadow: 0 4px 14px rgba(0,0,0,.28); }
    .dlx-chip:hover:not(:disabled) { border-color: #6366f1; }
    .dlx-chip:disabled { opacity: .6; cursor: default; }
    [hidden] { display: none !important; }
  `;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureUi() {
    if (host || !document.documentElement) return;
    host = document.createElement('div');
    host.id = 'dlx-floating-root';
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    chipWrap = el('div', 'dlx-chipwrap');
    chip = el('button', 'dlx-chip', 'Download copied link');
    chip.type = 'button';
    chip.hidden = true;
    chipWrap.appendChild(chip);

    panel = el('section', 'dlx-panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Media found on this page');
    const head = el('div', 'dlx-head');
    const title = el('strong', null, 'Media on this page');
    const close = el('button', 'dlx-x', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close media panel');
    head.append(title, close);
    listEl = el('ul', 'dlx-list');
    panel.append(head, listEl);

    const foot = el('div', 'dlx-foot');
    statusEl = el('span', 'dlx-status');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    const opts = el('button', 'dlx-opts', 'Settings');
    opts.type = 'button';
    foot.append(statusEl, opts);
    panel.appendChild(foot);

    toggleBtn = el('button', 'dlx-btn');
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-haspopup', 'dialog');
    const label = el('span', null, 'downloadX');
    const count = el('span', 'dlx-count');
    count.setAttribute('aria-hidden', 'true');
    toggleBtn.append(label, count);

    shadow.append(chipWrap, panel, toggleBtn);

    close.addEventListener('click', () => setPanel(false));
    toggleBtn.addEventListener('click', () => setPanel(panel.hidden));
    opts.addEventListener('click', () => { send({ type: 'dlx:openOptions' }); });
    chip.addEventListener('click', onChipClick);
    shadow.addEventListener('click', (e) => { if (e.target === shadow) setPanel(false); });
    document.addEventListener('mousedown', (e) => {
      if (!panel.hidden && !host.contains(e.target)) setPanel(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { setPanel(false); toggleBtn.focus(); }
    }, true);

    (document.body || document.documentElement).appendChild(host);
  }

  function setPanel(open) {
    if (!panel) return;
    panel.hidden = !open;
    listEl.hidden = false;
    if (open) {
      renderList();
      const first = listEl.querySelector('button');
      if (first) first.focus();
    }
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.toggleAttribute('data-error', !!isError);
  }

  function humanSize(bytes) {
    if (!bytes || bytes < 1024) return bytes ? bytes + ' B' : '';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function filenameOf(item) {
    if (item.kind === 'hls' || item.kind === 'dash') return undefined;
    try {
      const base = new URL(item.url).pathname.split('/').filter(Boolean).pop() || '';
      const name = decodeURIComponent(base.split(/[?#]/)[0]);
      return name && name.includes('.') ? name : undefined;
    } catch { return undefined; }
  }

  function renderList() {
    if (!listEl) return;
    listEl.textContent = '';
    if (!media.length) {
      const empty = el('li', 'dlx-item');
      empty.append(el('span', 'dlx-meta', 'No media captured yet.'));
      listEl.appendChild(empty);
      return;
    }
    for (const item of media) {
      const li = el('li', 'dlx-item');
      const kind = el('span', 'dlx-kind', item.kind === 'hls' ? 'HLS' : item.kind === 'dash' ? 'DASH' : item.kind);
      const meta = el('span', 'dlx-meta');
      const hostName = el('span', 'dlx-host', hostOf(item.url));
      hostName.title = item.url;
      const sub = el('span', 'dlx-sub', [item.type, humanSize(item.size)].filter(Boolean).join(' \u00b7 '));
      meta.append(hostName, sub);
      const dl = el('button', 'dlx-dl', 'Download');
      dl.type = 'button';
      dl.addEventListener('click', () => download(item, dl));
      li.append(kind, meta, dl);
      listEl.appendChild(li);
    }
  }

  function render() {
    if (!host) return;
    renderList();
    const count = toggleBtn.querySelector('.dlx-count');
    count.textContent = media.length ? String(media.length) : '';
    toggleBtn.hidden = !(settings.floatingButton !== false && media.length > 0);
    toggleBtn.setAttribute('aria-label', 'downloadX: ' + media.length + ' media item' + (media.length === 1 ? '' : 's'));
    if (toggleBtn.hidden) setPanel(false);
  }

  async function download(item, btn) {
    btn.disabled = true;
    setStatus('Sending to downloadX\u2026');
    const res = await send({ type: 'dlx:download', url: item.url, filename: filenameOf(item), referer: location.href });
    if (res && res.ok) {
      media = media.filter((m) => m.url !== item.url);
      setStatus('Sent to downloadX.');
      render();
    } else {
      btn.disabled = false;
      setStatus((res && res.error) || 'downloadX is not reachable.', true);
    }
  }

  function hideChip() {
    if (!chip) return;
    chip.hidden = true;
    chip.disabled = false;
    chip.textContent = 'Download copied link';
    pendingClipboard = '';
  }

  function offerUrl(raw) {
    if (!settings.clipboardWatch || !chip) return;
    const text = String(raw || '').trim();
    if (!/^(https?|ftps?):\/\/[^\s]+$/i.test(text)) {
      // Something else was copied or pasted: the old offer is stale.
      if (!chip.hidden) hideChip();
      return;
    }
    if (text === pendingClipboard && !chip.hidden) return;
    pendingClipboard = text;
    chip.hidden = false;
    chip.disabled = false;
    chip.textContent = 'Download copied link';
    clearTimeout(chipTimer);
    chipTimer = setTimeout(hideChip, 10000);
  }

  async function onChipClick() {
    const url = pendingClipboard;
    if (!url) return;
    chip.disabled = true;
    chip.textContent = 'Sending\u2026';
    const res = await send({ type: 'dlx:download', url, referer: location.href });
    if (res && res.ok) {
      chip.textContent = 'Sent to downloadX';
      setStatus('Sent to downloadX.');
      clearTimeout(chipTimer);
      chipTimer = setTimeout(hideChip, 2500);
    } else {
      chip.disabled = false;
      chip.textContent = 'Retry download';
      setStatus((res && res.error) || 'downloadX is not reachable.', true);
    }
  }

  function onCopy(e) {
    // The copied text lives in the event, not in the selection: a user can
    // copy from the address bar or a context menu.
    try {
      const dt = e && e.clipboardData;
      if (dt) offerUrl(dt.getData('text'));
      else offerUrl(window.getSelection ? String(window.getSelection()) : '');
    } catch { /* ignore */ }
  }

  function onPaste(e) {
    try {
      const dt = e.clipboardData;
      if (dt) offerUrl(dt.getData('text'));
    } catch { /* ignore */ }
  }

  function start() {
    ensureUi();
    if (!host) return;
    render();
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'dlx:media') return;
      media = Array.isArray(msg.items) ? msg.items : [];
      render();
    });
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    send({ type: 'dlx:settings' }).then((r) => {
      if (r && r.ok && r.settings) { settings = Object.assign(settings, r.settings); render(); }
    });
    send({ type: 'dlx:getMedia' }).then((r) => {
      if (r && r.ok) { media = r.items || []; render(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
