'use strict';
/*
 * Tiny DOM helpers: query shortcuts, element creation, toasts and the
 * confirmation dialog. Everything else in the UI builds on these.
 */
import { I } from './icons.mjs';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element with an optional class and text content. */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Show a transient toast message. */
export function toast(msg, type = '') {
  const iconName = type === 'ok' ? 'check' : type === 'err' ? 'xcirc' : 'bolt';
  const t = el('div', 'toast ' + type);
  const icon = el('span', 't-ico');
  icon.innerHTML = I[iconName] || '';
  const text = el('span');
  text.textContent = msg;
  t.append(icon, text);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}

/** Promise based confirm dialog. Resolves true when the user confirms. */
export function confirmDlg(title, text, yesLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yesLabel;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(v);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
}

/** Mark one item of a navigation group as active. */
export function setNav(container, attr, value) {
  $$(container + ' .nav-item').forEach((b) => {
    const on = b.dataset[attr] === value;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/** Inject the static SVG icons into the placeholder spans of the markup. */
export function injectIcons(root = document) {
  $$('[data-ico]', root).forEach((n) => { n.innerHTML = I[n.dataset.ico] || ''; });
}
