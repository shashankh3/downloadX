# downloadX ⚡

A fast, modern, **zero-dependency** download manager for Windows (works anywhere Node.js runs).
No ads, no nags — run it portably with one command, or use the Windows installer for an
IDM-style setup with shortcuts, autostart and automatic browser integration.

```
node server.js        →  http://127.0.0.1:9765
```

Double-click **`start.bat`** for the portable version, or **`install.bat`** for the full
Windows installation. Downloads run over **HTTP, HTTPS, FTP and FTPS** with the same
multi-connection engine, and **HLS / DASH** media playlists are captured into a single
playable file (TS/fMP4, AES-128 decryption included).

---

## Why it's better than IDM / Ghost Downloader / the rest

| Feature | downloadX | IDM | Ghost Downloader | Free download managers |
|---|---|---|---|---|
| Multi-connection segmented engine | ✅ up to **64** connections, dynamic splitting | ✅ 32 | ✅ | ✅ (usually 8–16) |
| Global connection budget | ✅ one cap for the whole app | ❌ | ❌ | ❌ |
| Protocols | ✅ HTTP/HTTPS + **FTP/FTPS** (multi-connection via REST) | ✅ HTTP/FTP | ✅ HTTP | mixed |
| **HLS / DASH** media capture | ✅ playlists → one file, AES-128, fMP4, byte ranges | partial | ❌ | rare |
| **Live per-segment progress** visualization | ✅ every connection shown in real time | ❌ | ❌ | ❌ |
| Pause / resume across app restarts | ✅ validated with `If-Range` (ETag or Last-Modified), part file re-validated | ✅ | ✅ | mixed |
| Auto-retry with exponential backoff + `Retry-After` | ✅ with jitter, configurable retry count | basic | basic | mixed |
| **Mirror URLs** — failover per request | ✅ | ❌ | ❌ | rare |
| Sequential batch patterns `file[01-99].zip` | ✅ built-in (ranges, steps, lists, letters, cartesian) | ❌ | ❌ | ❌ |
| Checksum verification (SHA-256/1/512, MD5) | ✅ auto-verify + on-demand | ❌ | ❌ | rare |
| Per-download **and** global speed limits | ✅ | global only | ✅ | mixed |
| Category auto-sort into folders | ✅ | ✅ | ✅ | ✅ |
| Scheduler window (e.g. only 23:00–07:00) | ✅ | ✅ | ❌ | rare |
| Shutdown PC when queue empties | ✅ with cancel countdown | ✅ | ❌ | rare |
| Browser integration | ✅ Chrome/Edge/Firefox MV3 extension + installer auto-setup | ✅ | ✅ | mixed |
| **Full REST API** + SSE live feed | ✅ script anything | ❌ | ❌ | aria2 only |
| Referer / cookies for picky sites | ✅ | ✅ | ❌ | mixed |
| Custom headers + **Basic/Digest auth** | ✅ per download | ✅ | ❌ | rare |
| Proxy support (HTTP/HTTPS/SOCKS5, per download) | ✅ | ✅ | ❌ | rare |
| Media sniffing + floating page button | ✅ extension | ✅ | ❌ | ❌ |
| Smart capture rules + site exclusions | ✅ | basic | ❌ | ❌ |
| Free space check before a download starts | ✅ | ❌ | ❌ | ❌ |
| Price | **free forever** | $25 + nags | free w/ limits | free w/ ads |
| Portable | ✅ single folder, zero deps, state in `/data` | ❌ installer | ❌ installer | mixed |

## Quick start

**Portable** (just the app, keep everything in this folder):

```bat
start.bat          (or:  node server.js)
```

**Windows installer** (per-user, no admin prompt):

```bat
install.bat
```

