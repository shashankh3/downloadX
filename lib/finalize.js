'use strict';
/*
 * Finalization, verification and repair of a Download.
 *
 * Checksum verification, entry-by-entry ZIP archive repair, antivirus
 * scanning, sparse file unmarking, atomic file promotion and Mark-of-the-Web.
 * The methods are mixed into the Download class (see lib/download.js) and use
 * "this" exactly like the methods that live there.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeHash, guessAlgo, CHECKSUM_ALGOS } = require('./naming');
const { unmarkFileSparse, promoteFile } = require('./util');
const { scanFile, writeMarkOfTheWeb } = require('./av');
const { readLocalIndex, verifyEntries } = require('./zip');

class FinalizeMixin {
  _dedupeFinalName() {
    const ext = path.extname(this.filename);
    const base = this.filename.slice(0, this.filename.length - ext.length);
    let n = 1;
    while (fs.existsSync(path.join(this.destDir, this.filename))) {
      this.filename = `${base} (${n++})${ext}`;
      if (n > 9999) break;
    }
  }

  /**
   * A ZIP archive is repaired entry by entry: only the damaged entries are
   * downloaded again, not the whole file.
   * @returns {Promise<{ broken: object[], requeued: boolean }|null>} null when the
   *   file is not a ZIP or too much of it is damaged
   */
  async _repairZipEntries() {
    if (!/\.zip$/i.test(this.filename)) return null;
    let index;
    try {
      index = await readLocalIndex(this.finalPath);
    } catch { return null; }
    if (!index || !index.entries.length) return null;
    let verified;
    try {
      verified = await verifyEntries(this.finalPath, index.entries);
    } catch { return null; }
    if (!verified.broken.length) return null;
    // More than a quarter of the archive is damaged: a plain retry is cheaper.
    const brokenNames = new Set(verified.broken.map((b) => b.name));
    const damaged = index.entries.filter((e) => brokenNames.has(e.name));
    const damagedBytes = damaged.reduce((sum, e) => sum + (e.compressedSize || 0), 0);
    if (damagedBytes * 4 > (this.total || damagedBytes)) return null;

    // The byte ranges of the damaged entries, so the segments that cover them
    // can be fetched again.
    const ranges = [];
    for (const entry of damaged) {
      const start = entry.localHeaderOffset;
      const end = start + entry.compressedSize;
      ranges.push({ start, end });
    }
    // Move the file back to the part file, so the transfer can continue.
    try { fs.renameSync(this.finalPath, this.partPath); } catch { return null; }
    let reset = 0;
    for (const seg of this.segments || []) {
      const segEnd = seg.end >= 0 ? seg.end : seg.start + this.total;
      for (const range of ranges) {
        if (range.start <= segEnd && range.end >= seg.start) {
          seg.downloaded = 0;
          reset++;
          break;
        }
      }
    }
    if (!reset) {
      // Nothing to reset: put the file back and give up on the repair.
      try { fs.renameSync(this.partPath, this.finalPath); } catch { /* best effort */ }
      return null;
    }
    this.checksum = null;
    this.status = 'queued';
    this.error = 'Damaged archive - fetching the broken entries again';
    this.engine.markDirty();
    this.engine.saveSoon();
    return { broken: verified.broken, requeued: true };
  }

  async _finalize() {
    if (this._stop) return;
    // Any error text from a transient retry is stale once the file is complete.
    this.error = '';
    // The part path is derived from the current file name, so it has to be
    // captured before a collision can rename the destination.
    const partPath = this.partPath;
    const got = this.received;
    if (this.total > 0 && got !== this.total) {
      throw new Error(`Size mismatch: got ${got} of ${this.total} bytes`);
    }
    if (!this._singleDone && (!this.segments || !this.segments.length)) throw new Error('No data written');
    if (this.total <= 0) {
      const st = fs.statSync(partPath);
      if (st.size > 0) this.total = st.size;
    }
    fs.mkdirSync(this.destDir, { recursive: true });
    /*
     * The antivirus looks at the file before it gets its final name, so a
     * download that carries malware never shows up in the download folder.
     */
    if (this.engine.settings.avScanEnabled) {
      const scan = await scanFile(partPath, { timeoutMs: this.engine.settings.avTimeoutMs });
      if (scan.threat) {
        try { fs.unlinkSync(partPath); } catch { /* best effort */ }
        this.status = 'failed';
        this.error = 'Antivirus: ' + scan.error;
        this.speed = 0; this.eta = -1;
        this.engine.markDirty();
        this.engine.saveSoon();
        this.engine.notifyWebhook('failed', this);
        return;
      }
    }
    if (this._sparse) {
      // The file is complete, so the holes are gone: the sparse attribute is
      // not needed any more.
      try { await unmarkFileSparse(partPath); } catch { /* best effort */ }
      this._sparse = false;
    }
    /*
     * Promote the part file without ever clobbering an existing destination.
     * POSIX rename() replaces silently, so a second download that finished
     * between _dedupeName() and this point could lose its bytes. The
     * hard-link promotion is atomic and reports the collision instead.
     */
    for (let attempt = 0; ; attempt++) {
      if (promoteFile(partPath, this.finalPath)) break;
      this._dedupeFinalName();
      if (attempt > 9999) throw new Error('Could not find a free file name');
    }
    if (this.expectedChecksum) {
      const result = await this.verifyChecksum(this.checksumAlgo, this.expectedChecksum);
      if (!result.ok) {
        if (!this._repairTried) {
          /*
           * The file does not match the expected hash: the transfer was
           * damaged. Download it once more before giving up.
           */
          this._repairTried = true;
          this.checksum = null;
          try { fs.unlinkSync(this.finalPath); } catch { /* nothing there */ }
          this.segments = null;
          this.total = 0;
          this._singleDone = false;
          this._forceSingle = false;
          this._restartedOnce = false;
          this.status = 'queued';
          this.error = 'Checksum mismatch - downloading again';
          this.engine.markDirty();
          this.engine.saveSoon();
          return;
        }
        // A ZIP archive can be repaired entry by entry.
        const repair = await this._repairZipEntries();
        if (repair) return;
        this.error = 'Checksum mismatch (expected ' + normalizeHash(this.expectedChecksum).slice(0, 16) + '…)';
      } else {
        this.error = '';
      }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.speed = 0; this.eta = -1;
    /*
     * Tell Windows that the file came from the internet, so SmartScreen and
     * the attachment services treat it like a download and not like a file the
     * user made themselves.
     */
    if (this.engine.settings.writeMarkOfTheWeb !== false) {
      writeMarkOfTheWeb(this.finalPath, { hostUrl: this.finalUrl, referrerUrl: this.referer });
    }
    this.engine.markDirty();
    this.engine.saveSoon();
    this.engine.notifyWebhook('completed', this);
  }

  async verifyChecksum(algo, expected) {
    if (!algo) algo = guessAlgo(expected);
    if (!CHECKSUM_ALGOS.includes(algo)) throw new Error('Unsupported algorithm');
    const expectedNorm = normalizeHash(expected);
    if (!expectedNorm) throw new Error('Expected checksum is empty');
    const file = fs.existsSync(this.finalPath) ? this.finalPath : (fs.existsSync(this.partPath) ? this.partPath : '');
    if (!file) throw new Error('File not found (download it first)');
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algo);
      const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
      stream.on('data', (d) => hash.update(d));
      stream.on('error', reject);
      stream.on('end', () => {
        const actual = hash.digest('hex');
        this.checksum = { algo, expected: expectedNorm, actual, ok: actual === expectedNorm, at: Date.now(), file };
        this.engine.markDirty();
        this.engine.saveNow();
        resolve(this.checksum);
      });
    });
  }
}

module.exports = FinalizeMixin;
