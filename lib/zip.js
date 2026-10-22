'use strict';
/*
 * A ZIP reader built from Buffer, DataView and node:zlib.
 *
 * A ZIP keeps its directory at the end of the archive, so the content can be
 * read with two range requests - and a single broken entry can be repaired
 * without downloading the whole archive again.
 */
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const TAIL_SIZE = 65558;

/* ---------------- CRC-32 (IEEE 802.3) ---------------- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/**
 * The CRC-32 of a buffer, optionally continuing a previous value.
 * @param {Buffer} buf
 * @param {number} [seed] the result of the previous call
 * @returns {number}
 */
function crc32(buf, seed = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, seed) >>> 0;
  const table = crcTable();
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- the directory ---------------- */

/**
 * Find the end of central directory record in a tail buffer.
 * @param {Buffer} buf the last bytes of the archive
 * @returns {object|null}
 */
function parseEocd(buf) {
  if (!buf || buf.length < EOCD_MIN_SIZE) return null;
  for (let i = buf.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const entries = buf.readUInt16LE(i + 10);
    const cdSize = buf.readUInt32LE(i + 12);
    const cdOffset = buf.readUInt32LE(i + 16);
    const out = {
      entries,
      cdSize,
      cdOffset,
      zip64: false,
      zip64RecordOffset: 0,
      eocdOffset: i,
    };
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
      const loc = i - 20;
      if (loc >= 0 && buf.readUInt32LE(loc) === EOCD64_LOCATOR_SIG) {
        out.zip64 = true;
        out.zip64RecordOffset = Number(buf.readBigUInt64LE(loc + 8));
      }
    }
    return out;
  }
  return null;
}

/**
 * Read the ZIP64 end of central directory record.
 * @param {Buffer} buf the bytes at the record offset
 * @returns {object|null}
 */
function parseEocd64(buf) {
  if (!buf || buf.length < 56 || buf.readUInt32LE(0) !== EOCD64_SIG) return null;
  return {
    entries: Number(buf.readBigUInt64LE(32)),
    cdSize: Number(buf.readBigUInt64LE(40)),
    cdOffset: Number(buf.readBigUInt64LE(48)),
    zip64: true,
  };
}

/**
 * Read the central directory.
 * @param {Buffer} cd
 * @returns {{ name: string, method: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number, zip64: boolean }[]}
 */
function parseCentralDirectory(cd) {
  const entries = [];
  let off = 0;
  while (off + 46 <= cd.length) {
    if (cd.readUInt32LE(off) !== CD_SIG) break;
    const method = cd.readUInt16LE(off + 10);
    const expected = cd.readUInt32LE(off + 16);
    const compressedSize = cd.readUInt32LE(off + 20);
    const uncompressedSize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localHeaderOffset = cd.readUInt32LE(off + 42);
    const name = cd.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({
      name,
      method,
      crc32: expected,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      zip64: compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read the directory of a local archive.
 * @param {string} filePath
 * @returns {Promise<{ entries: object[], eocd: object }|null>}
 */
async function readLocalIndex(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLen = Math.min(TAIL_SIZE, size);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    const eocd = parseEocd(tail);
    if (!eocd) return null;
    let info = eocd;
    if (eocd.zip64 && eocd.zip64RecordOffset >= 0) {
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, eocd.zip64RecordOffset);
      const parsed = parseEocd64(record);
      if (parsed) info = Object.assign({}, eocd, parsed);
    }
    const cd = Buffer.alloc(info.cdSize);
    await handle.read(cd, 0, info.cdSize, info.cdOffset);
    return { eocd: info, entries: parseCentralDirectory(cd) };
  } finally {
    await handle.close();
  }
}

/**
 * The offset where the data of an entry starts.
 * @param {Buffer} localHeader
 * @returns {number}
 */
function payloadOffset(localHeader) {
  return 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
}

/**
 * Check one entry against its CRC-32.
 * @param {string} filePath the archive
 * @param {object} entry the central directory entry
 * @returns {Promise<{ ok: boolean, crc32: number, error?: string }>}
 */
async function verifyEntry(filePath, entry) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== LOCAL_SIG) {
      return { ok: false, crc32: 0, error: 'Invalid local file header' };
    }
    const start = entry.localHeaderOffset + payloadOffset(header);
    let crc = 0;
    if (entry.method === 0) {
      const chunk = Buffer.alloc(1024 * 1024);
      let pos = start;
      let left = entry.compressedSize;
      while (left > 0) {
        const read = await handle.read(chunk, 0, Math.min(chunk.length, left), pos);
        if (!read.bytesRead) break;
        crc = crc32(chunk.subarray(0, read.bytesRead), crc);
        pos += read.bytesRead;
        left -= read.bytesRead;
      }
    } else if (entry.method === 8) {
      const inflate = zlib.createInflateRaw();
      let error = null;
      inflate.on('data', (chunk) => { crc = crc32(chunk, crc); });
      const source = fs.createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
      await new Promise((resolve) => {
        source.on('error', (e) => { error = e; resolve(); });
        inflate.on('error', (e) => { error = e; resolve(); });
        inflate.on('end', () => resolve());
        source.pipe(inflate);
      });
      if (error) return { ok: false, crc32: crc, error: error.message };
    } else {
      return { ok: false, crc32: 0, error: 'Unsupported compression method ' + entry.method };
    }
    return { ok: crc === entry.crc32, crc32: crc };
  } finally {
    await handle.close();
  }
}

