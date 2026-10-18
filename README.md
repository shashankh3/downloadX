# downloadX ⚡

A fast, modern, **zero-dependency** download manager for Windows (works anywhere Node.js runs).
One command, no install wizard, no ads, no nags.

```
node server.js        →  http://127.0.0.1:9765
```
or just double-click **`start.bat`**.

---

## Why it's better than IDM / Ghost Downloader / the rest

| Feature | downloadX | IDM | Ghost Downloader | Free download managers |
|---|---|---|---|---|
| Multi-connection segmented engine | ✅ up to **64** connections, dynamic splitting | ✅ 32 | ✅ | ✅ (usually 8–16) |
| **Live per-segment progress** visualization | ✅ every connection shown in real time | ❌ | ❌ | ❌ |
| Pause / resume across app restarts | ✅ (validated with ETag `If-Range`) | ✅ | ✅ | mixed |
| Auto-retry with exponential backoff | ✅ | basic | basic | mixed |
| **Mirror URLs** — failover per segment | ✅ | ❌ | ❌ | rare |
| Sequential batch patterns `file[01-99].zip` | ✅ built-in | ❌ | ❌ | ❌ |
| Checksum verification (SHA-256/1/512, MD5) | ✅ built into the UI | ❌ | ❌ | rare |
| Per-download **and** global speed limits | ✅ | global only | ✅ | mixed |
| Category auto-sort into folders | ✅ | ✅ | ✅ | ✅ |
| Scheduler window (e.g. only 23:00–07:00) | ✅ | ✅ | ❌ | rare |
| Shutdown PC when queue empties | ✅ with cancel banner | ✅ | ❌ | rare |
| Browser integration | ✅ Chrome/Edge MV3 extension (in `/extension`) | ✅ | ✅ | mixed |
| Full **REST API** + SSE live feed | ✅ script anything | ❌ | ❌ | aria2 only |
| Referer/cookies for picky sites | ✅ | ✅ | ❌ | mixed |
| Price | **free forever** | $25 + nags | free w/ limits | free w/ ads |
| Portable | ✅ single folder, zero deps, state in `/data` | ❌ installer | ❌ installer | mixed |

## Quick start

```bat
cd downloadX
start.bat          (or:  node server.js)
```
The UI opens at **http://127.0.0.1:9765**. Files land in your `Downloads` folder,
sorted into `Programs / Compressed / Video / Music / Documents / Images` (configurable).

Paste a URL anywhere on the page (Ctrl+V) to open the Add dialog pre-filled.

## Browser extension (Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension` folder.
3. Right-click any link / video / image → **Download with downloadX**.
4. Click the toolbar icon to toggle **full interception** (browser downloads get
   cancelled and handed to downloadX instead — the classic IDM behavior).

## Batch patterns

```
https://example.com/photos/img[01-20].jpg
https://example.com/chapter[1-12].pdf
https://example.com/sound[a-z].ogg
https://example.com/pack[one,two,three].zip
```
Paste any number of lines — the dialog previews how many downloads will be created.

## REST API (everything the UI does)

```bash
# add a download (16 connections, referer for hotlink-protected sites)
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/file.zip","segments":16,"referer":"https://example.com/page"}'

curl http://127.0.0.1:9765/api/state                       # full snapshot
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/pause
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/resume
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/verify \
  -d '{"algo":"sha256","expected":"<hash>"}'
curl -X POST "http://127.0.0.1:9765/api/downloads/<id>/limit" -d '{"kbs":500}'
curl -X DELETE "http://127.0.0.1:9765/api/downloads/<id>?file=1"
curl -N http://127.0.0.1:9765/api/events                   # live SSE stream
```

## How the engine works

- **Probe** — a `Range: bytes=0-0` GET discovers final URL (redirects), size, ETag,
  filename (`Content-Disposition`) and whether the server supports ranges at all.
- **Segments** — the file is split across up to 64 ranges. Workers claim the segment
  with the most bytes left and fetch it in 8 MB chunks with positioned writes into a
  pre-allocated `.dxpart` file. When a segment gets ahead, the largest remaining one
  is **split dynamically**, so slow servers never strand a single long tail connection.
- **Resume** — segment progress persists every ~1.5 s to `data/state.json`. On resume
  each range continues exactly where it stopped, validated with `If-Range` + ETag;
  if the file changed server-side the download auto-restarts instead of corrupting.
- **Robustness** — per-segment retries with exponential backoff, mirror rotation,
  wrong-range/overshoot clamping, early-close detection, and a fallback to a single
  streaming connection for range-less servers.
- **Limits** — a token bucket per download plus a global one smooth bandwidth across
  all connections instead of letting one transfer hog the pipe.

## Project layout

```
server.js          HTTP API + SSE + static UI (no dependencies)
lib/engine.js      segmented download engine, queue, scheduler
lib/httpget.js     redirect-following range-aware HTTP client
lib/bucket.js      token-bucket rate limiter
lib/patterns.js    batch URL pattern expander
lib/store.js       atomic JSON state persistence
public/            the web UI (vanilla JS, no build step)
extension/         Chrome/Edge MV3 connector
test/              integration suite, local range-server tests, benchmark (node test/bench.mjs)
data/              runtime state (created on first run)
```

## Notes

- The server binds to **127.0.0.1 only** — nothing is exposed to your network.
- Requires Node.js 18+ (tested on 24). No npm install, ever.
