// downloadX extension UI tests — the content script and the options page run
// against a DOM shim, with the Chrome (callback) and Firefox (promise) APIs.
// Run: node test/extension-ui.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONTENT = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

/** A browser mock: 'chrome' uses callbacks, 'browser' uses promises. */
function makeBrowser(flavour, state) {
  const isPromise = flavour === 'browser';
  const runtime = {
    onMessage: { addListener(fn) { state.messageListener = fn; } },
    sendMessage(msg, callback) {
      state.sent.push(msg);
      if (isPromise) {
        return Promise.resolve(state.answers[msg.type] || null);
      }
      if (typeof callback === 'function') {
        setTimeout(() => callback(state.answers[msg.type] || null), 0);
        return undefined;
      }
      return undefined;
    },
    openOptionsPage(cb) { state.openedOptions = true; if (cb) cb(); },
  };
  const storage = {
    local: {
      get(key, callback) {
        const res = typeof key === 'string'
          ? (key in state.storage ? { [key]: state.storage[key] } : {})
          : { ...state.storage };
        if (isPromise) return Promise.resolve(res);
        if (typeof callback === 'function') { setTimeout(() => callback(res), 0); return undefined; }
        return undefined;
      },
      set(obj, callback) {
        Object.assign(state.storage, obj);
        state.written.push(obj);
        if (isPromise) return Promise.resolve();
        if (typeof callback === 'function') { setTimeout(() => callback(), 0); return undefined; }
        return undefined;
      },
    },
  };
  return isPromise ? { browser: { runtime, storage } } : { chrome: { runtime, storage } };
}

/** Run the content script with a fresh DOM and a browser mock. */
async function runContent(flavour, answers) {
  const state = { sent: [], written: [], storage: {}, answers: answers || {}, openedOptions: false };
  const dom = installDom({ html: '<html><body><p>page</p></body></html>' });
  const mock = makeBrowser(flavour, state);
  globalThis.chrome = mock.chrome || undefined;
  globalThis.browser = mock.browser || undefined;
  // The content script guards itself with window.__dlxContent.
  globalThis.window.__dlxContent = false;
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'globalThis', 'location', CONTENT)(
    globalThis.window, globalThis.document, globalThis, globalThis.window.location
  );
  await sleep(60);
  return { state, dom };
}

const MEDIA = [
  { url: 'https://cdn.example.com/clip.mp4', kind: 'video', type: 'video/mp4', size: 5 * 1024 * 1024 },
  { url: 'https://cdn.example.com/live.m3u8', kind: 'hls', type: 'application/vnd.apple.mpegurl', size: 0 },
];

/* ---------------- Chrome (callback style) ---------------- */
{
  const { state, dom } = await runContent('chrome', {
    'dlx:settings': { ok: true, settings: { floatingButton: true, clipboardWatch: true } },
    'dlx:getMedia': { ok: true, items: MEDIA },
  });
  const host = dom.doc.getElementById('dlx-floating-root');
  check('content (chrome): the floating button is created', !!host);
  check('content (chrome): it asks for the settings', state.sent.some((m) => m.type === 'dlx:settings'), JSON.stringify(state.sent.map((m) => m.type)));
  check('content (chrome): it asks for the media', state.sent.some((m) => m.type === 'dlx:getMedia'));

  // The media arrives later (the background pushes it).
  if (state.messageListener) {
    state.messageListener({ type: 'dlx:media', items: MEDIA });
    await sleep(20);
  }
  const shadow = host && host.shadowRoot;
  const btn = shadow && shadow.children.find((c) => c.classList.contains('dlx-btn'));
  check('content (chrome): the button shows the media count', btn && btn.children.length === 2, btn ? String(btn.children.length) : 'no button');
  check('content (chrome): the button is not hidden', btn && btn.hidden === false);
  dom.restore();
}

