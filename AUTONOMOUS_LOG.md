# Autonomous Execution Log
Started: 2026-10-21T21:10:00Z
Branch: overnight-auto-improve
Base commit: 5efc3a3 (origin/main)

## Environment
- Package manager: npm (no runtime dependencies; devDeps only for the EXE build)
- Lint: `npm run lint` -> node scripts/lint.mjs
- Typecheck: n/a (plain JS) - `node --check` runs inside the linter for every file
- Tests: `npm test` (self-test, api, net, streams, ftp, extension, ui)
- Full suite: `npm run test:all` (adds installer, integration, local)

## Log

### 2026-10-21T21:35:00Z — [Track A] serialise `_pump()` chunk handling
- Files: `lib/download.js`, `test/self-test.mjs`
- Problem: Node's `Readable.read()` can emit several `data` events in one tick.
  `_pump()` handled them with concurrent async handlers, so the byte counter
  (`pos`) was updated from several places at once. Every segmented download
  ended in a "short read" and retried the range — 2779 range requests for a
  single 6 MB file.
- Fix: chunks are pushed through a promise chain and handled one at a time; the
  terminal events (`end` / `error` / `aborted` / `close`) wait for the chain.
- Verification: `npm run lint` clean; `npm test` -> 95/95, 66/66, 33/33, 33/33,
  46/46, 87/87, 28/28. Range requests for the self-test download: 2779 -> 63,
  short reads: hundreds -> 0.

### 2026-10-21T21:45:00Z — [Track A] explicit file deletion on remove
- Files: `lib/download.js`, `lib/engine.js`, `public/js/list.mjs`, `test/self-test.mjs`
- Problem: `engine.remove(id, deleteFiles)` stopped the transfer through
  `cancel()`, which deleted the `.dxpart` file even when the caller did not ask
  for it. The DASH audio part (`.audio.m4a`) was never deleted at all, so every
  removed DASH download left an orphaned file behind.
- Fix: `cancel({ keepFiles })` can now keep the partial data; `remove()` only
  deletes files when `deleteFiles` is set and always removes the audio part
  too. The UI asks for `?file=1` where its dialog promises to delete data.
- Verification: `npm run lint` clean; `npm test` -> 99/99, 66/66, 33/33, 33/33,
  46/46, 87/87, 28/28 (4 new removal-semantics checks).

### 2026-10-21T22:00:00Z — [Track B] unit tests for the small modules
- Files: `test/units.test.mjs` (new), `lib/protocol.js`, `lib/instance.js`,
  `server.js`, `package.json`, `.github/workflows/ci.yml`
- Coverage added: pattern groups (negative, step, padding, malformed), instance
  lock (stale reclaim, second claim, port file), protocol URI parsing, token
  bucket rate changes, atomic store writes, category detection, util helpers.
- `lib/protocol.js` had no exports and ran on import, so it could not be
  tested. It now exports `parseCommand()` and only auto-runs when it is the
  entry point.
- Bonus fix found by the new tests: a second launch while the first instance was
  still starting threw "Another downloadX instance is starting..." instead of
  reporting that downloadX is already running. The lock now returns
  `{ acquired: false, starting: true }` and the server prints a friendly note.
- Verification: `npm run lint` clean; `npm test` -> 99/99, 62/62, 66/66, 33/33,
  33/33, 46/46, 87/87, 28/28.
