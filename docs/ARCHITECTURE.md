# downloadX architecture

A map of the codebase: what each part owns, how the pieces talk to each other
and where to extend things. The [README](../README.md) covers how to use the
app, this document covers how it is built.

---

## 1. Processes

downloadX is a **local** application. It never talks to a cloud service; the
only outbound connections are the downloads themselves.

| Process | Started by | Purpose |
|---|---|---|
| `server.js` | `start.bat`, `install.bat`, `downloadX.exe` | The local web server: REST API, SSE feed, static UI |
| `lib/protocol.js` | the `downloadx://` handler | Adds a URL to a running instance, or starts one |
| `native/host.cs` | the browser extension | Native-messaging bridge so the extension can start the app |
| `extension/` | the browser | MV3 connector for Chrome/Edge/Firefox |

The server binds `127.0.0.1` only. A **single instance** may own a data
directory at a time; `lib/instance.js` implements that lock.

---

## 2. Module map

```
server.js            HTTP server: routing, static files, SSE, CORS, security headers
lib/
  engine.js          queue, scheduling, persistence, connection budget, snapshots
  download.js        one download: state, segments, worker loop, lifecycle
  transfer.js        HTTP range transfer: probe, connection slots, byte pump
  stream.js          HLS / DASH capture: playlists, parts, AES-128
  retry.js           shared retry policy: transient statuses, Retry-After, back-off
  hostgate.js        per-origin cooldown after 429/503 responses
  httpget.js         HTTP client: redirects, ranges, proxies, Basic/Digest auth
  ftp.js             FTP / FTPS client with the same contract as httpget
  streams.js         playlist parsing, AES-128 helpers, part fetching
  agents.js          shared keep-alive agents (bounded socket pool)
  bucket.js          token bucket rate limiter
  naming.js          file names, hashes, header sanitising
  categories.js      category tables and MIME/extension detection
  settings.js        settings defaults, validation, clamping
  patterns.js        batch URL pattern expander
  store.js           atomic JSON persistence
  instance.js        single-instance lock, port file
  protocol.js        downloadx:// handler
  util.js            shared helpers (paths, back-off, free space)
  version.js         the single source of truth for the version
public/
  app.mjs            entry point
  js/                UI modules (native ES modules, no build step)
  index.html         markup
  style.css          styles (dark red/black theme)
extension/           browser connector (background, content script, options)
installer/           Windows installer, CRX3 builder, EXE builder
scripts/lint.mjs     dependency-free project hygiene checks
test/                the test suites
```

### The layering rule

```
server.js  ->  lib/engine.js  ->  lib/download.js  ->  lib/transfer.js
                                                      lib/stream.js
                                   ->  lib/httpget.js / lib/ftp.js
```

Nothing below `lib/engine.js` knows about HTTP routes, and nothing in
`lib/` knows about the UI. `lib/download.js` mixes two mixins into its
prototype (`transfer.js` and `stream.js`); their methods are copied with
`Object.getOwnPropertyDescriptors`, so they behave exactly like the methods
defined in the class.

---

## 3. The life of a download

```
                    ┌──────────┐
   POST /api/downloads         │
            │                  │
            ▼                  │
      ┌───────────┐             │
      │  queued   │◄──────┐     │
      └─────┬─────┘       │     │
            │             │     │  pause / schedule window
            ▼             │     │
      ┌───────────┐       │     │
      │  probing  │───────┼─────┘
      └─────┬─────┘       │     │
            │             │     │
            ▼             │     │
      ┌───────────┐       │     │
      │downloading│───────┘     │
      └─────┬─────┘             │
            │                   │
     ┌──────┴───────┐           │
     ▼              ▼           ▼
 ┌──────────┐  ┌─────────┐  ┌─────────┐
 │completed │  │ failed  │  │ canceled │
 └──────────┘  └─────────┘  └─────────┘
```

* **probing** — a `Range: bytes=0-0` request discovers the final URL, the
  size, `ETag`/`Last-Modified`, the file name and whether the server supports
  ranges at all. Mirrors are probed in order.
* **downloading** — the file is split into segments; workers claim the
  segment with the most bytes left and fetch it in 8 MB chunks.
* **completed** — the part file is promoted to its final name without ever
  overwriting an existing file, then the optional checksum is verified.

### Segment table

A download owns a table of segments:

```js
{ start: 0,        end: 1048575,   downloaded: 1048576 }   // done
{ start: 1048576,  end: 2097151,   downloaded: 524288   }   // in flight
```

The table must cover the file **exactly**: no gaps, no overlaps. That is
checked by `_segmentsValid()` before a resume is allowed, and the `.dxpart`
file must still be large enough for the recorded progress. If either is not
true the transfer restarts from zero instead of producing a corrupt file.

---

## 4. Data flow

```
   browser UI                    extension
       │  fetch()                     │  fetch() / native host
       ▼                              ▼
  ┌──────────────────────────────────────────┐
  │  server.js  (REST + SSE)                │
  └───────────────┬──────────────────────────┘
                  │  engine.add() / engine.remove() / settings
                  ▼
            ┌───────────┐        ┌──────────────┐
            │  engine   │───────▶│ data/state.json│
            └─────┬─────┘        └──────────────┘
                  │  start() / pause() / resume()
                  ▼
            ┌───────────┐
            │ download  │──▶ transfer.js ──▶ httpget.js ──▶ origin server
            └───────────┘──▶ stream.js   ──▶ streams.js
                  │
                  ▼
          <dest>/<category>/<name>.dxpart ──▶ <name>
```

