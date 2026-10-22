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
  const adv = dlg.querySelector('details.advanced');
  if (adv) adv.open = false;
  dlg.showModal();
  $('#add-urls').focus();
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

  /* Grab the download links of a page and put them into the list. */
  $('#add-grab').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const hint = $('#add-grab-hint');
    const pageUrl = $('#add-urls').value.trim().split(/\r?\n/)[0] || '';
    if (!/^https?:\/\//i.test(pageUrl)) {
      hint.textContent = 'Put the page address in the box above first';
      return;
    }
    btn.disabled = true;
    hint.textContent = 'Looking for links…';
    try {
      const r = await api('/api/scrape', { method: 'POST', body: { url: pageUrl } });
      const urls = (r.links || []).map((l) => l.url);
      if (!urls.length) {
        hint.textContent = 'No download links found on that page';
        return;
      }
      $('#add-urls').value = urls.join('\n');
      hint.textContent = `Found ${urls.length} link${urls.length === 1 ? '' : 's'}`;
      $('#add-preview').textContent = `Will add ${urls.length} downloads`;
    } catch (err) {
      hint.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
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
    };
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
      const r = await api('/api/extension/install', { method: 'POST' });
      toast(r.mode === 'store' ? 'Opening the browser add-on store…' : 'Opening the extension folder…', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#set-refresh-space').addEventListener('click', () => refreshFreeSpace());
}
