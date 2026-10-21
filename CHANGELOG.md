# Changelog

All notable changes to downloadX are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [semantic versioning](https://semver.org/).

## [1.4.0] - 2026-10-22

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
