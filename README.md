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
| Pause / resume across app restarts | ✅ validated with `If-Range` (ETag or Last-Modified) | ✅ | ✅ | mixed |
| Auto-retry with exponential backoff + `Retry-After` | ✅ | basic | basic | mixed |
| **Mirror URLs** — failover per request | ✅ | ❌ | ❌ | rare |
| Sequential batch patterns `file[01-99].zip` | ✅ built-in (ranges, steps, lists, letters, cartesian) | ❌ | ❌ | ❌ |
| Checksum verification (SHA-256/1/512, MD5) | ✅ auto-verify + on-demand | ❌ | ❌ | rare |
| Per-download **and** global speed limits | ✅ | global only | ✅ | mixed |
| Category auto-sort into folders | ✅ | ✅ | ✅ | ✅ |
| Scheduler window (e.g. only 23:00–07:00) | ✅ | ✅ | ❌ | rare |
| Shutdown PC when queue empties | ✅ with cancel countdown | ✅ | ❌ | rare |
| Browser integration | ✅ Chrome/Edge MV3 extension (in `/extension`) | ✅ | ✅ | mixed |
| Full **REST API** + SSE live feed | ✅ script anything | ❌ | ❌ | aria2 only |
| Referer / cookies for picky sites | ✅ | ✅ | ❌ | mixed |
| Price | **free forever** | $25 + nags | free w/ limits | free w/ ads |
| Portable | ✅ single folder, zero deps, state in `/data` | ❌ installer | ❌ installer | mixed |

## Quick start

```bat
cd downloadX
start.bat          (or:  node server.js)
```

The UI opens at **http://127.0.0.1:9765**. Files land in your `Downloads` folder,
sorted into `Programs / Compressed / Video / Music / Documents / Images` (configurable).

Paste a URL anywhere on the page (Ctrl+V), or drop a link onto the window, to open the
Add dialog pre-filled.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DLX_PORT` | `9765` | HTTP port (if unset, the next free port is tried automatically) |
| `DLX_HOST` | `127.0.0.1` | Bind address |
| `DLX_DATA_DIR` | `./data` | Where `state.json` lives |
| `DLX_DEBUG` | unset | Log every HTTP range request |
| `DLX_OPEN` | unset | Set to `1` to open the UI in your browser once the server is listening |

## Browser extension (Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension` folder.
3. Right-click any link / video / image → **Download with downloadX**.
4. Click the toolbar icon to toggle **full interception** (browser downloads get
   cancelled and handed to downloadX instead — the classic IDM behavior).
   The badge shows `ON` while interception is active, `✓` on success and `!` when
   the local server is unreachable.

If you run downloadX on a non-default port, set `apiBase` in the extension's storage
(`chrome.storage.local`) to e.g. `http://127.0.0.1:9766`.

## Batch patterns

```
https://example.com/photos/img[01-20].jpg
https://example.com/chapter[1-12].pdf
https://example.com/sound[a-z].ogg
https://example.com/pack[one,two,three].zip
https://example.com/p[1-20:2].bin          # step by 2
https://example.com/a[1-2]-b[x,y].txt      # cartesian product
```

Paste any number of lines — the dialog previews how many downloads will be created.
Invalid patterns are reported instead of silently producing wrong URLs; expansion is
capped at 1000 URLs per request.

## REST API (everything the UI does)

```bash
# add a download (16 connections, referer for hotlink-protected sites)
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/file.zip","segments":16,"referer":"https://example.com/page"}'

# mirrors + expected checksum
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://a.example/file.zip","mirrors":["https://b.example/file.zip"],"expectedChecksum":"<sha256>"}'

curl http://127.0.0.1:9765/api/health                      # version, pid, uptime
curl http://127.0.0.1:9765/api/state                       # full snapshot
curl http://127.0.0.1:9765/api/settings
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/pause
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/resume
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/retry
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/restart
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/verify \
  -H "Content-Type: application/json" -d '{"algo":"sha256","expected":"<hash>"}'
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/limit \
  -H "Content-Type: application/json" -d '{"kbs":500}'
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/priority \
  -H "Content-Type: application/json" -d '{"value":10}'
curl -X POST http://127.0.0.1:9765/api/downloads/<id>/segments \
  -H "Content-Type: application/json" -d '{"value":32}'
curl -X DELETE "http://127.0.0.1:9765/api/downloads/<id>?file=1"
curl -X POST http://127.0.0.1:9765/api/pause-all
curl -X POST http://127.0.0.1:9765/api/resume-all
curl -X POST http://127.0.0.1:9765/api/retry-failed
curl -X POST http://127.0.0.1:9765/api/clear-finished \
  -H "Content-Type: application/json" -d '{"deleteFiles":false}'
curl -X POST http://127.0.0.1:9765/api/cancel-shutdown
curl -X POST http://127.0.0.1:9765/api/expand \
  -H "Content-Type: application/json" -d '{"text":"https://x/f[01-03].zip"}'
curl -N http://127.0.0.1:9765/api/events                    # live SSE stream
```

