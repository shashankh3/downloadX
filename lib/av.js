'use strict';
/*
 * Windows antivirus and provenance helpers.
 *
 * The scan uses the Microsoft Malware Protection Command Line Utility that
 * ships with Windows (MpCmdRun.exe), so no third party library is needed.
 * The provenance is written as the Mark-of-the-Web alternate data stream, so
 * Windows and SmartScreen know that a file came from the internet.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFENDER_PLATFORM = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform';
const DEFENDER_FALLBACK = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Find the scanner of Microsoft Defender.
 * The platform folder holds a versioned copy of the tool; the newest one wins.
 * @returns {string} the path of the scanner or an empty string
 */
function findMpCmdRun() {
  if (process.platform !== 'win32') return '';
  try {
    const dirs = fs.readdirSync(DEFENDER_PLATFORM, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dir of dirs) {
      const candidate = path.join(DEFENDER_PLATFORM, dir, 'MpCmdRun.exe');
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
    }
  } catch { /* Defender is not installed */ }
  try { if (fs.existsSync(DEFENDER_FALLBACK)) return DEFENDER_FALLBACK; } catch { /* ignore */ }
  return '';
}

/**
 * Scan a file with the antivirus.
 * @param {string} filePath
 * @param {{ timeoutMs?: number, tool?: string }} [options]
 * @returns {Promise<{ available: boolean, clean: boolean, threat: boolean, code: number, error: string }>}
 */
function scanFile(filePath, options = {}) {
  const tool = options.tool || findMpCmdRun();
  if (!tool) {
    return Promise.resolve({ available: false, clean: false, threat: false, code: -1, error: 'No antivirus scanner available' });
  }
  return new Promise((resolve) => {
    execFile(tool, ['-Scan', '-ScanType', '3', '-File', filePath, '-DisableRemediation'], {
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const output = String(stdout || '') + '\n' + String(stderr || '');
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      // 0 means clean, 2 means a threat was found (or the scan itself failed).
      const threat = code === 2 && /malware|threat|virus|trojan|ransomware|detected|blocked/i.test(output);
      const last = output.trim().split('\n').filter(Boolean).pop() || '';
      resolve({
        available: true,
        clean: code === 0,
        threat,
        code,
        error: code === 0 ? '' : (threat ? 'Threat detected' : (last || 'Antivirus scan failed')),
      });
    });
  });
}

/** Keep a value inside one line of the alternate data stream. */
function sanitizeAdsValue(value) {
  return String(value || '').replace(/[\r\n"]/g, '').slice(0, 500);
}

/**
 * Mark a file as coming from the internet (Mark-of-the-Web).
 * @param {string} filePath
 * @param {{ hostUrl?: string, referrerUrl?: string }} [info]
 * @returns {boolean} true when the stream was written
 */
function writeMarkOfTheWeb(filePath, info = {}) {
  if (process.platform !== 'win32') return false;
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (info.hostUrl) lines.push('HostUrl=' + sanitizeAdsValue(info.hostUrl));
  if (info.referrerUrl) lines.push('ReferrerUrl=' + sanitizeAdsValue(info.referrerUrl));
  try {
    fs.writeFileSync(filePath + ':Zone.Identifier', lines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the Mark-of-the-Web of a file (empty when it has none).
 * @param {string} filePath
 * @returns {string}
 */
function readMarkOfTheWeb(filePath) {
  if (process.platform !== 'win32') return '';
  try {
    return fs.readFileSync(filePath + ':Zone.Identifier', 'utf8');
  } catch {
    return '';
  }
}

module.exports = {
  findMpCmdRun,
  scanFile,
  writeMarkOfTheWeb,
  readMarkOfTheWeb,
  DEFAULT_TIMEOUT_MS,
};