/**
 * Check every entry of a local archive.
 * @param {string} filePath
 * @param {object[]} entries
 * @param {(entry: object) => Promise<boolean>} [skip] returns true to skip an entry
 * @returns {Promise<{ checked: number, broken: object[] }>}
 */
async function verifyEntries(filePath, entries, skip) {
  const broken = [];
  let checked = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (skip && await skip(entry)) continue;
    checked++;
    const result = await verifyEntry(filePath, entry);
    if (!result.ok) broken.push({ name: entry.name, error: result.error || 'CRC mismatch' });
  }
  return { checked, broken };
}

/**
 * The byte ranges that hold the data of the given entries.
 * @param {object[]} entries
 * @param {Buffer} [localHeaders] the local headers, when they are known
 * @returns {{ start: number, end: number }[]}
 */
function entryRanges(entries, localHeaders) {
  const ranges = [];
  for (const entry of entries) {
    const header = localHeaders && localHeaders.get(entry.localHeaderOffset);
    const start = entry.localHeaderOffset + (header ? payloadOffset(header) : 0);
    ranges.push({ start, end: start + entry.compressedSize - 1 });
  }
  return ranges;
}

/**
 * Write one entry of a local archive to a file.
 * @param {string} filePath the archive
 * @param {object} entry the central directory entry
 * @param {string} outPath where the entry is written
 * @returns {Promise<{ ok: boolean, bytes: number, error?: string }>}
 */
async function extractEntry(filePath, entry, outPath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== LOCAL_SIG) {
      return { ok: false, bytes: 0, error: 'Invalid local file header' };
    }
    const start = entry.localHeaderOffset + payloadOffset(header);
    const out = fs.createWriteStream(outPath);
    try {
      if (entry.method === 0) {
        const src = fs.createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
        await new Promise((resolve, reject) => {
          src.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          src.pipe(out);
        });
      } else if (entry.method === 8) {
        const inflate = zlib.createInflateRaw();
        const src = fs.createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
        await new Promise((resolve, reject) => {
          src.on('error', reject);
          inflate.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          src.pipe(inflate).pipe(out);
        });
      } else {
        return { ok: false, bytes: 0, error: 'Unsupported compression method ' + entry.method };
      }
    } catch (e) {
      return { ok: false, bytes: 0, error: e.message };
    }
    return { ok: true, bytes: entry.uncompressedSize };
  } finally {
    await handle.close();
  }
}

module.exports = {
  crc32,
  parseEocd,
  parseEocd64,
  parseCentralDirectory,
  readLocalIndex,
  verifyEntry,
  verifyEntries,
  extractEntry,
  entryRanges,
  payloadOffset,
  EOCD_SIG,
  EOCD64_SIG,
  EOCD64_LOCATOR_SIG,
  CD_SIG,
  LOCAL_SIG,
  TAIL_SIZE,
};
