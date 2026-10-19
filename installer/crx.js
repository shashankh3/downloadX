'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function zipStore(files, when = new Date()) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(when);
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const data = file.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function readTree(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTree(full, base));
    else if (entry.isFile() && !/\.(pem|crx|xpi)$/i.test(entry.name)) {
      out.push({ name: path.relative(base, full).replace(/\\/g, '/'), data: fs.readFileSync(full) });
    }
  }
  return out;
}

function loadOrCreateKey(file) {
  if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

function publicKeyDer(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
}

function extensionId(publicDer) {
  const hex = crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function varint(n) {
  const bytes = [];
  while (n > 127) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); }
  bytes.push(n & 127);
  return Buffer.from(bytes);
}

function fieldBytes(field, buf) {
  return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
}

function buildCrx(zip, privateKey) {
  const publicDer = publicKeyDer(privateKey);
  const crxId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16);
  const signedHeader = fieldBytes(1, crxId);
  const prefix = Buffer.from('CRX3 SignedData\x00', 'binary');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeader.length, 0);
  const payload = Buffer.concat([prefix, size, signedHeader, zip]);
  const signature = crypto.sign('sha256', payload, privateKey);
  const proof = Buffer.concat([fieldBytes(1, publicDer), fieldBytes(2, signature)]);
  const header = Buffer.concat([fieldBytes(2, proof), fieldBytes(10000, signedHeader)]);
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'binary');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, zip]);
}

function updateManifest(id, version, codebase) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
    `  <app appid='${x(id)}'>`,
    `    <updatecheck codebase='${x(codebase)}' version='${x(version)}' />`,
    '  </app>',
    '</gupdate>',
    '',
  ].join('\n');
}

function buildFromDir(srcDir, privateKey, when = new Date()) {
  return buildCrx(zipStore(readTree(srcDir), when), privateKey);
}

module.exports = {
  crc32, zipStore, readTree, loadOrCreateKey, publicKeyDer, extensionId,
  buildCrx, buildFromDir, updateManifest,
};
