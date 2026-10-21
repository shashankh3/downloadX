'use strict';
const crypto = require('crypto');
const { URL } = require('url');
const { request } = require('./httpget');

const MAX_PLAYLIST = 10 * 1024 * 1024;

/** Detect HLS/DASH playlists from content-type or URL extension. Returns 'hls' | 'dash' | null. */
function detectPlaylist(headers, urlStr) {
  const ct = String((headers && headers['content-type']) || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('vnd.apple')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
  let pname = '';
  try { pname = new URL(urlStr).pathname.toLowerCase(); } catch { /* ignore */ }
  if (pname.endsWith('.m3u8') || pname.endsWith('.m3u')) return 'hls';
  if (pname.endsWith('.mpd')) return 'dash';
  return null;
}

function resolveUrl(baseUrl, ref) {
  try { return new URL(ref, baseUrl).toString(); } catch { return ref; }
}

function parseAttrs(str) {
  const out = {};
  const re = /([A-Za-z0-9-]+)\s*=\s*("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toUpperCase()] = (m[3] !== undefined ? m[3] : (m[2] || '').trim());
  return out;
}

/** Parse an HLS playlist (master or media). Returns variants[] for masters, segments[] for media. */
function parseM3u8(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) continue;
      variants.push({
        url: resolveUrl(baseUrl, lines[j]),
        bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
      });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { kind: 'master', variants };
  }

  const segments = [];
  let key = null;
  let map = null;
  let mediaSequence = 0;
  let targetDuration = 0;
  let pendingRange = null;
  let rangeNext = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice(line.indexOf(':') + 1)) || 0;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      map = attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      if (!attrs.METHOD || /^NONE$/i.test(attrs.METHOD)) key = null;
      else if (/^AES-128$/i.test(attrs.METHOD) && attrs.URI) {
        key = { method: 'AES-128', url: resolveUrl(baseUrl, attrs.URI), iv: attrs.IV || null };
      } else throw new Error('Unsupported HLS encryption: ' + attrs.METHOD);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const spec = line.slice(line.indexOf(':') + 1).trim();
      const m = /^(\d+)(?:@(\d+))?$/.exec(spec);
      if (m) {
        const len = parseInt(m[1], 10);
        const off = m[2] !== undefined ? parseInt(m[2], 10) : rangeNext;
        pendingRange = { offset: off, length: len };
        rangeNext = off + len;
      }
    } else if (!line.startsWith('#')) {
      segments.push({
        url: resolveUrl(baseUrl, line),
        key,
        map,
        byterange: pendingRange,
        seq: mediaSequence + segments.length,
      });
      pendingRange = null;
    }
  }
  return { kind: 'media', segments, map, mediaSequence, targetDuration };
}

function parseIsoDuration(str) {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(str || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : parseFloat(x))) ;
  return (y || 0) * 31536000 + (mo || 0) * 2592000 + (d || 0) * 86400 + (h || 0) * 3600 + (mi || 0) * 60 + (s || 0);
}

function attrOf(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : '';
}

function fillTemplate(tpl, values) {
  return tpl.replace(/\$(RepresentationID|Bandwidth|Number|Time)\$/g, (_, k) => String(values[k.toLowerCase()] != null ? values[k.toLowerCase()] : ''));
}

/**
 * Parse a DASH MPD. Returns { video, audio } where each is
 * { init, segments: [{ url }], mime, bandwidth } or null.
 * Supports SegmentTemplate ($Number$ / SegmentTimeline $Time$), SegmentList and SegmentBase.
 */
