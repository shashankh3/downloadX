// downloadX extension connector tests — mocked browser API, no browser needed.
// Run: node test/extension.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createConnector } = require('../extension/background.js');
const { firefoxManifest } = require('../installer/extension-tools.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function makeChrome() {
  const state = {
    storage: {},
    listeners: {},
    fetchCalls: [],
    nativeCalls: [],
    nativeReply: null,
    canceled: [],
    erased: [],
    badges: [],
    menus: [],
    cookies: [],
    serverUp: true,
    postFails: false,
    tabMessages: [],
    openedOptions: false,
    headersFilter: null,
  };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (f) => { state.listeners.installed = f; } },
      onStartup: { addListener: (f) => { state.listeners.startup = f; } },
      onMessage: { addListener: (f) => { state.listeners.message = f; } },
      openOptionsPage: (cb) => { state.openedOptions = true; if (cb) cb(); return Promise.resolve(); },
      sendNativeMessage: (host, msg, cb) => {
        state.nativeCalls.push({ host, msg });
        const reply = state.nativeReply;
        if (cb) cb(reply);
        return Promise.resolve(reply);
      },
    },
    tabs: {
      onRemoved: { addListener: (f) => { state.listeners.tabRemoved = f; } },
      sendMessage: (tabId, msg, cb) => {
        state.tabMessages.push({ tabId, msg });
        if (cb) cb();
        return Promise.resolve();
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (f, filter, extra) => {
          state.listeners.headers = f;
          state.headersFilter = { filter, extra };
        },
      },
    },
    storage: {
      local: {
        get: (key, cb) => {
          const res = typeof key === 'string'
            ? (key in state.storage ? { [key]: state.storage[key] } : {})
            : { ...state.storage };
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(state.storage, obj);
          if (cb) cb();
          return Promise.resolve();
        },
      },
    },
    action: {
      onClicked: { addListener: (f) => { state.listeners.action = f; } },
      setBadgeText: (opts, cb) => { state.badges.push(opts.text); if (cb) cb(); return Promise.resolve(); },
      setBadgeBackgroundColor: (opts, cb) => { if (cb) cb(); return Promise.resolve(); },
    },
    contextMenus: {
      onClicked: { addListener: (f) => { state.listeners.menu = f; } },
      removeAll: (cb) => { if (cb) cb(); return Promise.resolve(); },
      create: (item) => { state.menus.push(item); },
    },
    downloads: {
      onCreated: { addListener: (f) => { state.listeners.created = f; } },
      cancel: (id, cb) => { state.canceled.push(id); if (cb) cb(); return Promise.resolve(); },
      erase: (q, cb) => { state.erased.push(q); if (cb) cb(); return Promise.resolve(); },
    },
    commands: {
      onCommand: { addListener: (f) => { state.listeners.command = f; } },
    },
    cookies: {
      getAll: (details, cb) => { const res = state.cookies; if (cb) cb(res); return Promise.resolve(res); },
    },
  };
  return { chrome, state };
}

