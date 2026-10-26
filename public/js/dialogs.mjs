'use strict';
/*
 * The "New download" and "Settings" dialogs.
 */
import { $, el, toast } from './dom.mjs';
import { api } from './api.mjs';
import { state } from './store.mjs';
import { fmtBytes } from './format.mjs';
import { languages, language, setLanguage, t } from './i18n.mjs';

/* ---------------- add dialog ---------------- */

export function openAdd(prefill) {
  const dlg = $('#dlg-add');
  $('#add-urls').value = prefill || '';
  $('#add-filename').value = '';
  $('#add-preview').textContent = '';
  $('#add-grab-hint').textContent = '';
  $('#add-category').value = 'auto';
  const segs = (state && state.settings && state.settings.defaultSegments) || 16;
  $('#add-segments').value = segs;
  $('#add-segv').textContent = segs;
  $('#add-limit').value = '0';
  $('#add-mirrors').value = '';
  $('#add-referer').value = '';
  $('#add-cookies').value = '';
  $('#add-username').value = '';
  $('#add-password').value = '';
  $('#add-proxy').value = '';
  $('#add-headers').value = '';
  $('#add-checksum').value = '';
  $('#add-dir').value = '';
  $('#add-paused').checked = false;
  $('#add-priority').value = '0';
  $('#add-sched-start').value = '';
  $('#add-sched-end').value = '';
  $('#add-sched-days').value = '';
  fillDependencySelect();
  const adv = dlg.querySelector('details.advanced');
  if (adv) adv.open = false;
  dlg.showModal();
  $('#add-urls').focus();
}

/** Fill the "wait for" picker with the downloads that are still in flight. */
function fillDependencySelect() {
  const sel = $('#add-depends');
  if (!sel) return;
  const current = sel.value;
  sel.textContent = '';
  const none = el('option', null, 'None');
  none.value = '';
  sel.appendChild(none);
  for (const item of state.items || []) {
    if (item.status === 'completed' || item.status === 'canceled') continue;
    const o = el('option', null, item.filename);
    o.value = item.id;
    sel.appendChild(o);
  }
  if ([...sel.children].some((o) => o.value === current)) sel.value = current;
}

function parseDays(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/)
    .map((d) => parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
}

let expandTimer = null;

