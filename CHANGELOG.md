# Changelog

All notable changes to downloadX are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [semantic versioning](https://semver.org/).

## [1.4.0] - 2026-10-22

### Fixed
- **The packaging manifests pointed at a stale EXE.** The SHA-256 in the winget
  and Chocolatey manifests was taken from an older build, so every install
  would have failed the checksum verification. `npm run check:release` now
  catches this.
- **The packaging manifests can now only be used from a public repository.**
  `winget` and Chocolatey download the EXE anonymously, which answers `404`
  for a release in a private repository. The README now says so.
- **A segmented download no longer re-fetches the same range over and over.**
  Node can emit several `data` events in one tick, so the byte counter was
  updated by concurrent handlers. Every download ended in a "short read" and
  retried the range: a single 6 MB file issued **2779** range requests before
  it finished. The chunks are now handled one after another — the same file
  now takes **63** requests and no short reads at all.
- **A transfer that ends without progress no longer loops forever.** A short
  read that delivered nothing is now counted as an error instead of being
  retried indefinitely.
- **An HLS playlist that changes its init section mid-way is assembled
  correctly.** The init section is now written right before the part that needs
  it instead of once in front of the file.
- Removing a download from the list no longer deletes its partial data unless
  the caller asks for it, and the orphaned DASH audio part is cleaned up.
- Launching downloadX while the first instance is still starting now says
  "already starting" instead of failing with an error.

### Added
- A dedicated keep-alive agent with a bounded socket pool, so the range
  requests of a file reuse their connections.
- The browser origin allowlist can now be pinned with `DLX_EXTENSION_IDS` or
  `extension.allowedIds`.
- `npm run build:extension` prepares the Chrome and Firefox packages.
- `npm run check:release` verifies that the winget and Chocolatey manifests
  match the version and the SHA-256 of the built EXE - a stale manifest would
  have broken every install.
- `test/e2e.test.mjs` starts the real app: a fresh install, a real download,
  a restart, a second instance and a clean shutdown (17 checks).
- `docs/ARCHITECTURE.md` and `docs/API.md` describe the code and the whole
  REST surface.
- The linter learned real static rules: no `var`, no loose equality, no
  `require()` inside a function, and warnings for oversized files.
- 151 new checks: unit tests for the small modules, a DOM-shim test for the
  web UI, engine tests for the queue, the history and the live feed, an FTP
  test for a data connection that dies, and tests for the origin rules.
- `test/extension-e2e.test.mjs` runs the **real extension code against the
  real server** (16 checks): the app is found on a non-default port, a
  browser download is grabbed and the file is byte-perfect, the file name and
  the context menu work, and a download is never lost when the app is down.

### Changed
- `lib/download.js` was split into `lib/download.js`, `lib/transfer.js` and
  `lib/stream.js`; `public/js/list.mjs` into `rows.mjs`, `details.mjs`,
  `segments.mjs` and `filter.mjs`. The moved code is byte-identical.
- The live feed sends far less data: segment tables are only sent for the
  working set, unchanged downloads are not rebuilt, and the UI only rewrites
  the rows that actually changed.

### Added
- **Global connection budget** (`maxConnections`, default 64, `0` = unlimited). Every
  socket — probes, segments, playlist parts — passes through one semaphore, so several
  parallel downloads can no longer exhaust the machine's sockets.
- **Configurable retry count** (`maxRetries`, default 12) before a download is marked
  as failed.
- **Free-space check** before a download starts: a transfer that cannot fit on the
  target volume fails immediately with a readable message instead of dying with
  `ENOSPC` half-way through. The Settings dialog shows the free space of the download
  volume.
- **`GET /api/free-space`** — free bytes on the volume that holds the download folder.
- **Keyboard shortcuts** in the web UI: `Ctrl+F` search, `Ctrl+N` new download,
  `Ctrl+K` focus the list, `Enter`/`Space` expand a row, `?` opens a shortcut list.
- **Extension port discovery** — when downloadX does not answer on the default port the
  extension scans `9765-9775` in parallel and remembers the working port.
- **`Alt+Shift+D`** toggles download interception in the browser extension.
- **`npm run lint`** — dependency-free hygiene checks (syntax, unresolved `require()`s,
  version consistency between `package.json`, the lock file and the extension manifest,
  dead files, stray debug statements).
- **`npm run test:ui`** — the web UI modules run against a small DOM shim, so the
  front-end has a regression net too.

### Fixed
- **AES-128 segments are no longer truncated.** The PKCS#7 padding was removed twice,
  which silently corrupted every HLS segment whose plaintext happened to end with a
  small byte value.
- **Pause and cancel are instant.** In-flight requests are aborted instead of waiting
  for their socket timeout — cancelling a stuck download used to take up to 30 seconds.
- **Resume is validated against the part file.** A `.dxpart` file that is shorter than
  the recorded progress (truncated or modified behind downloadX's back) now restarts
  the transfer instead of producing a corrupt file. Saved segment tables must also
  cover the file exactly — gaps and overlaps are rejected.
- The User-Agent, the UI footer, the installer and the lock file no longer drift away
  from the version in `package.json`.
- Back-off delays are jittered, so many failed downloads no longer retry in lockstep.
- Duplicate mirror URLs are removed before a download is created.
- The live SSE feed shrinks automatically when the download list grows very large,
  instead of pushing megabytes to every connected browser.
- The API test suite no longer crashes libuv on Windows when it tears down an aborted
  event stream.

### Changed
- The engine was split into focused modules (`lib/download.js`, `lib/naming.js`,
  `lib/categories.js`, `lib/settings.js`, `lib/util.js`, `lib/version.js`). The public
  API of `lib/engine.js` is unchanged.
- The web UI was split into native ES modules under `public/js/` (no build step).
  `public/app.js` became `public/app.mjs` and is loaded with
  `<script type="module">`.
- Static assets are served with `Cache-Control: no-cache` so an upgraded copy of
  downloadX never serves stale JavaScript.
- `DLX_DEBUG=1` now logs every HTTP request with its status code and duration.
