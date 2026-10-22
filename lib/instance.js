'use strict';
/*
 * Single-instance + port-file helpers.
 * A downloadX data directory may only be owned by one server process at a time.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const LOCK_NAME = '.server.lock';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readPortFile(dataDir) {
  try {
    const port = parseInt(fs.readFileSync(path.join(dataDir, 'port'), 'utf8').trim(), 10);
    return port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

function writePortFile(dataDir, port) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'port');
  const temp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, String(port));
    try {
      fs.renameSync(temp, target);
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try { fs.unlinkSync(target); } catch { /* gone */ }
      fs.renameSync(temp, target);
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function removePortFile(dataDir, port) {
  try {
    const file = path.join(dataDir, 'port');
    if (fs.readFileSync(file, 'utf8').trim() === String(port)) fs.unlinkSync(file);
  } catch { /* best effort */ }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function probeHost(host) {
  const h = String(host || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0' || h === 'localhost') return '127.0.0.1';
  if (h === '::') return '::1';
  return h;
}

function probeHealth(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      req = http.get({
        host: probeHost(host),
        port,
        path: '/api/health',
        timeout,
        headers: { Accept: 'application/json' },
      }, (res) => {
        let body = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            req.destroy();
            done(null);
            return;
          }
          body += chunk;
        });
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            done(info && info.ok === true ? info : null);
          } catch {
            done(null);
          }
        });
      });
    } catch {
      return done(null);
    }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class InstanceLock {
  constructor({ dataDir, host = '127.0.0.1', port = 0, timeoutMs = 12000, instance = null }) {
    this.dataDir = dataDir;
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.lockFile = path.join(dataDir, LOCK_NAME);
    this.instance = instance || crypto.randomUUID();
    this.acquired = false;
  }

  record(port) {
    return {
      pid: process.pid,
      instance: this.instance,
      host: this.host,
      port: Number(port) || 0,
      startedAt: this.startedAt || Date.now(),
    };
  }

  write(port) {
    fs.writeFileSync(this.lockFile, JSON.stringify(this.record(port)));
  }

  async acquire() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.startedAt = Date.now();

    const legacy = await this._fromPortFile();
    if (legacy) {
      return {
        acquired: false,
        port: legacy.port,
        pid: Number(legacy.pid) || 0,
        instance: legacy.instance || '',
      };
    }

    let deadline = Date.now() + this.timeoutMs;
    for (;;) {
      let fd = null;
      try {
        fd = fs.openSync(this.lockFile, 'wx');
        fs.writeFileSync(fd, JSON.stringify(this.record(0)));
        fs.closeSync(fd);
        this.acquired = true;
        return { acquired: true, instance: this.instance };
      } catch (e) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* closed */ }
        }
        if (e.code !== 'EEXIST') throw e;
      }

      const info = readJson(this.lockFile);
      const state = await this._inspect(info);
      if (state.status === 'running') {
        return {
          acquired: false,
          port: state.port,
          pid: state.pid,
          instance: state.instance,
        };
      }
      if (state.status === 'starting') {
        if (Date.now() >= deadline) {
          let age = 0;
          try { age = Date.now() - fs.statSync(this.lockFile).mtimeMs; } catch { /* gone */ }
          if (age > 15000) {
            console.error('[downloadX] Removing stale instance lock left by a stopped process.');
            try { fs.unlinkSync(this.lockFile); } catch { /* already gone */ }
            deadline = Date.now() + this.timeoutMs;
            continue;
          }
          // The owner is still coming up. Report that instead of failing, so a
          // second launch can say "already starting" rather than an error.
          const owner = readJson(this.lockFile) || {};
          return {
            acquired: false,
            starting: true,
            port: Number(owner.port) || 0,
            pid: Number(owner.pid) || 0,
            instance: owner.instance || '',
          };
        }
        await sleep(150);
        continue;
      }

      try { fs.unlinkSync(this.lockFile); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (Date.now() >= deadline) {
        throw new Error('Could not acquire the downloadX instance lock. Close any running instance and try again.');
      }
    }
  }

  async _fromPortFile() {
    const port = readPortFile(this.dataDir);
    if (!port) return null;
    const health = await probeHealth(port, this.host);
    if (!health) return null;
    return { port, pid: health.pid, instance: health.instance, legacy: true };
  }

  async _inspect(info) {
    if (!info || typeof info !== 'object' || !Number.isInteger(info.pid)) {
      let age = 0;
      try { age = Date.now() - fs.statSync(this.lockFile).mtimeMs; } catch { /* gone */ }
      if (age < 5000) return { status: 'starting' };
      const legacy = await this._fromPortFile();
      return legacy ? { status: 'running', ...legacy } : { status: 'stale' };
    }

    if (!pidAlive(info.pid)) return { status: 'stale' };

    if (Number.isInteger(info.port) && info.port > 0) {
      const health = await probeHealth(info.port, info.host || this.host);
      if (health && (!info.instance || !health.instance || health.instance === info.instance)) {
        return {
          status: 'running',
          port: info.port,
          pid: info.pid,
          instance: health.instance || info.instance || '',
        };
      }
      return { status: 'starting' };
    }

    const legacy = await this._fromPortFile();
    if (legacy) return { status: 'running', ...legacy };
    return { status: 'starting' };
  }

  update(port) {
    if (!this.acquired) return;
    try {
      this.write(port);
    } catch (e) {
      console.error('[downloadX] could not update instance lock:', e.message);
    }
  }

  release() {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      const info = readJson(this.lockFile);
      if (!info || info.instance === this.instance) fs.unlinkSync(this.lockFile);
    } catch { /* already gone */ }
  }
}

module.exports = {
  InstanceLock,
  LOCK_NAME,
  readPortFile,
  writePortFile,
  removePortFile,
  probeHealth,
  pidAlive,
};
