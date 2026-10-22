// A tiny DOM shim, good enough to run the web UI modules and the extension
// content script outside a browser. Shared by test/ui.test.mjs and
// test/extension-ui.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

const CTX = {
  clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {},
  createLinearGradient() { return { addColorStop() {} }; },
};

function parseAttributes(raw) {
  const attrs = {};
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function parseHtml(html) {
  const root = new FakeElement('div');
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)((?:\s[^>]*?)?)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const attrText = m[2] || '';
    const text = m[3];
    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed) stack[stack.length - 1]._text += trimmed;
      continue;
    }
    if (m[0].startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new FakeElement(tag);
    const attrs = parseAttributes(attrText);
    if (attrs.class) {
      node.className = attrs.class;
      for (const cls of attrs.class.split(/\s+/).filter(Boolean)) node.classList.add(cls);
    }
    if (attrs.id) node.attributes.id = attrs.id;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
    }
    if (attrs.style) {
      for (const decl of attrs.style.split(';')) {
        const [k, v] = decl.split(':');
        if (k && v) node.style[k.trim()] = v.trim();
      }
    }
    stack[stack.length - 1].appendChild(node);
    if (!VOID_TAGS.has(tag.toLowerCase()) && !m[0].endsWith('/>')) stack.push(node);
  }
  return root;
}

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this._className = '';
    this.classList = new ClassList();
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this._html = '';
    this.title = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.placeholder = '';
    this.href = '';
    this.shadowRoot = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  /* Setting className updates classList, like a real DOM does. */
  get className() { return this._className; }
  set className(v) {
    this._className = v == null ? '' : String(v);
    this.classList = new ClassList();
    for (const c of this._className.split(/\s+/).filter(Boolean)) this.classList.add(c);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    this._text = '';
    const parsed = parseHtml(this._html);
    for (const child of parsed.children) { child.parentNode = this; this.children.push(child); }
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  appendChild(n) {
    if (n.parentNode && n.parentNode !== this) n.parentNode.removeChild(n);
    n.parentNode = this;
    if (!this.children.includes(n)) this.children.push(n);
    return n;
  }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  /* The id property mirrors the attribute, like a real DOM does. */
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, sel, this)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  closest() { return null; }
  focus() {}
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; if (typeof this.onclose === 'function') this.onclose(); }
  getContext() { return CTX; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  attachShadow() {
    this.shadowRoot = new FakeElement('shadow');
    this.shadowRoot.appendChild = (n) => { this.shadowRoot.children.push(n); return n; };
    return this.shadowRoot;
  }
  getSelection() { return ''; }
}

function matchesSimple(node, sel) {
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.attributes.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const m = /^\[([a-zA-Z0-9-]+)\]$/.exec(sel);
    return !!m && (m[1] in node.attributes || m[1] in node.dataset);
  }
  return node.tagName === sel.toUpperCase();
}

/** Supports "tag", ".class", "#id", "[attr]" and simple descendant chains. */
function matchesSelector(node, sel, root) {
  const parts = sel.trim().split(/\s+/);
  if (parts.length === 1) return matchesSimple(node, parts[0]);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  const head = parts.slice(0, -1).reverse();
  for (const part of head) {
    let found = false;
    while (ancestor) {
      if (matchesSimple(ancestor, part)) { found = true; ancestor = ancestor.parentNode; break; }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Build a document from a piece of markup.
 * @param {string} [html] the markup, defaults to the real index.html
 * @returns {{ doc: object, byId: Map<string, FakeElement> }}
 */
export function buildDocument(html) {
  const source = html === undefined
    ? fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
    : html;
  const tree = parseHtml(source);
  const byId = new Map();
  const index = (node) => {
    for (const child of node.children) {
      if (child.attributes.id) byId.set(child.attributes.id, child);
      index(child);
    }
  };
  index(tree);

  const doc = {
    documentElement: tree.querySelector('html') || tree,
    body: tree.querySelector('body') || tree,
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector(sel) { return tree.querySelector(sel); },
    querySelectorAll(sel) { return tree.querySelectorAll(sel); },
    getElementById(id) { return tree.querySelector('#' + id); },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) {
      const ev = { type, preventDefault() {}, ...event };
      for (const fn of doc.listeners[type] || []) fn(ev);
    },
  };
  return { doc, byId };
}

/**
 * Install the shim as the globals the UI and the extension expect.
 * @param {object} [options]
 * @returns {{ doc: object, byId: Map<string, FakeElement>, restore: () => void }}
 */
export function installDom(options = {}) {
  const { doc, byId } = buildDocument(options.html);
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: globalThis.localStorage,
  };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => '',
    AudioContext: undefined,
    location: { href: options.url || 'https://example.com/page' },
    document: doc,
  };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.window.document = doc;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: () => Promise.resolve() } },
  });
  globalThis.localStorage = {
    _v: {},
    getItem(k) { return k in this._v ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
  };
  return {
    doc,
    byId,
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
      globalThis.localStorage = saved.localStorage;
    },
  };
}