function parseMpd(text, baseUrl) {
  const xml = String(text || '');
  if (!/<MPD[\s>]/i.test(xml)) throw new Error('Not a DASH manifest');

  let base = baseUrl;
  const firstPeriodIdx = xml.search(/<Period[\s>]/i);
  const mpdScope = firstPeriodIdx === -1 ? xml : xml.slice(0, firstPeriodIdx);
  const mpdBaseM = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(mpdScope);
  if (mpdBaseM) base = resolveUrl(base, mpdBaseM[1].trim());

  const periodM = /<Period[\s>][\s\S]*?(?:<\/Period>|$)/i.exec(xml);
  const period = periodM ? periodM[0] : xml;
  const periodDuration = parseIsoDuration(attrOf(period.match(/<Period[^>]*>/)?.[0] || '', 'duration'));
  const pBase = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(period);
  if (pBase) base = resolveUrl(base, pBase[1].trim());

  const sets = [...period.matchAll(/<AdaptationSet[\s>][\s\S]*?(?:<\/AdaptationSet>|$)/gi)];
  const candidates = { video: [], audio: [] };
  for (const setM of sets) {
    const setBlock = setM[0];
    const setTag = setBlock.match(/<AdaptationSet[^>]*>/i)?.[0] || '';
    const setMime = attrOf(setTag, 'mimeType');
    const setType = attrOf(setTag, 'contentType');
    const setBaseUrl = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(setBlock);
    const setBase = setBaseUrl ? resolveUrl(base, setBaseUrl[1].trim()) : base;

    const repOpenRe = /<Representation[^>]*>/gi;
    let repM;
    while ((repM = repOpenRe.exec(setBlock))) {
      const repTag = repM[0];
      const selfClosing = /\/>\s*$/.test(repTag);
      let repBlock = repTag;
      if (!selfClosing) {
        const close = setBlock.indexOf('</Representation>', repM.index);
        if (close !== -1) repBlock = setBlock.slice(repM.index, close + '</Representation>'.length);
      }
      const mime = attrOf(repTag, 'mimeType') || setMime;
      const type = attrOf(repTag, 'contentType') || setType || (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : '');
      if (type !== 'video' && type !== 'audio') continue;
      const bandwidth = parseInt(attrOf(repTag, 'bandwidth'), 10) || 0;
      const repId = attrOf(repTag, 'id') || '0';
      const repBaseUrl = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(repBlock);
      const repBase = repBaseUrl ? resolveUrl(setBase, repBaseUrl[1].trim()) : setBase;

      let init = null;
      const segments = [];

      const tplBlockFull = /<SegmentTemplate[\s\S]*?<\/SegmentTemplate>/i.exec(repBlock);
      const tplBlock = tplBlockFull ? tplBlockFull[0] : (/<SegmentTemplate[^>]*>/i.exec(repBlock)?.[0] || '');
      if (tplBlock) {
        const tplTag = tplBlock.match(/<SegmentTemplate[^>]*>/i)?.[0] || '';
        const initTpl = attrOf(tplTag, 'initialization');
        const mediaTpl = attrOf(tplTag, 'media');
        const timescale = parseInt(attrOf(tplTag, 'timescale'), 10) || 1;
        const startNumber = parseInt(attrOf(tplTag, 'startNumber'), 10) || 1;
        const segDur = parseInt(attrOf(tplTag, 'duration'), 10) || 0;
        if (initTpl) init = resolveUrl(repBase, fillTemplate(initTpl, { representationid: repId, bandwidth }));
        const sTags = [...tplBlock.matchAll(/<S\s+([^>]*?)\/?>/gi)];
        if (sTags.length) {
          let t = 0;
          let num = startNumber;
          for (const sM of sTags) {
            const attrs = parseAttrs(sM[1]);
            const d = parseInt(attrs.D, 10) || 0;
            const rep = parseInt(attrs.R, 10) || 0;
            if (attrs.T !== undefined) t = parseInt(attrs.T, 10) || 0;
            for (let k = 0; k <= rep; k++) {
              if (mediaTpl) segments.push({ url: resolveUrl(repBase, fillTemplate(mediaTpl, { representationid: repId, bandwidth, time: t, number: num })) });
              t += d;
              num++;
            }
          }
        } else if (segDur > 0 && periodDuration > 0 && mediaTpl) {
          const count = Math.ceil(periodDuration / (segDur / timescale));
          for (let i = 0; i < count; i++) {
            segments.push({ url: resolveUrl(repBase, fillTemplate(mediaTpl, { representationid: repId, bandwidth, number: startNumber + i })) });
          }
        }
      }

      if (!segments.length) {
        const listBlock = (/<SegmentList[\s\S]*?<\/SegmentList>/i.exec(repBlock) || /<SegmentList[^>]*>/i.exec(repBlock))?.[0];
        if (listBlock) {
          const initSrc = attrOf(listBlock.match(/<Initialization[^>]*>/i)?.[0] || '', 'sourceURL');
          if (initSrc) init = resolveUrl(repBase, initSrc);
          for (const seg of listBlock.matchAll(/<SegmentURL[^>]*>/gi)) {
            const media = attrOf(seg[0], 'media');
            if (media) segments.push({ url: resolveUrl(repBase, media) });
          }
        }
      }

      if (!segments.length && /<SegmentBase[\s>]/i.test(repBlock)) {
        const media = repBaseUrl ? repBaseUrl[1].trim() : (/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(setBlock)?.[1] || '').trim();
        if (media) segments.push({ url: resolveUrl(setBase, media) });
      }

      if (!segments.length) continue;
      candidates[type].push({ init, segments, mime, bandwidth, id: repId, repBase });
    }
  }

  const pick = (list) => {
    if (!list.length) return null;
    list.sort((a, b) => b.bandwidth - a.bandwidth);
    return list[0];
  };
  return { video: pick(candidates.video), audio: pick(candidates.audio) };
}

