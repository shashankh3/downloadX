'use strict';
/*
 * Which origins may talk to the local API, and which network addresses may be
 * reached at all.
 *
 * The origin rules keep websites from driving the local API. The address rules
 * stop a remote document (an HLS playlist, a redirect) from using downloadX as a
 * proxy into the private network of the machine it runs on.
 */
const dns = require('dns');

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/([^/]+)$/i;

/* Address ranges that must never be reached through a remote document. */
const PRIVATE_IPV4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],     // carrier grade NAT
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link local (cloud metadata!)
  ['172.16.0.0', 12],     // RFC 1918
  ['192.0.0.0', 24],      // IETF protocol assignments
  ['192.168.0.0', 16],    // RFC 1918
  ['198.18.0.0', 15],     // benchmarking
  ['224.0.0.0', 4],       // multicast
  ['240.0.0.0', 4],       // reserved
];

const PRIVATE_IPV6 = [
  ['::', 128],            // unspecified
  ['::1', 128],           // loopback
  ['fc00', 7],            // unique local
  ['fe80', 10],           // link local
  ['ff00', 8],            // multicast
];

/**
 * Turn a list or a comma separated string into lower case ids.
 * @param {string[]|string} value
 * @returns {string[]}
 */
function normalizeIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return list.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Build the origin check.
 * @param {{ allowedIds?: string[]|string }} [options]
 * @returns {(origin: string) => boolean}
 */
function createOriginCheck(options = {}) {
  const pinned = normalizeIds(options.allowedIds);
  return function isAllowedOrigin(origin) {
    if (!origin) return true;
    const ext = EXTENSION_ORIGIN.exec(origin);
    if (ext) {
      if (!pinned.length) return true;
      return pinned.includes(ext[2].toLowerCase());
    }
    return LOOPBACK_ORIGIN.test(origin);
  };
}

/* ---------------- address checks ---------------- */

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function inCidrV4(ip, cidr, bits) {
  const value = ipv4ToInt(ip);
  const base = ipv4ToInt(cidr);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

/** Expand an IPv6 address into its eight 16 bit groups. */
function ipv6Groups(ip) {
  let text = String(ip).trim().toLowerCase();
  if (text.includes('%')) text = text.split('%')[0];
  if (text.includes('.')) {
    // an IPv4 mapped address: ::ffff:127.0.0.1
    const v4 = ipv4ToInt(text.slice(text.lastIndexOf(':') + 1));
    if (v4 === null) return null;
    const high = (v4 >>> 16) & 0xffff;
    const low = v4 & 0xffff;
    text = text.slice(0, text.lastIndexOf(':')) + ':' + high.toString(16) + ':' + low.toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
    if (groups.length < 8) groups = groups.concat(new Array(8 - groups.length).fill('0'));
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function inCidrV6(ip, prefix, bits) {
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  const base = ipv6Groups(prefix);
  if (!base) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (base[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * True when the address is loopback, link local, private or otherwise
 * reserved - the ranges a remote document must not be able to reach.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIp(ip) {
  const text = String(ip || '').trim();
  if (!text) return false;
  if (ipv4ToInt(text) !== null) {
    return PRIVATE_IPV4.some(([cidr, bits]) => inCidrV4(text, cidr, bits));
  }
  const groups = ipv6Groups(text);
  if (!groups) return false;
  if (PRIVATE_IPV6.some(([prefix, bits]) => inCidrV6(text, prefix, bits))) return true;
  // an IPv4 mapped address inherits the IPv4 rules
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return PRIVATE_IPV4.some(([cidr, bits]) => inCidrV4(v4, cidr, bits));
  }
  return false;
}

/**
 * A dns.lookup replacement that refuses private and reserved addresses.
 * @param {boolean} allowPrivate true to allow them
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
function createSafeLookup(allowPrivate) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const done = typeof callback === 'function' ? callback : () => {};
    const opts = { ...(options || {}) };
    const wantAll = opts.all === true;
    delete opts.all;
    dns.lookup(hostname, { ...opts, all: wantAll }, (err, address, family) => {
      if (err) return done(err);
      const list = wantAll ? (address || []) : [{ address, family }];
      const blocked = list.filter((entry) => isPrivateOrReservedIp(entry.address));
      if (!allowPrivate && blocked.length) {
        const error = new Error('Refusing to reach the private address ' + blocked[0].address);
        error.code = 'EHOSTUNREACH';
        return done(error);
      }
      if (wantAll) return done(null, list);
      return done(null, list[0].address, list[0].family);
    });
  };
}

module.exports = {
  createOriginCheck,
  normalizeIds,
  isPrivateOrReservedIp,
  createSafeLookup,
  LOOPBACK_ORIGIN,
  EXTENSION_ORIGIN,
  PRIVATE_IPV4,
  PRIVATE_IPV6,
};