/* ---------------- Firefox (promise style) ---------------- */
{
  const { state, dom } = await runContent('browser', {
    'dlx:settings': { ok: true, settings: { floatingButton: true, clipboardWatch: true } },
    'dlx:getMedia': { ok: true, items: MEDIA },
  });
  check('content (firefox): it asks for the settings', state.sent.some((m) => m.type === 'dlx:settings'), JSON.stringify(state.sent.map((m) => m.type)));
  check('content (firefox): it asks for the media', state.sent.some((m) => m.type === 'dlx:getMedia'));
  if (state.messageListener) {
    state.messageListener({ type: 'dlx:media', items: MEDIA });
    await sleep(20);
  }
  const host = dom.doc.getElementById('dlx-floating-root');
  const shadow = host && host.shadowRoot;
  const btn = shadow && shadow.children.find((c) => c.classList.contains('dlx-btn'));
  check('content (firefox): the button appears with the media', !!btn && btn.hidden === false, btn ? String(btn.hidden) : 'no button');
  check('content (firefox): the button shows the media count', btn && btn.children.length === 2, btn ? String(btn.children.length) : 'no button');
  dom.restore();
}

/* ---------------- the clipboard chip uses the copied text ---------------- */
{
  const { state, dom } = await runContent('chrome', {
    'dlx:settings': { ok: true, settings: { floatingButton: true, clipboardWatch: true } },
    'dlx:getMedia': { ok: true, items: [] },
  });
  const host = dom.doc.getElementById('dlx-floating-root');
  const shadow = host && host.shadowRoot;
  const chip = shadow && shadow.children.find((c) => c.classList.contains('dlx-chipwrap'));
  const chipBtn = chip && chip.children[0];
  check('content: the clipboard chip exists', !!chipBtn);
  // Copy a link: the text comes from the clipboard event, not the selection.
  dom.doc.dispatch('copy', { clipboardData: { getData: () => 'https://cdn.example.com/file.zip' } });
  await sleep(20);
  check('content: the chip offers the copied link', chipBtn && chipBtn.hidden === false, chipBtn ? String(chipBtn.hidden) : 'no chip');
  dom.doc.dispatch('copy', { clipboardData: { getData: () => 'not a link' } });
  await sleep(20);
  check('content: a copied text that is no link is ignored', !chipBtn || chipBtn.hidden === true);
  dom.restore();
}

/* ---------------- the options page ---------------- */
{
  for (const flavour of ['chrome', 'browser']) {
    const state = { sent: [], written: [], storage: { apiBase: 'http://127.0.0.1:9765', intercept: true }, answers: {}, openedOptions: false };
    const dom = installDom({
      html: [
        '<html><body><form id="opts">',
        '<input id="apiBase" value=""><input type="checkbox" id="intercept">',
        '<input type="checkbox" id="mediaSniff"><input type="checkbox" id="floatingButton">',
        '<input type="checkbox" id="clipboardWatch"><input id="mediaMinSize" value="1">',
        '<textarea id="excludeSites"></textarea><input id="skipExts" value="">',
        '<span id="status"></span><button id="test"></button><button id="openUi"></button>',
        '</form></body></html>',
      ].join(''),
    });
    const mock = makeBrowser(flavour, state);
    globalThis.chrome = mock.chrome || undefined;
    globalThis.browser = mock.browser || undefined;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '1.5.0' }) });
    const optionsSrc = fs.readFileSync(path.join(ROOT, 'extension', 'options.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'globalThis', 'fetch', 'Notification', optionsSrc)(
      globalThis.window, globalThis.document, globalThis, globalThis.fetch, undefined
    );
    await sleep(60);
    const apiBase = dom.byId.get('apiBase');
    check(`options (${flavour}): the saved api base is loaded`, apiBase && apiBase.value === 'http://127.0.0.1:9765', apiBase ? apiBase.value : 'missing');
    const intercept = dom.byId.get('intercept');
    check(`options (${flavour}): the saved switches are loaded`, intercept && intercept.checked === true);
    dom.restore();
  }
}

/* ---------------- report ---------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
  process.exit(1);
}
process.exit(0);