function makeFetch(state) {
  return async (url, opts = {}) => {
    state.fetchCalls.push({ url, opts });
    if (url.endsWith('/api/health')) {
      if (!state.serverUp) throw new Error('ECONNREFUSED');
      if (state.serverPort && !url.includes(':' + state.serverPort + '/')) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.endsWith('/api/downloads')) {
      if (state.postFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 201, json: async () => ({ id: 'x' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

let clock = 1000000;
function build(overrides = {}) {
  const { chrome, state } = makeChrome();
  Object.assign(state, overrides);
  const connector = createConnector(chrome, {
    fetch: makeFetch(state),
    now: () => clock,
  });
  return { connector, state };
}

const badges = (state) => state.badges.filter(Boolean);
const posts = (state) => state.fetchCalls.filter((c) => c.url.endsWith('/api/downloads'));
const postBody = (call) => JSON.parse(call.opts.body);

/* ---------------- install defaults ---------------- */
{
  const { connector, state } = build();
  await connector.onInstalled();
  check('install: interception defaults to ON', state.storage.intercept === true);
  check('install: badge shows ON', badges(state).pop() === 'ON');
  check('install: context menus created', state.menus.length === 5, `${state.menus.length} menus`);
}
{
  const { connector, state } = build({ storage: { intercept: false } });
  await connector.onInstalled();
  check('install: explicit OFF is respected', state.storage.intercept === false);
}

/* ---------------- context menu handoff ---------------- */
{
  const { connector, state } = build({ cookies: [{ name: 'sid', value: 'abc' }] });
  await connector.onMenuClicked(
    { menuItemId: 'dlx-link', linkUrl: 'https://files.example.com/a.zip' },
    { url: 'https://files.example.com/page' }
  );
  const post = posts(state)[0];
  check('menu: link handoff posts to downloadX', !!post);
  const body = post ? postBody(post) : {};
  check('menu: url forwarded', body.url === 'https://files.example.com/a.zip');
  check('menu: filename guessed', body.filename === 'a.zip', body.filename);
  check('menu: referer forwarded', body.referer === 'https://files.example.com/page');
  check('menu: cookies attached', body.cookies === 'sid=abc', body.cookies);
  check('menu: success badge', badges(state).pop() === '✓');
}
{
  const { connector, state } = build();
  await connector.onMenuClicked(
    { menuItemId: 'dlx-selection', selectionText: 'ftp://mirror.example.com/big.iso' },
    { url: 'https://example.com/' }
  );
  check('menu: ftp selection accepted', posts(state).length === 1 && postBody(posts(state)[0]).url.startsWith('ftp://'));
}
{
  const { connector, state } = build();
  await connector.onMenuClicked({ menuItemId: 'dlx-link', linkUrl: 'javascript:alert(1)' }, {});
  check('menu: javascript URL rejected', posts(state).length === 0 && state.canceled.length === 0);
}

/* ---------------- automatic download catching (IDM-style) ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true } });
  await connector.onCreated({
    id: 7,
    url: 'https://cdn.example.com/video.mp4',
    filename: 'C:\\Users\\u\\Downloads\\video.mp4',
    referrer: 'https://example.com/watch',
  });
  check('catch: browser download cancelled after handoff', state.canceled.includes(7), state.canceled.join(','));
  check('catch: cancelled entry erased from list', state.erased.some((q) => q.id === 7));
  const body = postBody(posts(state)[0]);
  check('catch: filename is basename', body.filename === 'video.mp4', body.filename);
  check('catch: referrer forwarded', body.referer === 'https://example.com/watch');
  check('catch: success badge', badges(state).pop() === '✓');
}
{
  const { connector, state } = build({ storage: { intercept: false } });
  await connector.onCreated({ id: 8, url: 'https://cdn.example.com/x.bin' });
  check('catch: interception OFF passes through', state.canceled.length === 0 && posts(state).length === 0);
}
{
  const { connector, state } = build({ storage: { intercept: true } });
  await connector.onCreated({ id: 9, url: 'blob:https://example.com/1a2b' });
  await connector.onCreated({ id: 10, url: 'data:text/plain,hello' });
  check('catch: blob/data downloads left to the browser', state.canceled.length === 0 && posts(state).length === 0);
}
{
  const { connector, state } = build({ storage: { intercept: true } });
  await connector.onCreated({ id: 11, url: 'http://127.0.0.1:9765/api/downloads' });
  check('catch: own API downloads ignored', state.canceled.length === 0);
}
{
  const { connector, state } = build({ storage: { intercept: true } });
  const item = { id: 12, url: 'https://cdn.example.com/dup.bin' };
  await connector.onCreated(item);
  await connector.onCreated(item);
  check('catch: duplicate events deduped', state.canceled.length === 1 && posts(state).length === 1, `${state.canceled.length} cancels`);
}

/* ---------------- port discovery ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true }, serverPort: 9770 });
  await connector.onCreated({ id: 20, url: 'https://cdn.example.com/port.bin' });
  check('discovery: app found on a non-default port', state.storage.apiBase === 'http://127.0.0.1:9770', state.storage.apiBase);
  check('discovery: download handed over to the discovered port', state.canceled.includes(20));
  const posted = posts(state).pop();
  check('discovery: request went to the discovered port', !!posted && posted.url.includes(':9770/'), posted && posted.url);
}

/* ---------------- keyboard command ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true } });
  connector.init();
  check('command: listener registered', typeof state.listeners.command === 'function');
  await state.listeners.command('toggle-intercept');
  check('command: keyboard shortcut turns interception off', state.storage.intercept === false);
  await state.listeners.command('toggle-intercept');
  check('command: keyboard shortcut turns interception back on', state.storage.intercept === true);
}

/* ---------------- native host fallback + safety ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true }, serverUp: false, nativeReply: { ok: true, port: 9767 } });
  await connector.onCreated({ id: 13, url: 'https://cdn.example.com/big.iso', filename: 'big.iso' });
  check('native: add command sent when server is down', state.nativeCalls.length === 1 && state.nativeCalls[0].msg.cmd === 'add');
  check('native: host name correct', state.nativeCalls[0].host === 'com.downloadx.host');
  check('native: payload carries url', state.nativeCalls[0].msg.url === 'https://cdn.example.com/big.iso');
  check('native: download cancelled once host accepted', state.canceled.includes(13));
  check('native: discovered port remembered', state.storage.apiBase === 'http://127.0.0.1:9767', state.storage.apiBase);
}
{
  const { connector, state } = build({ storage: { intercept: true }, serverUp: false, nativeReply: { ok: false, error: 'downloadX did not start' } });
  await connector.onCreated({ id: 14, url: 'https://cdn.example.com/keep.bin' });
  check('safety: browser download survives unreachable server', state.canceled.length === 0);
  check('safety: failure badge shown', badges(state).pop() === '!');
  const calls = state.nativeCalls.length;
  clock += 1000;
  await connector.onCreated({ id: 15, url: 'https://cdn.example.com/keep2.bin' });
  check('safety: backoff skips retries while server is down', state.nativeCalls.length === calls && state.canceled.length === 0);
  clock += 60000;
  state.serverUp = true;
  await connector.onCreated({ id: 16, url: 'https://cdn.example.com/after.bin' });
  check('safety: catching resumes after backoff', state.canceled.includes(16));
}

/* ---------------- toggle + wiring ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true } });
  await connector.onActionClicked();
  check('toggle: click turns interception off', state.storage.intercept === false);
  check('toggle: badge cleared', state.badges.pop() === '');
  await connector.onActionClicked();
  check('toggle: click turns interception back on', state.storage.intercept === true);
  check('toggle: badge ON again', state.badges.pop() === 'ON');
}
{
  const { connector, state } = build();
  connector.init();
  check('wiring: listeners registered',
    typeof state.listeners.installed === 'function' &&
    typeof state.listeners.startup === 'function' &&
    typeof state.listeners.menu === 'function' &&
    typeof state.listeners.created === 'function' &&
    typeof state.listeners.action === 'function');
  check('wiring: media sniffer registered',
    typeof state.listeners.headers === 'function' &&
    state.headersFilter.extra.includes('responseHeaders'));
  check('wiring: content-script message listener registered', typeof state.listeners.message === 'function');
}

/* ---------------- settings defaults ---------------- */
{
  const { connector, state } = build();
  await connector.onInstalled();
  check('settings: media sniffing defaults ON', state.storage.mediaSniff === true);
  check('settings: floating button defaults ON', state.storage.floatingButton === true);
  check('settings: clipboard watching defaults ON', state.storage.clipboardWatch === true);
  check('settings: media size floor stored in bytes', state.storage.mediaMinSize === 1048576);
  check('settings: rule lists default empty',
    Array.isArray(state.storage.excludeSites) && state.storage.excludeSites.length === 0 &&
    Array.isArray(state.storage.skipExts) && state.storage.skipExts.length === 0);
}

/* ---------------- media classification ---------------- */
{
  const { connector } = build();
  check('classify: m3u8 URL is HLS', connector.classifyMedia('https://x.tv/a.m3u8', '', 0).kind === 'hls');
  check('classify: mpegurl MIME is HLS', connector.classifyMedia('https://x.tv/live', 'application/x-mpegURL', 0).kind === 'hls');
  check('classify: mpd is DASH', connector.classifyMedia('https://x.tv/a.mpd', '', 0).kind === 'dash');
  check('classify: mp4 MIME is video', connector.classifyMedia('https://x.tv/play', 'video/mp4', 10).kind === 'video');
  check('classify: mp3 extension is audio', connector.classifyMedia('https://x.tv/song.mp3', '', 10).kind === 'audio');
  check('classify: html is ignored', connector.classifyMedia('https://x.tv/page.html', 'text/html', 10) === null);
  check('classify: javascript scheme ignored', connector.classifyMedia('javascript:alert(1)', 'video/mp4', 0) === null);
  check('rules: wildcard site matches subdomain', connector.isExcluded('https://a.b.example.com/x', ['*.example.com']) === true);
  check('rules: wildcard site matches bare host', connector.isExcluded('https://example.com/x', ['*.example.com']) === true);
  check('rules: unrelated site allowed', connector.isExcluded('https://other.tv/x', ['*.example.com']) === false);
  check('rules: URL prefix rule', connector.isExcluded('https://bank.example/path', ['https://bank.example/']) === true);
}
{
  const { connector } = build({ storage: { intercept: true, excludeSites: ['*.bank.example'], skipExts: ['PDF', '.iso'] } });
  check('rules: normal download intercepted', (await connector.shouldIntercept({ url: 'https://cdn.tv/a.zip' })) === true);
  check('rules: excluded site skips interception', (await connector.shouldIntercept({ url: 'https://vault.bank.example/a.zip' })) === false);
  check('rules: skipped extension is case/dot insensitive', (await connector.shouldIntercept({ url: 'https://cdn.tv/a.PDF' })) === false);
  check('rules: finalUrl used for rule checks',
    (await connector.shouldIntercept({ url: 'https://redirect.tv/a.zip', finalUrl: 'https://vault.bank.example/a.zip' })) === false);
}

/* ---------------- media sniffing ---------------- */
{
  const { connector, state } = build({ storage: { mediaSniff: true } });
  await connector.onHeadersReceived({
    tabId: 5,
    url: 'https://tv.example/live/master.m3u8',
    responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
  });
  const items = connector.mediaForTab(5);
  check('sniff: HLS playlist captured', items.length === 1 && items[0].kind === 'hls', JSON.stringify(items));
  check('sniff: floating button notified', state.tabMessages.some((m) => m.tabId === 5 && m.msg.type === 'dlx:media'));
}
{
  const { connector } = build({ storage: { mediaSniff: true, mediaMinSize: 1048576 } });
  await connector.onHeadersReceived({
    tabId: 6,
    url: 'https://cdn.example/small.mp4',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }, { name: 'content-length', value: '2048' }],
  });
  check('sniff: small video under floor ignored', connector.mediaForTab(6).length === 0);
  await connector.onHeadersReceived({
    tabId: 6,
    url: 'https://cdn.example/big.mp4',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '52428800' }],
  });
  check('sniff: large video captured', connector.mediaForTab(6).length === 1);
  await connector.onHeadersReceived({
    tabId: 6,
    url: 'https://cdn.example/big.mp4',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '52428800' }],
  });
  check('sniff: duplicate URL deduped', connector.mediaForTab(6).length === 1);
  connector.onRemoved(6);
  check('sniff: tab close clears captured media', connector.mediaForTab(6).length === 0);
}
{
  const { connector } = build({ storage: { mediaSniff: false } });
  await connector.onHeadersReceived({ tabId: 7, url: 'https://tv.example/a.m3u8', responseHeaders: [] });
  check('sniff: disabled by setting', connector.mediaForTab(7).length === 0);
}
{
  const { connector } = build({ storage: { mediaSniff: true, excludeSites: ['tv.example'] } });
  await connector.onHeadersReceived({ tabId: 8, url: 'https://tv.example/a.m3u8', responseHeaders: [] });
  check('sniff: excluded site skipped', connector.mediaForTab(8).length === 0);
}

