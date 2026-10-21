# Autonomous Improvement Backlog
Last Updated: 2026-10-21T23:45:00Z

Project: downloadX (zero-dependency Node.js download manager)
Branch: `overnight-auto-improve` (never touch `main`)
Verify: `npm run lint` (lint + syntax) and `npm test` (8 suites) must be green before every commit.

## Pending Tasks
- [ ] [Track E] Split `public/js/list.mjs` (457 lines) into `rows.mjs`, `details.mjs`, `segments.mjs`
- [ ] [Track E] Extract the duplicated `dispatchKeyEvent`/`Command` shims in the extension test helpers
- [ ] [Track E] Split `extension/background.js` (480 lines) - move the media sniffer into its own module
- [ ] [Track F] Add `docs/ARCHITECTURE.md` (module map, data flow, extension points)
- [ ] [Track F] Add `docs/API.md` with the complete REST reference
- [ ] [Track F] Add JSDoc type annotations to the public functions of `lib/*`
- [ ] [Track A] Reject `chrome-extension://` origins that are not the installed extension id
- [ ] [Track A] `lib/streams.js`: an `EXT-X-MAP` change in the middle of a playlist is ignored
- [ ] [Track A] `lib/ftp.js`: the control channel parser can mis-associate multi-line replies
- [ ] [Track B] Test the FTP client when the data connection dies in the middle of a transfer
- [ ] [Track B] Test that the live snapshot stays small with a long history
- [ ] [Track C] Add a `jsconfig.json` so editors type-check the JavaScript without a build step
- [ ] [Track D] Only recompute the speed of active downloads in the engine tick
- [ ] [Track D] Cache the snapshot of finished downloads instead of rebuilding them every frame
- [ ] [Track E] Add a `npm run build:extension` script that prepares the browser packages

## In Progress
- None

## Completed
- [x] [Track A] Guard `_pump()` against a data chunk arriving after the transfer was settled — root cause was Node emitting several `data` events per tick; chunk handling is now serialised through a promise chain. Range requests for one segmented download dropped from 2779 to 63, short reads from hundreds to 0.
- [x] [Track A] Fix `remove()` deleting the `.dxpart` file even when `deleteFiles` was not requested — removing a list entry no longer touches the disk; the UI asks for `?file=1` explicitly. Orphaned `.audio.m4a` parts are now cleaned up as well.
- [x] [Track B] Unit tests for patterns/instance/protocol/bucket/store/categories/util edge cases — new `test/units.test.mjs` with 62 checks; `lib/protocol.js` was refactored to export `parseCommand()` and only auto-run when invoked directly.
- [x] [Track A] A second instance launch reported a hard error while the first was still starting — the lock now reports "already starting" instead of throwing.
- [x] [Track C] Extend the linter with real static rules — now forbids `var`, loose equality and `require()` inside functions, and warns about oversized files/functions. Comments, strings and regex literals are stripped before scanning, so there are no false positives.
- [x] [Track D] Skip DOM work for unchanged rows and shrink the live snapshot — the engine only ships segment tables for the working set, and rows are only rewritten when their data changed.
- [x] [Track D] Reuse HTTP connections via a dedicated keep-alive agent — new `lib/agents.js` with a bounded socket pool; the probe now drains its one-byte body so the socket returns to the pool instead of being torn down.
- [x] [Track E] Split `lib/download.js` (1202 lines) — the HTTP range transfer and the HLS/DASH capture now live in `lib/transfer.js` and `lib/stream.js` and are mixed into the class. The moved methods are byte-identical to the original; the file is down to 705 lines.
- [x] [Track B] Engine tests for priority ordering, the history cap and `clearFinished(deleteFiles=true)` — 7 new checks in the self-test.
- [x] [Track E] Split `public/js/list.mjs` (457 lines) — the rows, the details panel, the segment bars and the filter now live in their own modules; every UI module is under 200 lines.
- [x] [Track D] Only recompute the speed of active downloads in the engine tick, and cache the snapshot of finished downloads — 5 new checks cover the size of the live feed and the cache.
- [x] [Track A] `lib/streams.js`: an `EXT-X-MAP` change in the middle of a playlist is ignored — the init section is now emitted right before the part that needs it.
- [x] [Track A] Reject `chrome-extension://` origins that are not the installed extension id — the check moved to `lib/origin.js` and the ids can now be pinned with `DLX_EXTENSION_IDS` or `extension.allowedIds`. Unpacked extensions keep working because their id depends on the folder.
- [x] [Track B] Test the FTP client when the data connection dies in the middle of a transfer — the test found that a short read without any progress looped forever; such a read now counts as an error.
- [x] [Track F] Add `docs/API.md` with the complete REST reference — every endpoint, every action, the settings and the status codes.
- [x] [Track F] Add JSDoc type annotations to the public functions of `lib/*` — the exported helpers, the two classes and the mixin methods now carry parameter and return types.
- [x] [Track E] Add a `npm run build:extension` script that prepares the browser packages.
- [x] [Track B] Fix the flaky schedule test — it used a window that ended in the current minute and broke in the last minute of every hour.

## Blocked / Failed
- None
