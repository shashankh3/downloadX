'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const crx = require('./crx');

const GENERATED = new Set(['chrome', 'firefox', 'downloadx.crx', 'updates.xml', 'build-info.json']);

function copySource(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (GENERATED.has(entry.name) || /\.(pem|crx|xpi)$/i.test(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copySource(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function chromeManifest(src, version, key) {
  const m = { ...src, version };
  if (key) m.key = key;
  return m;
}

function firefoxManifest(src, version, firefoxId) {
  const out = {
    manifest_version: 3,
    name: src.name,
    version,
    description: src.description,
    browser_specific_settings: {
      gecko: { id: firefoxId, strict_min_version: '115.0' },
    },
    permissions: src.permissions || ['contextMenus', 'downloads', 'storage', 'activeTab', 'nativeMessaging', 'webRequest'],
    host_permissions: src.host_permissions || ['http://127.0.0.1/*', 'http://localhost/*'],
    background: { scripts: ['background.js'] },
    action: src.action,
  };
  if (src.content_scripts) out.content_scripts = src.content_scripts;
  if (src.options_ui) out.options_ui = src.options_ui;
  if (src.icons) out.icons = src.icons;
  if (src.web_accessible_resources) out.web_accessible_resources = src.web_accessible_resources;
  return out;
}

function prepareExtension(opts) {
  const {
    src,
    out,
    keyFile,
    version,
    firefoxId = 'downloadx@local',
    codebase,
    when = new Date(),
  } = opts;
  const srcManifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const ver = version || srcManifest.version || '1.0.0';
  const key = keyFile ? crx.loadOrCreateKey(keyFile) : null;
  const publicDer = key ? crx.publicKeyDer(key) : null;
  const keyB64 = publicDer ? publicDer.toString('base64') : '';
  const id = key ? crx.extensionId(publicDer) : '';

  const chromeDir = path.join(out, 'chrome');
  const firefoxDir = path.join(out, 'firefox');
  fs.rmSync(chromeDir, { recursive: true, force: true });
  fs.rmSync(firefoxDir, { recursive: true, force: true });
  copySource(src, chromeDir);
  copySource(src, firefoxDir);
  writeJson(path.join(chromeDir, 'manifest.json'), chromeManifest(srcManifest, ver, keyB64));
  writeJson(path.join(firefoxDir, 'manifest.json'), firefoxManifest(srcManifest, ver, firefoxId));

  let crxFile = null;
  let updatesFile = null;
  if (key) {
    crxFile = path.join(out, 'downloadx.crx');
    fs.writeFileSync(crxFile, crx.buildFromDir(chromeDir, key, when));
    const base = codebase || pathToFileURL(crxFile).href;
    updatesFile = path.join(out, 'updates.xml');
    fs.writeFileSync(updatesFile, crx.updateManifest(id, ver, base));
  }

  const info = {
    id,
    version: ver,
    firefoxId,
    publicKey: keyB64,
    chromeDir,
    firefoxDir,
    crxFile,
    updatesFile,
    codebase: updatesFile ? (codebase || pathToFileURL(crxFile).href) : null,
  };
  writeJson(path.join(out, 'build-info.json'), info);
  return info;
}

module.exports = { prepareExtension, chromeManifest, firefoxManifest };