function parseHeaderBlock(text) {
  const out = {};
  for (const line of String(text || '').split(/[\r\n]+/)) {
    const m = /^([^:]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function initAddDialog() {
  $('#add-urls').addEventListener('input', () => {
    clearTimeout(expandTimer);
    expandTimer = setTimeout(async () => {
      const text = $('#add-urls').value.trim();
      if (!text) { $('#add-preview').textContent = ''; return; }
      try {
        const r = await api('/api/expand', { method: 'POST', body: { text } });
        const hint = $('#add-preview');
        if (r.errors && r.errors.length && !r.urls.length) {
          hint.textContent = r.errors[0].error;
          hint.classList.add('bad');
          return;
        }
        hint.classList.remove('bad');
        hint.textContent = r.urls.length > 1 ? `Will add ${r.urls.length} downloads` : '';
      } catch { /* ignore */ }
    }, 350);
  });

  $('#add-segments').addEventListener('input', (e) => { $('#add-segv').textContent = e.target.value; });

  /* Open the site grabber with the first URL as the starting page. */
  $('#add-grab').addEventListener('click', () => {
    const pageUrl = $('#add-urls').value.trim().split(/\r?\n/)[0] || '';
    openGrab(pageUrl);
  });

  $('#add-ok').addEventListener('click', async () => {
    const text = $('#add-urls').value.trim();
    if (!text) return toast('Enter at least one URL', 'err');
    const body = {
      text,
      filename: $('#add-filename').value.trim() || undefined,
      category: $('#add-category').value,
      segments: parseInt($('#add-segments').value, 10) || 16,
      speedLimitKBs: parseInt($('#add-limit').value, 10) || 0,
      mirrors: $('#add-mirrors').value.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean),
      referer: $('#add-referer').value.trim() || undefined,
      cookies: $('#add-cookies').value.trim() || undefined,
      username: $('#add-username').value.trim() || undefined,
      password: $('#add-password').value || undefined,
      proxy: $('#add-proxy').value.trim() || undefined,
      headers: parseHeaderBlock($('#add-headers').value),
      expectedChecksum: $('#add-checksum').value.trim() || undefined,
      dir: $('#add-dir').value.trim() || undefined,
      startedPaused: $('#add-paused').checked,
      priority: parseInt($('#add-priority').value, 10) || 0,
      dependsOn: $('#add-depends').value || undefined,
    };
    const schedStart = $('#add-sched-start').value;
    const schedEnd = $('#add-sched-end').value;
    const schedDays = parseDays($('#add-sched-days').value);
    if (schedStart || schedEnd || schedDays.length) {
      body.schedule = { windowStart: schedStart, windowEnd: schedEnd, days: schedDays, speedLimit: 0 };
    }
    const btn = $('#add-ok');
    btn.disabled = true;
    try {
      const r = await api('/api/downloads', { method: 'POST', body });
      $('#dlg-add').close();
      toast(r.batch ? `Added ${r.batch.length} downloads` : `Added: ${r.filename || 'download started'}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  });

  $('#add-cancel').addEventListener('click', () => $('#dlg-add').close());
}

/* ---------------- site grabber ---------------- */

export function openGrab(pageUrl = '') {
  $('#grab-url').value = pageUrl;
  $('#grab-depth').value = '0';
  $('#grab-types').value = '';
  $('#grab-same').checked = true;
  $('#grab-media').checked = false;
  $('#grab-result').textContent = '';
  $('#grab-result').classList.remove('bad');
  $('#grab-use').hidden = true;
  $('#dlg-grab').showModal();
  if (!pageUrl) $('#grab-url').focus();
}

export function initGrabDialog() {
  $('#grab-cancel').addEventListener('click', () => $('#dlg-grab').close());
  $('#grab-run').addEventListener('click', async () => {
    const url = $('#grab-url').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      $('#grab-result').textContent = 'A page URL is required';
      $('#grab-result').classList.add('bad');
      return;
    }
    const btn = $('#grab-run');
    btn.disabled = true;
    $('#grab-result').classList.remove('bad');
    $('#grab-result').textContent = 'Looking…';
    $('#grab-use').hidden = true;
    try {
      const r = await api('/api/scrape', {
        method: 'POST',
        body: {
          url,
          depth: parseInt($('#grab-depth').value, 10) || 0,
          sameOrigin: $('#grab-same').checked,
          includeMedia: $('#grab-media').checked,
          extensions: $('#grab-types').value,
        },
      });
      const urls = (r.links || []).map((l) => l.url);
      if (!urls.length) {
        $('#grab-result').textContent = 'No links found';
        return;
      }
      $('#grab-result').textContent = `${urls.length} link${urls.length === 1 ? '' : 's'} · ${r.pages || 1} page${(r.pages || 1) === 1 ? '' : 's'}`;
      $('#grab-use').hidden = false;
      $('#grab-use').onclick = () => {
        $('#add-urls').value = urls.join('\n');
        $('#add-preview').textContent = `Will add ${urls.length} downloads`;
        $('#add-grab-hint').textContent = `${urls.length} grabbed`;
        $('#dlg-grab').close();
      };
    } catch (e) {
      $('#grab-result').textContent = e.message;
      $('#grab-result').classList.add('bad');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- settings dialog ---------------- */

export function openSettings() {
  const s = state.settings || {};
  const langSelect = $('#set-language');
  if (langSelect) {
    langSelect.textContent = '';
    for (const l of languages()) {
      const o = el('option', null, l.name);
      o.value = l.code;
      langSelect.appendChild(o);
    }
    langSelect.value = language();
    langSelect.onchange = () => {
      setLanguage(langSelect.value);
      openSettings();
    };
  }
  $('#set-root').value = s.rootDir || '';
  $('#set-concurrent').value = s.maxConcurrent ?? 3;
  $('#set-maxconnections').value = s.maxConnections ?? 64;
  $('#set-segments').value = s.defaultSegments ?? 16;
  $('#set-globallimit').value = s.globalSpeedLimit ? Math.round(s.globalSpeedLimit / 1024) : 0;
  $('#set-quota').value = s.hourlyQuota ? Math.round(s.hourlyQuota / (1024 * 1024)) : 0;
  $('#set-proxy').value = s.proxy || '';
  $('#set-organize').checked = !!s.organizeByCategory;
  $('#set-invalid-tls').checked = !!s.allowInvalidTls;
  $('#set-update-url').value = s.updateUrl || '';
  $('#set-webhook').value = s.webhookUrl || '';
  $('#set-sched-enabled').checked = !!s.scheduleEnabled;
  $('#set-sched-from').value = s.scheduleFrom || '23:00';
  $('#set-sched-to').value = s.scheduleTo || '07:00';
  $('#set-shutdown').checked = !!s.shutdownWhenDone;
  $('#set-notify').checked = s.notifications !== false;
  $('#set-notify-sound').checked = s.notificationSound !== false;
  $('#set-maxretries').value = s.maxRetries ?? 12;
  $('#set-avscan').checked = !!s.avScanEnabled;
  $('#set-mow').checked = s.writeMarkOfTheWeb !== false;
  $('#dlg-settings').showModal();
  refreshFreeSpace();
}

/** Ask the server how much room is left on the download volume. */
export async function refreshFreeSpace() {
  const box = $('#set-freespace');
  if (!box) return;
  try {
    const r = await api('/api/free-space');
    box.textContent = r.free == null
      ? t('Free space on the download volume: unknown')
      : t('Free space on the download volume: {size}', { size: fmtBytes(r.free) });
  } catch {
    box.textContent = t('Free space on the download volume: unknown');
  }
}

export function initSettingsDialog() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#set-ok').addEventListener('click', async () => {
    const body = {
      rootDir: $('#set-root').value.trim(),
      maxConcurrent: parseInt($('#set-concurrent').value, 10) || 3,
      maxConnections: Math.max(0, parseInt($('#set-maxconnections').value, 10) || 0),
      defaultSegments: parseInt($('#set-segments').value, 10) || 16,
      globalSpeedLimit: (parseInt($('#set-globallimit').value, 10) || 0) * 1024,
      hourlyQuota: (parseInt($('#set-quota').value, 10) || 0) * 1024 * 1024,
      proxy: $('#set-proxy').value.trim(),
      organizeByCategory: $('#set-organize').checked,
      allowInvalidTls: $('#set-invalid-tls').checked,
      updateUrl: $('#set-update-url').value.trim(),
      webhookUrl: $('#set-webhook').value.trim(),
      scheduleEnabled: $('#set-sched-enabled').checked,
      scheduleFrom: $('#set-sched-from').value,
      scheduleTo: $('#set-sched-to').value,
      shutdownWhenDone: $('#set-shutdown').checked,
      notifications: $('#set-notify').checked,
      notificationSound: $('#set-notify-sound').checked,
      maxRetries: parseInt($('#set-maxretries').value, 10) || 12,
      avScanEnabled: $('#set-avscan').checked,
      writeMarkOfTheWeb: $('#set-mow').checked,
    };
    try {
      if (body.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      await api('/api/settings', { method: 'PUT', body });
      $('#dlg-settings').close();
      toast('Settings saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#set-cancel').addEventListener('click', () => $('#dlg-settings').close());
  $('#set-extension').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage({ type: 'browser-setup' });
        toast('Opening browser setup…', 'ok');
        return;
      }
      const r = await api('/api/extension/install', { method: 'POST' });
      toast(r.mode === 'store' ? 'Opening the browser add-on store…' : 'Opening the extension folder…', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#set-refresh-space').addEventListener('click', () => refreshFreeSpace());

  $('#set-export').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/downloads/export');
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'downloadx-tasks.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Download list exported', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#set-import').addEventListener('click', () => $('#set-import-file').click());
  $('#set-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/api/downloads/import', { method: 'POST', body: data });
      const failed = (r.errors || []).length;
      toast(`Imported ${r.added}${failed ? ` · ${failed} skipped` : ''}`, failed ? 'err' : 'ok');
      e.target.value = '';
    } catch (err) {
      toast(err.message, 'err');
      e.target.value = '';
    }
  });
}