The installer copies the app to `%LOCALAPPDATA%\Programs\downloadX`, adds Start Menu and
Desktop shortcuts, starts downloadX at login, registers the `downloadx://` protocol,
installs the native-messaging helper and prepares the browser extension(s). It also picks
the first free local port in `9765-9775` and pins every shortcut, browser policy and the
native host to it, so a busy port never breaks updates or browser integration. The protocol
accepts `downloadx://add?url=https%3A%2F%2Fexample.com%2Ffile.zip` and `downloadx://open`. Use
`install.bat -AllUsers` from an elevated prompt for a machine-wide install, or
`install.bat -DryRun` to see exactly what it would do. Uninstall from Apps & features or
`uninstall.bat`; your download history is kept unless you choose to delete it.

**Standalone EXE** (no Node.js installed at all — single portable file):

```bat
npm run build:exe      (produces dist\downloadX.exe, ~89 MB)
```

Copy `downloadX.exe` anywhere and double-click it. The UI opens automatically at
**http://127.0.0.1:9765**; state lives in a `data\` folder created next to the EXE and the
browser extension is unpacked to `extension\` beside it, so the whole thing stays portable.
The same environment variables work (`DLX_PORT`, `DLX_DATA_DIR`, `DLX_EXT_DIR`, `DLX_OPEN=1`
is implied for the EXE, set `DLX_NO_OPEN=1` to suppress it).

The UI opens at **http://127.0.0.1:9765**. Files land in your `Downloads` folder,
sorted into `Programs / Compressed / Video / Music / Documents / Images` (configurable).

Paste a URL anywhere on the page (Ctrl+V), or drop a link onto the window, to open the
Add dialog pre-filled. The interface ships in **English and German** — pick the
language in the settings, it is remembered by the browser. The interface ships with a
clean light theme by default; the moon/sun button in the sidebar footer switches to a
dark theme with a Driver Booster-style navy-and-blue look, and your choice is
remembered.

Keyboard shortcuts: `Ctrl+F` search, `Ctrl+N` new download, `Ctrl+K` focus the list,
`Enter`/`Space` expand a row, `?` shows the full list, `Esc` closes a dialog.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DLX_PORT` | `9765` | HTTP port (if unset, the next free port is tried automatically) |
| `DLX_HOST` | `127.0.0.1` | Bind address |
| `DLX_DATA_DIR` | `./data` | Where `state.json` lives |
| `DLX_DEBUG` | unset | Log every HTTP range request |
| `DLX_OPEN` | unset | Set to `1` to open the UI in your browser once the server is listening |
| `DLX_EXT_DIR` | `./extension` | Folder served at `/ext/updates.xml` and `/ext/downloadx.crx` |
| `DLX_EXT_CONFIG` | `./installer/config.json` | Extension mode / store IDs for the in-app install button |
| `DLX_EXTENSION_IDS` | unset | Comma separated browser-extension ids that may call the API |
| `DLX_NO_OPEN` | unset | Set to `1` to stop the server from launching Explorer/browsers |

### Which pages may reach the API

The server is local-only, so the only interesting question is what a page in
your browser may do with it:

- **loopback origins** (the UI itself) are always allowed;
- **browser-extension origins** are allowed, because the downloadX connector
  needs them;
- **everything else** is rejected.

If you want to pin the connector to one id, set `DLX_EXTENSION_IDS` or list it
in `installer/config.json` under `extension.allowedIds`. Without a list every
extension origin is accepted, because an extension loaded unpacked gets an id
that depends on the folder it lives in and therefore cannot be pinned ahead of
time.

## Browser extension (Chrome / Edge / Brave / Firefox)

The extension adds the classic download-manager workflow: right-click a link, video,
audio, image or selected URL → **Download with downloadX**. Just like IDM, **automatic
interception is on by default**: every download started by the browser is taken over by
downloadX (browser entry cancelled and cleaned up), including `ftp://` links. Click the
toolbar icon to toggle interception off/on. The badge shows `ON`, `✓` on success and `!`
when the local server is unreachable.

