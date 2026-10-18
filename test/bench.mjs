// Benchmark: same 25MB file, 1 connection vs 7 connections (1.25 MB/s per-connection cap)
const BASE = 'http://127.0.0.1:9765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = await import('node:http');
const crypto = await import('node:crypto');

const BLOB = crypto.randomBytes(25 * 1024 * 1024);
const srv = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = BLOB.length - 1;
  if (m) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), BLOB.length - 1); }
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BLOB.length}` } : {}),
  });
  let pos = start;
  const iv = setInterval(() => {           // ~1.25 MB/s per connection (128KB / 100ms)
    if (res.destroyed || pos > end) { clearInterval(iv); if (pos > end) res.end(); return; }
    const n = Math.min(128 * 1024, end - pos + 1);
    res.write(BLOB.subarray(pos, pos + n));
    pos += n;
  }, 100);
  req.on('close', () => clearInterval(iv));
});
await new Promise((r) => srv.listen(9116, '127.0.0.1', r));

async function run(name, segments) {
  const d = await (await fetch(BASE + '/api/downloads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:9116/bench.bin', segments, dir: 'C:\\Users\\sonali\\AppData\\Local\\Temp\\dlx-bench' }),
  })).json();
  const t0 = Date.now();
  for (;;) {
    await sleep(300);
    const it = await (await fetch(BASE + '/api/state')).json();
    const x = it.items.find((i) => i.id === d.id);
    if (['completed', 'failed'].includes(x.status)) {
      const secs = (Date.now() - t0) / 1000;
      const mbps = 25 / secs;
      return { name, secs, mbps, status: x.status, segs: x.segments.length };
    }
  }
}

const single = await run('1 connection', 1);
const multi = await run('7 connections', 16);
console.log(`${single.name}: 25 MB in ${single.secs.toFixed(1)}s = ${single.mbps.toFixed(2)} MB/s`);
console.log(`${multi.name}: 25 MB in ${multi.secs.toFixed(1)}s = ${multi.mbps.toFixed(2)} MB/s`);
console.log(`speedup: ${ (multi.mbps / single.mbps).toFixed(1) }x`);
srv.close();
process.exit(0);
