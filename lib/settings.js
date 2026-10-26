'use strict';
/*
 * Application settings: defaults, validation and normalization.
 * Every value that reaches the engine passes through normalizeSettings(), so the
 * rest of the code can trust the shape of `engine.settings`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseProxy } = require('./httpget');
const { clampInt, cleanPathStr } = require('./util');

const DEFAULT_SETTINGS = {
  rootDir: '',
  maxConcurrent: 3,
  maxConnections: 64,
  defaultSegments: 16,
  globalSpeedLimit: 0,
  organizeByCategory: true,
  scheduleEnabled: false,
  scheduleFrom: '23:00',
  scheduleTo: '07:00',
  shutdownWhenDone: false,
  proxy: '',
  allowInvalidTls: false,
  notifications: true,
  notificationSound: true,
  updateUrl: '',
  maxRetries: 12,
  webhookUrl: '',
  allowPrivateNetworks: false,
  hourlyQuota: 0,
  avScanEnabled: false,
  avTimeoutMs: 120000,
  writeMarkOfTheWeb: true,
};

/** Where downloads go when the user has not picked a folder. */
function defaultRoot() {
  const home = os.homedir();
  const dl = path.join(home, 'Downloads');
  try { if (fs.existsSync(dl)) return dl; } catch { /* fall through */ }
  return dl;
}

/**
 * Validate a "HH:MM" clock value; returns `fallback` when malformed.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function validHHMM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return fallback;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/**
 * Merge a partial settings patch onto the current settings and clamp every value.
 * Unknown keys are dropped so a hostile client cannot inject arbitrary state.
 * @param {Record<string, unknown>} [input]
 * @param {Record<string, unknown>} [base]
 * @returns {Record<string, unknown>} the normalised settings
 */
function normalizeSettings(input, base) {
  const defaults = Object.assign({}, DEFAULT_SETTINGS, base || {}, { rootDir: (base && base.rootDir) || defaultRoot() });
  const src = Object.assign({}, defaults, input || {});
  const s = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) s[key] = src[key];
  s.rootDir = cleanPathStr(s.rootDir) ? path.resolve(cleanPathStr(s.rootDir)) : defaults.rootDir;
  s.maxConcurrent = clampInt(s.maxConcurrent, 1, 20, defaults.maxConcurrent);
  s.maxConnections = clampInt(s.maxConnections, 0, 512, defaults.maxConnections);
  s.defaultSegments = clampInt(s.defaultSegments, 1, 64, defaults.defaultSegments);
  s.globalSpeedLimit = clampInt(s.globalSpeedLimit, 0, 1024 * 1024 * 1024, defaults.globalSpeedLimit);
  s.organizeByCategory = s.organizeByCategory !== false;
  s.scheduleEnabled = !!s.scheduleEnabled;
  s.scheduleFrom = validHHMM(s.scheduleFrom, defaults.scheduleFrom);
  s.scheduleTo = validHHMM(s.scheduleTo, defaults.scheduleTo);
  s.shutdownWhenDone = !!s.shutdownWhenDone;
  const proxy = String(s.proxy == null ? '' : s.proxy).trim();
  s.proxy = proxy && parseProxy(proxy) ? proxy : '';
  s.allowInvalidTls = !!s.allowInvalidTls;
  s.notifications = s.notifications !== false;
  s.notificationSound = s.notificationSound !== false;
  s.updateUrl = /^https?:\/\//i.test(String(s.updateUrl || '').trim()) ? String(s.updateUrl).trim() : '';
  s.maxRetries = clampInt(s.maxRetries, 1, 100, defaults.maxRetries);
  s.webhookUrl = /^https?:\/\//i.test(String(s.webhookUrl || '').trim()) ? String(s.webhookUrl).trim() : '';
  s.allowPrivateNetworks = s.allowPrivateNetworks === true;
  // 0 = no hourly traffic quota. Stored in bytes, like the speed limits.
  s.hourlyQuota = clampInt(s.hourlyQuota, 0, 1024 * 1024 * 1024 * 1024, defaults.hourlyQuota);
  s.avScanEnabled = !!s.avScanEnabled;
  s.avTimeoutMs = clampInt(s.avTimeoutMs, 1000, 30 * 60 * 1000, defaults.avTimeoutMs);
  s.writeMarkOfTheWeb = s.writeMarkOfTheWeb !== false;
  return s;
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, validHHMM, defaultRoot };