/* ---------------- content-script messaging ---------------- */
const invoke = (connector, msg, sender) => new Promise((resolve) => {
  connector.onMessage(msg, sender, resolve);
});
{
  const { connector, state } = build({ storage: { mediaSniff: true }, cookies: [{ name: 'sid', value: 'z' }] });
  await connector.onHeadersReceived({ tabId: 9, url: 'https://tv.example/a.m3u8', responseHeaders: [] });
  const resp = await invoke(connector, { type: 'dlx:getMedia' }, { tab: { id: 9, url: 'https://tv.example/page' } });
  check('message: getMedia returns tab items', resp.ok && resp.items.length === 1);
  const settings = await invoke(connector, { type: 'dlx:settings' }, {});
  check('message: settings shared with content script', settings.ok && settings.settings.mediaSniff === true);
  const sent = await invoke(connector, { type: 'dlx:download', url: 'https://tv.example/a.m3u8' }, { tab: { id: 9, url: 'https://tv.example/page' } });
  check('message: content-script download handed off', sent.ok === true && posts(state).length === 1);
  const body = postBody(posts(state).pop());
  check('message: referer taken from sender tab', body.referer === 'https://tv.example/page');
  check('message: cookies attached', body.cookies === 'sid=z');
  const bad = await invoke(connector, { type: 'dlx:download', url: 'javascript:alert(1)' }, {});
  check('message: invalid URL rejected', bad.ok === false);
  await invoke(connector, { type: 'dlx:openOptions' }, {});
  check('message: options page requested', state.openedOptions === true);
}

