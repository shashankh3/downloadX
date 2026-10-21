# Contributing to downloadX

Thanks for helping out. downloadX is a **zero-runtime-dependency** Node.js project:
the app itself must never need `npm install`.

## Ground rules

- **No runtime dependencies.** Everything in `lib/`, `server.js`, `public/` and
  `extension/` must work with a bare Node.js 18+ installation. Dev tooling
  (`devDependencies`) is fine.
- **No build step for the web UI.** The UI is plain ES modules loaded by the browser.
- **Tests are local.** Every suite runs without network access and without a browser.

## Getting started

```bash
node server.js          # http://127.0.0.1:9765
npm run lint            # syntax, versions, dead files
npm test                # every suite
npm run check           # lint + tests
```

## Before you open a pull request

1. `npm run check` is green.
2. New behaviour has a test in the matching suite:
   - `test/self-test.mjs` — engine, resume, mirrors, checksums, connection budget
   - `test/api.test.mjs` — REST API, SSE, security headers
   - `test/net.test.mjs` — proxies, Basic/Digest auth, custom headers
   - `test/streams.test.mjs` — HLS / DASH, AES-128, byte ranges
   - `test/ftp.test.mjs` — FTP / FTPS
   - `test/extension.test.mjs` — the browser connector (mocked browser API)
   - `test/ui.test.mjs` — the web UI modules (DOM shim)
3. The README and `CHANGELOG.md` mention anything a user would notice.

## Code style

- Two-space indentation, semicolons, single quotes.
- `'use strict';` at the top of every CommonJS file.
- Comments explain *why*, not *what*.
- Keep functions small; keep one concern per module.

## Reporting bugs

Please include the downloadX version (`/api/health`), your Node.js version, the
operating system and the exact URL pattern you used. `DLX_DEBUG=1` adds a log line
for every HTTP request and is usually enough to narrow a download problem down.