`POST /api/downloads` accepts `url`, `urls`, or `text` (pattern-expanded), plus
`filename`, `category`, `segments`, `speedLimitKBs`, `mirrors`, `referer`, `cookies`,
`dir`, `expectedChecksum`, `checksumAlgo`, `priority` and `startedPaused`.
Multi-URL requests create one download per URL and ignore `filename`.

### Security model

The server is local-only and hardened against drive-by attacks from websites:

- binds `127.0.0.1` by default and rejects requests whose `Host` header is not loopback;
- CORS is allowlisted to loopback origins and browser-extension origins — other sites
  cannot read responses or issue cross-origin writes;
- static files are contained with `path.relative` (no `..` escape, encoded or not);
- JSON bodies are capped at 1 MB and must use `Content-Type: application/json`;
- category and filename inputs are sanitized (Windows reserved names, path separators,
  control characters);
- the UI ships a strict CSP and the API responses carry `nosniff` / `DENY` headers.

## How the engine works

- **Probe** — a `Range: bytes=0-0` GET discovers the final URL (redirects), size,
  ETag / Last-Modified, filename (`Content-Disposition`) and whether the server supports
  ranges at all. Mirrors are probed in order until one works.
- **Segments** — the file is split across up to 64 ranges. Workers claim the segment
  with the most bytes left and fetch it in 8 MB chunks with positioned writes into a
  pre-allocated `.dxpart` file. When a segment gets ahead, the largest remaining one
  is **split dynamically**, so slow servers never strand a single long tail connection.
- **Resume** — segment progress persists every ~1.5 s to `data/state.json`. On resume
  each range continues exactly where it stopped, validated with `If-Range`; if the file
  changed server-side the download auto-restarts instead of corrupting.
- **Robustness** — per-segment retries with exponential backoff and `Retry-After`
  support, mirror rotation on 4xx/5xx, wrong-range and overshoot clamping, early-close
  detection, unknown-size (chunked) single-stream handling, fatal disk errors
  (`ENOSPC`, `EDQUOT`, …) surfaced immediately, and a fallback to a single streaming
  connection for range-less servers.
- **Integrity** — optional expected checksum (SHA-256/1/512, MD5) is verified
  automatically on completion and can be re-run from the UI or API.
- **Limits** — a token bucket per download plus a global one smooth bandwidth across
  all connections instead of letting one transfer hog the pipe.
- **Scheduler** — downloads can be restricted to a daily window; leaving the window
  pauses them (`pausedBy: schedule`) and re-entering resumes them.
- **Power** — with *shutdown when done* enabled, the machine is shut down 60 s after the
  last active download completes; a banner with a live countdown and a cancel button
  appears in the UI.

## Project layout

```
server.js          HTTP API + SSE + static UI (no dependencies)
lib/engine.js      segmented download engine, queue, scheduler, checksums
lib/httpget.js     redirect-following range-aware HTTP client
lib/bucket.js      token-bucket rate limiter
lib/patterns.js    batch URL pattern expander
lib/store.js       atomic JSON state persistence
public/            the web UI (vanilla JS, no build step)
extension/         Chrome/Edge MV3 connector
test/              self-contained test suites + benchmark
data/              runtime state (created on first run)
```

## Tests

Everything runs locally — no external network required.

```bash
npm test                 # engine + API/security suites (default)
npm run test:engine      # engine, patterns, store, resume, mirrors, checksums…
npm run test:api         # spawned server: REST, SSE, Host/Origin, traversal, limits
npm run test:integration # pause/resume, batch, no-Range fallback, speed limit
npm run test:local       # pause/resume stress against a controlled range server
npm run bench            # 1 vs 16 connections on a throttled local server
```

CI runs the full matrix (Windows + Linux, Node 18/20/22/24) on every push and PR.

## Notes

- The server binds to **127.0.0.1 only** — nothing is exposed to your network.
- Requires Node.js 18+ (tested on 24). No npm install, ever.
- State is written atomically (`state.json.tmp` + rename), so a crash won't corrupt
  your download list; active transfers resume on the next launch.