/* ---------------- smart rules during capture ---------------- */
{
  const { connector, state } = build({ storage: { intercept: true, excludeSites: ['*.example.com'], skipExts: ['iso'] } });
  await connector.onCreated({ id: 20, url: 'https://cdn.example.com/a.zip' });
  check('rules: excluded site left to browser', state.canceled.length === 0 && posts(state).length === 0);
  await connector.onCreated({ id: 21, url: 'https://other.tv/a.iso' });
  check('rules: skipped extension left to browser', state.canceled.length === 0 && posts(state).length === 0);
  await connector.onCreated({ id: 22, url: 'https://other.tv/a.zip' });
  check('rules: allowed download still captured', state.canceled.includes(22));
}

/* ---------------- packaged files + Firefox manifest ---------------- */
{
  const extDir = path.join(ROOT, 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  check('package: content script shipped', fs.existsSync(path.join(extDir, 'content.js')) && manifest.content_scripts[0].js.includes('content.js'));
  check('package: options page shipped', fs.existsSync(path.join(extDir, 'options.html')) && fs.existsSync(path.join(extDir, 'options.js')) && manifest.options_ui.page === 'options.html');
  check('package: webRequest permission declared', manifest.permissions.includes('webRequest'));
  const fm = firefoxManifest(manifest, '9.9.9', 'x@y');
  check('firefox: content scripts preserved', Array.isArray(fm.content_scripts) && fm.content_scripts.length === 1);
  check('firefox: options page preserved', fm.options_ui && fm.options_ui.page === 'options.html');
  check('firefox: webRequest permission preserved', fm.permissions.includes('webRequest'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