The UI never polls: it opens `/api/events` and receives a `snapshot` event
whenever the engine changed something. Snapshots are throttled to ~700 ms and
shrink automatically when the history grows large.

---

## 5. Concurrency and limits

| Knob | Where | Default | Meaning |
|---|---|---|---|
| `maxConcurrent` | settings | 3 | Downloads running at the same time |
| `maxConnections` | settings | 64 | Open sockets across the whole app |
| `defaultSegments` | settings | 16 | Connections per file |
| `globalSpeedLimit` | settings | 0 | Bytes/s for everything (0 = unlimited) |
| `maxRetries` | settings | 12 | Consecutive errors before a download fails |

Two token buckets smooth the bandwidth: one global, one per download. The
connection budget is a semaphore inside the engine: every socket (probe,
range request, playlist part) holds a slot for the whole transfer. The shared
agents get the same numeric cap (0 = unlimited) so the HTTP pool cannot
throttle a larger budget on its own.

Transient failures are retried with exponential back-off and jitter for
idempotent GETs: 408, 421, 425, 429, 500, 502, 503 and 504. A `Retry-After`
header is honoured, and 429/503 additionally put the whole origin on a shared
cooldown (`lib/hostgate.js`) so the other workers stop hammering it. Permanent
4xx responses, TLS failures and disk errors are never retried.

The scheduler runs on the engine ticker. It applies the global window, each
download's own window and weekday list, the dependency graph (`dependsOn`,
with loop detection) and the rolling hourly quota (`hourlyQuota`). A blocked
child exposes `blockedBy`; a paused item exposes `pausedBy` (`user`,
`schedule`, `quota`, …). The snapshot includes `scheduleHalted`, `quotaHalted`,
`quotaUsed`, `quotaLimit` and `quotaResetIn` so the UI can explain why the
queue is waiting.

---

## 6. State on disk

`<data dir>/state.json` is written atomically (temp file + rename) about
every 1.5 s and on shutdown:

```json
{
  "version": 2,
  "savedAt": 1700000000000,
  "settings": { "rootDir": "C:\\Users\\you\\Downloads", "maxConcurrent": 3 },
  "items": [
    {
      "id": "…", "urls": ["https://…"], "filename": "big.iso",
      "status": "downloading", "total": 1234567,
      "segments": [{ "start": 0, "end": 617283, "downloaded": 617284 }],
      "etag": "\"abc\"", "speedLimit": 0, "priority": 0,
      "schedule": { "windowStart": "01:00", "windowEnd": "06:00",
                    "days": [1, 3, 5], "speedLimit": 0 },
      "dependsOn": null
    }
  ]
}
```

Partial data lives next to the final file as `<name>.<id>.dxpart` and is
removed when the download completes.

---

## 7. Security model

The server is local-only and hardened against pages in the browser:

* binds `127.0.0.1` and rejects a `Host` header that is not loopback;
* CORS is limited to loopback origins and browser-extension origins;
* static files are contained with `path.relative` (no `..` escape);
* JSON bodies are capped at 1 MB and must be `application/json`;
* the UI ships a strict Content-Security-Policy;
* file names, categories, headers and settings are sanitised and clamped;
* the engine drops settings keys it does not know.

---

## 8. Extension points

| I want to… | Touch |
|---|---|
| add a protocol | `lib/httpget.js` (mirror the `request()` contract of `lib/ftp.js`) |
| add a category | `lib/categories.js` |
| add a setting | `lib/settings.js` (defaults + clamping) **and** the allow-list in `server.js` |
| change the transfer | `lib/transfer.js` |
| change the UI | `public/js/*.mjs` (native ES modules, no build) |
| change the browser behaviour | `extension/background.js` |
| add a test | `test/*.test.mjs` (see `test/units.test.mjs` for the pattern) |

---

## 9. Tests

| Suite | Covers |
|---|---|
| `test/self-test.mjs` | engine: segmented downloads, resume, mirrors, checksums, limits, queue |
| `test/units.test.mjs` | the small pure modules: patterns, lock, protocol, bucket, store, categories |
| `test/api.test.mjs` | REST API, SSE, security headers, path traversal |
| `test/net.test.mjs` | proxies (HTTP/CONNECT/SOCKS5), Basic/Digest auth, custom headers |
| `test/streams.test.mjs` | HLS/DASH: AES-128, fMP4, byte ranges, resume |
| `test/ftp.test.mjs` | FTP/FTPS: REST offsets, PASV/EPSV, authentication |
| `test/extension.test.mjs` | the browser connector against a mocked extension API |
| `test/ui.test.mjs` | the UI modules against a small DOM shim |
| `test/installer.test.mjs` | CRX3 signing, extension builds, installer dry-run/sandbox |
| `test/chrome-grab.test.mjs` | a real Chromium attachment grab (optional, needs a browser) |

Everything except the optional Chrome grab runs locally: no network access and
no browser required.