/** Choose a sensible output filename for a captured stream. */
function renameForStream(filename, kind, plan) {
  const ext = (filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  let nextExt = '';
  if (kind === 'hls') {
    const segs = (plan && plan.segments) || [];
    nextExt = segs.some((s) => /\.ts(\?|#|$)/i.test(s.url)) ? '.ts' : '.mp4';
  } else {
    nextExt = '.mp4';
  }
  if (['.m3u8', '.m3u', '.mpd', '.mp4', '.ts', ''].includes(ext)) {
    return filename.slice(0, filename.length - ext.length) + nextExt;
  }
  return filename;
}

function ivFromSequence(seq) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(seq >>> 0, 12);
  return buf;
}

/**
 * Decrypt an AES-128-CBC HLS segment.
 *
 * PKCS#7 padding is removed by OpenSSL itself, which validates every padding
 * byte — so a plaintext that merely *ends* with a small number is never
 * truncated. Streams that are padded with zeros instead of PKCS#7 fall back to
 * an unpadded decryption.
 */
function decryptAes128(buf, key, iv) {
  if (key.length !== 16) throw new Error('Invalid AES-128 key length');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  } catch (e) {
    const raw = crypto.createDecipheriv('aes-128-cbc', key, iv);
    raw.setAutoPadding(false);
    try {
      return Buffer.concat([raw.update(buf), raw.final()]);
    } catch {
      throw e;
    }
  }
}

/**
 * Fetch a full response body as a Buffer.
 * hooks: { onReq(req), onDone(req) } lets the engine abort in-flight requests.
 */
async function fetchBuffer(urlStr, opts = {}, hooks = {}) {
  const { req, res } = await request(urlStr, opts);
  if (hooks.onReq) hooks.onReq(req);
  try {
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.destroy();
      throw new Error('Too many redirects (' + urlStr + ')');
    }
    if (res.statusCode >= 400) {
      res.destroy();
      const e = new Error('HTTP ' + res.statusCode + ' (' + urlStr + ')');
      if (res.statusCode < 500) e.fatal = true;
      throw e;
    }
    const chunks = [];
    let len = 0;
    await new Promise((resolve, reject) => {
      res.on('data', (d) => {
        len += d.length;
        chunks.push(d);
      });
      res.on('end', () => {
        if (res.complete) resolve();
        else reject(new Error('Connection closed early'));
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Connection aborted')));
      res.on('close', () => { if (!res.complete) reject(new Error('Connection closed early')); });
    });
    return Buffer.concat(chunks);
  } finally {
    if (hooks.onDone) hooks.onDone(req);
  }
}

async function fetchText(urlStr, opts = {}, hooks = {}) {
  const buf = await fetchBuffer(urlStr, opts, hooks);
  if (buf.length > MAX_PLAYLIST) throw new Error('Playlist too large');
  return buf.toString('utf8');
}

module.exports = {
  detectPlaylist,
  parseM3u8,
  parseMpd,
  renameForStream,
  decryptAes128,
  ivFromSequence,
  fetchBuffer,
  fetchText,
  resolveUrl,
};