Interception is safe by design: the browser download is only cancelled **after** downloadX
has accepted it (REST API, or the native host starts the app when it isn't running). Cookies
for the source site are forwarded, like IDM does for picky sites. If downloadX can't be
reached the browser download proceeds untouched and the extension backs off for 20 s, so a
download is never lost.

**Media sniffer** — the extension watches responses for HLS (`m3u8`), DASH (`mpd`) and
progressive video/audio, and shows a small **downloadX** floating button on pages that have
captured media. The panel lists each stream with its type and size; one click sends it to
the app (playlists are handed to the HLS/DASH engine, not downloaded as text). A chip also
appears when you copy a downloadable link. Both features can be turned off.

**Smart rules** (extension options): minimum media size, excluded sites (`example.com`,
`*.bank.example`) and file-type exclusions. `interceptMinSize`/site rules apply to automatic
browser download catching too. Open the options from the extension's Details page or the
panel's **Settings** button.

The Windows installer builds both variants and registers the native-messaging host
(`com.downloadx.host`) so the extension can even start downloadX when it is not running.
There are three modes, chosen automatically by `install.bat`:

- **Store mode** — put your Chrome Web Store / Edge Add-ons IDs in `installer/config.json`
  (or pass `-ChromeStoreId` / `-EdgeStoreId`). The installer writes the
  `ExtensionInstallForcelist` policy, so the extension installs silently on the next
  browser start. This is the same mechanism IDM uses: a store listing plus an enterprise
  policy. Store mode is the only way to get true silent install on normal PCs.
- **Self-hosted mode** (`-ExtensionMode selfhosted`) — the installer generates an RSA key,
  builds a signed CRX3 package, serves it from `/ext/updates.xml` and points the policy at
  it. Chrome and Edge only honour off-store force-install on **domain-joined** Windows;
  everywhere else the installer falls back to manual mode.
- **Manual mode** (the default when no store IDs are configured) — the extension is built
  into `<install-dir>\extension\chrome`. Load it once via `chrome://extensions` →
  Developer mode → **Load unpacked** → select `extension\chrome`. The Settings dialog has
  an **Install browser extension** button that opens the right folder for you.

The extension also finds downloadX on its own: if the default port does not answer it
scans the range the installer uses (`9765-9775`) in parallel and remembers the working
port. `Alt+Shift+D` toggles interception without touching the mouse.

Firefox: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`extension\firefox\manifest.json`. Automatic install requires an AMO listing — set
`firefoxInstallUrl` in `installer/config.json` and the installer writes the Firefox
`ExtensionSettings` policy (release Firefox refuses unsigned local XPIs).

Portable users can load the unpacked `extension` folder without the installer; HTTP
works on its own. If you run downloadX on a non-default port, the extension learns it
automatically through the native host when available; otherwise set `apiBase` in the
extension's storage (`chrome.storage.local`) to e.g. `http://127.0.0.1:9766`.

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

The complete reference lives in **[docs/API.md](docs/API.md)**. The most used
calls:

```bash
# add a download (16 connections, referer for hotlink-protected sites)
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/file.zip","segments":16,"referer":"https://example.com/page"}'

# mirrors + expected checksum
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://a.example/file.zip","mirrors":["https://b.example/file.zip"],"expectedChecksum":"<sha256>"}'

# auth, custom headers and a per-download proxy
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/private.iso","username":"u","password":"p",
       "headers":{"Accept-Language":"en-US"},"proxy":"socks5://127.0.0.1:1080"}'

# HLS or DASH playlist — downloaded as a single .ts/.mp4 file
curl -X POST http://127.0.0.1:9765/api/downloads \
  -H "Content-Type: application/json" -d '{"url":"https://cdn.example/live/master.m3u8"}'

curl http://127.0.0.1:9765/api/health                      # version, pid, uptime
curl http://127.0.0.1:9765/api/state                       # full snapshot
curl http://127.0.0.1:9765/api/free-space                  # free bytes on the download volume
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
curl http://127.0.0.1:9765/api/update-check                 # optional update manifest
```

`POST /api/downloads` accepts `url`, `urls`, or `text` (pattern-expanded), plus
`filename`, `category`, `segments`, `speedLimitKBs`, `mirrors`, `referer`, `cookies`,
`headers` (object), `username`, `password`, `proxy`, `dir`, `expectedChecksum`,
`checksumAlgo`, `priority` and `startedPaused`. Multi-URL requests create one download
per URL and ignore `filename`. Mirrors are de-duplicated against the primary URL.

`GET /api/update-check` is unconfigured by default. Set `updateUrl` in settings to an
HTTPS JSON manifest such as `{"version":"1.4.0","url":"https://…/downloadX.exe","notes":"…"}`;
the UI shows a dismissible banner when the manifest advertises a newer version. Results are
cached for 6 h and the check honours the global proxy/TLS settings.

### Security model

The server is local-only and hardened against drive-by attacks from websites:

- binds `127.0.0.1` by default and rejects requests whose `Host` header is not loopback;
- CORS is allowlisted to loopback origins and browser-extension origins — other sites
  cannot read responses or issue cross-origin writes;
- static files are contained with `path.relative` (no `..` escape, encoded or not);
- JSON bodies are capped at 1 MB and must use `Content-Type: application/json`;
- category and filename inputs are sanitized (Windows reserved names, path separators,
  control characters);
- the UI ships a strict CSP and the API responses carry `nosniff` / `DENY` headers;
- **address guard**: the URL you ask for may live in your private network (a NAS at
  home), but a redirect, a playlist part or a scraped link that points at `127.0.0.1`, a
  LAN address or the cloud metadata address (`169.254.169.254`) is refused - a hostile
  page cannot use downloadX to reach into your network. The FTP client keeps the data
  connection on the host of the control connection (no PASV bounce). Set
  `allowPrivateNetworks` in the settings to turn the protection off.

## How the engine works

- **Probe** — a `Range: bytes=0-0` GET discovers the final URL (redirects), size,
  ETag / Last-Modified, filename (`Content-Disposition`) and whether the server supports
  ranges at all. Mirrors are probed in order until one works.
- **Segments** — the file is split across up to 64 ranges. Workers claim the segment
  with the most bytes left and fetch it in 8 MB chunks with positioned writes into a
  pre-allocated `.dxpart` file. When a segment gets ahead, the largest remaining one
  is **split dynamically**, so slow servers never strand a single long tail connection.
- **Connection budget** — every socket (probes, segments, playlist parts) passes through
  one global semaphore. `maxConnections` (default 64, `0` = unlimited) caps the number of
  connections the whole app may open, so three parallel downloads can no longer open
  192 sockets at once.
- **Resume** — segment progress persists every ~1.5 s to `data/state.json`. On resume
  each range continues exactly where it stopped, validated with `If-Range`; if the file
  changed server-side the download auto-restarts instead of corrupting. The saved
  segment table must cover the file exactly (no gaps, no overlaps) and the `.dxpart`
  file must still be large enough for the recorded progress — otherwise the transfer
  restarts from zero instead of writing a corrupt file.
- **Disk space** — before a download starts, the free space on the target volume is
  compared with the remaining size; a download that cannot possibly fit fails
  immediately with a clear message instead of dying half-way with `ENOSPC`.
- **Robustness** — per-segment retries with exponential back-off (jittered, so many
  downloads do not retry in lockstep) and `Retry-After` support, mirror rotation on
  4xx/5xx, wrong-range and overshoot clamping, early-close detection, unknown-size
  (chunked) single-stream handling, fatal disk errors (`ENOSPC`, `EDQUOT`, …) surfaced
  immediately, and a fallback to a single streaming connection for range-less servers.
  The retry count before a download is marked as failed is configurable
  (`maxRetries`, default 12).
- **FTP / FTPS** — the same engine drives FTP servers: `SIZE`/`MDTM`/`REST` probe the
  file, each segment resumes with a byte offset, `PASV`/`EPSV` data channels with a
  private-IP fallback, anonymous or user/password login, and `ftps://` (explicit TLS).
  Servers without `REST STREAM` gracefully fall back to a single connection. FTP also
  works with mirrors, schedulers, speed limits and every other feature.
- **HLS / DASH** — playlists are parsed into a part list and fetched sequentially into a
  `.dxpart`, then renamed to `.ts` or `.mp4`. HLS supports master variants (highest
  bandwidth wins), media sequences, `EXT-X-MAP` init sections, `EXT-X-BYTERANGE`, and
  AES-128 decryption (explicit or sequence-derived IV). DASH supports `SegmentTemplate`
  (`$Number$`, `$Time$`, `SegmentTimeline`), `SegmentList`, `SegmentBase` and BaseURL
  chains; video is saved as the main file and audio as `<name>.audio.m4a`. Part progress
  is persisted, so pausing/restarting a stream resumes at the last completed part.
- **Network** — HTTP forward proxies, HTTPS `CONNECT` tunnels and SOCKS5 (with auth);
  Basic and Digest authentication (MD5/SHA-256/SHA-512-256, `qop=auth`); custom headers
  per download; optional invalid-TLS bypass. Proxy/auth settings are applied to probes,
  segments, retries, redirects and HLS/DASH part requests.
- **Categories** — IDM-typical type coverage for `Programs / Compressed / Video / Music /
  Documents / Images` (installers, APKs, disk images, raw camera files, e-books, subtitle
  formats, modern archives like `zst`, `7z`, `rar`, …) with a MIME fallback when the
  filename says nothing.
- **Integrity** — optional expected checksum (SHA-256/1/512, MD5) is verified
  automatically on completion and can be re-run from the UI or API.
- **Limits** — a token bucket per download plus a global one smooth bandwidth across
  all connections instead of letting one transfer hog the pipe.
- **Scheduler** — downloads can be restricted to a daily window; leaving the window
  pauses them (`pausedBy: schedule`) and re-entering resumes them.
- **Power** — with *shutdown when done* enabled, the machine is shut down 60 s after the
  last active download completes; a banner with a live countdown and a cancel button
  appears in the UI.
- **Notifications** — completed/failed downloads raise an in-app toast plus an optional
  desktop notification and two-tone chime (both toggleable in Settings; browser permission
  is requested on first enable). The UI is keyboard accessible (skip link, focus rings,
  Enter/Space row expansion, ARIA labels and live regions) and respects
  `prefers-reduced-motion`.

## Project layout

```
server.js          HTTP API + SSE + static UI (no dependencies)
docs/ARCHITECTURE.md   how the code is put together
docs/API.md            the complete REST reference
lib/engine.js      queue, scheduling, persistence, connection budget
lib/download.js    one download: probe → segment → transfer → verify → finalize
lib/httpget.js     redirect-following range-aware HTTP client (proxy, Basic/Digest)
lib/ftp.js         FTP/FTPS client (REST offsets, PASV/EPSV, TLS) with the same contract
lib/streams.js     HLS/DASH playlist parsing, AES-128, part fetching helpers
lib/bucket.js      token-bucket rate limiter
lib/patterns.js    batch URL pattern expander
lib/naming.js      file-name and checksum helpers
lib/categories.js  category tables and MIME/extension detection
lib/settings.js    settings defaults, validation and clamping
lib/util.js        small shared helpers (paths, back-off, free space)
lib/store.js       atomic JSON state persistence
lib/instance.js    single-instance lock + port-file helpers
lib/protocol.js    downloadx:// protocol handler
lib/version.js     single source of truth for the version string
public/            the web UI (vanilla ES modules, no build step)
public/js/         UI modules: state, rendering, dialogs, API client, helpers
extension/         Chrome/Edge/Firefox MV3 connector (background, content UI, options)
installer/         Windows installer, CRX3 builder, extension preparation
installer/build-exe.mjs  standalone EXE builder (pkg + icon/version resources + signing)
installer/make-packages.mjs  winget + Chocolatey manifests with the real SHA-256
packaging/         generated winget/choco manifests (npm run package:manifests)
scripts/lint.mjs   dependency-free project hygiene checks (npm run lint)
native/host.cs     native messaging host (compiled by the installer)
test/              self-contained test suites + benchmark
data/              runtime state (created on first run)
dist/              build output: downloadX.exe, downloadX.ico (npm run build:exe)
```

## Tests

Everything runs locally — no external network required.

```bash
npm test                 # engine + API + network + streams + FTP + extension + UI + e2e
npm run lint             # dependency-free hygiene checks (syntax, versions, dead files)
npm run check            # lint + every test suite
npm run check:release    # the packaging manifests match the version and the built EXE
npm run test:engine      # engine, patterns, store, resume, mirrors, checksums…
npm run test:units       # the small modules: patterns, lock, protocol, bucket, store
npm run test:api         # spawned server: REST, SSE, Host/Origin, traversal, update check
npm run test:net         # HTTP/SOCKS5 proxies, Basic/Digest auth, custom headers
npm run test:streams     # local HLS/DASH servers: AES-128, fMP4, byte ranges, resume
npm run test:ftp         # local FTP server: ranged REST transfers, auth, fallbacks
npm run test:extension   # connector + sniffer + rules + content/options files (mocked)
npm run test:ui          # web UI modules against a DOM shim (rendering, filters, ids)
npm run test:e2e         # a fresh app, a real download, a restart, a second instance
npm run test:integration # pause/resume, batch, no-Range fallback, speed limit
npm run test:local       # pause/resume stress against a controlled range server
npm run test:installer   # CRX3 signing, ZIP, extension builds, installer dry-run/sandbox
npm run bench            # 1 vs 16 connections on a throttled local server
```

### Releasing

```bash
npm run build:exe        # dist/downloadX.exe
npm run package:manifests # winget + chocolatey, with the real SHA-256
npm run check:release    # fails if the manifests drifted from the built EXE
gh release create v1.4.0 dist/downloadX.exe --notes-file CHANGELOG.md
```

`npm run check:release` compares the checksum in the winget and Chocolatey
manifests with the EXE that was just built, so a stale manifest can never
silently break an install. It also checks that the version is the same in
`package.json`, the lock file, the extension manifest and the packaging
files.

> **The release asset must be publicly downloadable.** `winget` and
> Chocolatey fetch the `InstallerUrl` anonymously, so a release in a **private**
> repository answers `404` and the install fails. Make the repository public
> (or host the EXE somewhere publicly reachable and point the manifests
> there) before submitting the manifests to winget-pkgs.

CI runs the full matrix (Windows + Linux, Node 18/20/22/24) on every push and PR.

## Notes

- The server binds to **127.0.0.1 only** — nothing is exposed to your network.
- Only one server may own a data directory at a time. Launching downloadX again (shortcut,
  `start.bat`, or the protocol handler) reuses the running instance and just opens the UI,
  so state and active transfers are never written by two processes.
- Requires Node.js 18+ (tested on 24). No npm install, ever. The installer checks for
  Node and can install the LTS release with `install.bat -InstallNode` (winget). The
  standalone `dist\downloadX.exe` (`npm run build:exe`) needs nothing installed — it
  bundles its own runtime.
- True silent extension install on stock (non-domain) Chrome/Edge requires published store
  IDs; that is a browser platform restriction, not a downloadX limitation. Without them,
  the installer prepares everything and you load the extension once manually.
- The extension requests the `cookies` permission only to pass site cookies to the local
  downloadX server (never anywhere else), matching IDM's behavior on cookie-protected links.
- State is written atomically (`state.json.tmp` + rename), so a crash won't corrupt
  your download list; active transfers resume on the next launch.
- Release packaging: `npm run build:exe` then `npm run package:manifests` writes the
  winget manifest tree (`packaging/winget/manifests/…`) and the Chocolatey package with
  the built EXE's real SHA-256. Code signing is env-gated in the EXE build —
  `DLX_SIGN_CERT` + `DLX_SIGN_PASSWORD` (PFX) or `DLX_SIGN_THUMBPRINT` (+ optional
  `DLX_SIGN_STORE`, `DLX_SIGNTOOL`, `DLX_SIGN_TIMESTAMP`); unsigned builds still succeed.

## License

MIT — see [LICENSE](LICENSE).
