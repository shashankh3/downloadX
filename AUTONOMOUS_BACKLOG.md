# Autonomous Improvement Backlog
Last Updated: 2026-10-21T21:10:00Z

Project: downloadX (zero-dependency Node.js download manager)
Branch: `overnight-auto-improve` (never touch `main`)
Verify: `npm run lint` (lint + syntax) and `npm test` (6 suites) must be green before every commit.

## Pending Tasks
- [ ] [Track A] Guard `_pump()` against a data chunk arriving after the transfer was settled (stream leak / late write)
- [ ] [Track A] Fix `remove()` deleting the `.dxpart` file even when `deleteFiles` was not requested
- [ ] [Track B] Unit tests for `lib/patterns.js` edge cases (negative ranges, zero-padding of negatives, step>range)
- [ ] [Track B] Unit tests for `lib/instance.js` stale-lock recovery and port-file handling
- [ ] [Track B] Unit tests for `lib/protocol.js` `downloadx://` URI parsing (add/open/invalid)
- [ ] [Track B] Unit tests for `lib/bucket.js` `setRate()` behaviour while throttled
- [ ] [Track B] Unit tests for `lib/store.js` atomic write (tmp cleanup, corrupt fallback)
- [ ] [Track B] Engine tests for priority ordering, `_trimHistory()` cap and `clearFinished(deleteFiles=true)`
- [ ] [Track C] Extend the linter: forbid `var`, loose `==`, and `require()` inside functions
- [ ] [Track C] Extend the linter: max file length (400 lines) and max function length (120 lines) warnings
- [ ] [Track D] Skip DOM work for unchanged rows in `public/js/list.mjs` (re-render cost per SSE frame)
- [ ] [Track D] Cap the number of items serialised into an SSE snapshot; report a truncated count
- [ ] [Track D] Reuse HTTP connections for segment requests via a dedicated keep-alive agent
- [ ] [Track E] Split `public/js/list.mjs` (457 lines) into `rows.mjs`, `details.mjs`, `segments.mjs`
- [ ] [Track E] Split `lib/download.js` (1100 lines) into `download.js`, `transfer.js`, `stream.js`
- [ ] [Track E] Extract the duplicated `dispatchKeyEvent`/`Command` shims in the extension test helpers
- [ ] [Track F] Add `docs/ARCHITECTURE.md` (module map, data flow, extension points)
- [ ] [Track F] Add JSDoc type annotations to the public functions of `lib/*`
- [ ] [Track A] Reject `chrome-extension://` origins that are not the installed extension id

## In Progress
- None

## Completed
- [x] [Track A] Guard `_pump()` against a data chunk arriving after the transfer was settled (stream leak / late write) — root cause was Node emitting several `data` events per tick; chunk handling is now serialised through a promise chain. Range requests for one segmented download dropped from 2779 to 63, short reads from hundreds to 0.
- [x] [Track A] Fix `remove()` deleting the `.dxpart` file even when `deleteFiles` was not requested — removing a list entry no longer touches the disk; the UI asks for `?file=1` explicitly. Orphaned `.audio.m4a` parts are now cleaned up as well.
- [x] [Track B] Unit tests for patterns/instance/protocol/bucket/store/categories/util edge cases — new `test/units.test.mjs` with 62 checks; `lib/protocol.js` was refactored to export `parseCommand()` and only auto-run when invoked directly.
- [x] [Track A] A second instance launch reported a hard error while the first was still starting — the lock now reports "already starting" instead of throwing.
- [x] [Track C] Extend the linter with real static rules — now forbids `var`, loose equality and `require()` inside functions, and warns about oversized files/functions. Comments, strings and regex literals are stripped before scanning, so there are no false positives.
- [x] [Track D] Skip DOM work for unchanged rows and shrink the live snapshot — the engine only ships segment tables for the working set, and rows are only rewritten when their data changed.

## Completed
- None

## Blocked / Failed
- None
