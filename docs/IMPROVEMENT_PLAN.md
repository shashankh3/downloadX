# downloadX quality pass — one-hour improvement plan

This pass looked at the parts of the codebase that have the highest cost when
they fail: HTTP retries, resumable ranges, the global socket budget and the
final file rename. Every change keeps the project's two hard constraints:

* **zero runtime dependencies** — only Node.js built-ins are used;
* **backward compatibility** — the REST API, state file and settings keep
  their existing names and meaning.

The timebox was one hour:

| Minutes | Activity |
|---|---|
| 0–15 | Read the transfer/stream/probe paths and the test harness; collect authoritative guidance |
| 15–45 | Implement retry policy, origin cooldown, no-clobber promotion, agent budget, accessibility |
| 45–55 | Add regression tests (unit + engine) |
| 55–60 | Run lint and every suite, document, commit |

---

## 1. Findings and sources

| # | Finding | Source | What changed |
|---|---|---|---|
| 1 | Safe requests should retry transient statuses and socket errors with exponential back-off plus jitter; `Retry-After` must be honoured. The AWS SDK retry set is 408, 421, 425, 429, 500, 502, 503, 504. | [RFC 9110 §15](https://www.rfc-editor.org/rfc/rfc9110.html#section-15), [AWS Builders' Library: timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/), [AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html) | New `lib/retry.js`; probe, range and stream-part paths now classify errors and retry only safe/idempotent GETs. |
| 2 | One worker sleeping on a 429 does not stop the other workers from hitting the same host. A shared per-origin cooldown is needed. | [RFC 9110 §15.5.10 (429)](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.10), [AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) | New `lib/hostgate.js`, owned by the engine and consulted before every probe/range/stream part request. |
| 3 | `If-Range` must use a **strong** validator. A weak `W/` ETag can never guard a byte range; fall back to `Last-Modified`. | [RFC 9110 §13.1.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5), [MDN `If-Range`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Range) | `ifRangeHeader()` in `lib/httpget.js`, used by `_fetchChunk`. |
| 4 | `http.Agent.maxSockets` is per origin and defaults to `Infinity`; a fixed 64 silently capped a larger user budget. | [Node.js `http.Agent`](https://nodejs.org/api/http.html#agentmaxsockets), [Node.js `https.Agent`](https://nodejs.org/api/https.html#class-httpsagent) | `configureAgents()` in `lib/agents.js`, called from the engine constructor and the settings endpoint. `0` maps to `Infinity`, matching the engine's "unlimited" meaning. |
| 5 | POSIX `rename()` silently replaces an existing destination. A completed file must never destroy a file that appeared in the meantime. | [Node.js `fs.rename`](https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath), [Node.js `fs.link`](https://nodejs.org/api/fs.html#fslinksyncexistingpath-newpath) | `promoteFile()` in `lib/util.js` uses an atomic hard link (no clobber) and unlinks the part file only afterwards; both normal and stream finalisation use it. |
| 6 | Decorative animation must be removable for users who request reduced motion. | [WCAG 2.2 SC 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) | `prefers-reduced-motion` block in `public/style.css`. |
| 7 | CI tokens should be read-only by default and jobs need a timeout; dependencies should be updated by a bot. | [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions), [Dependabot options](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file) | `permissions: contents: read`, `timeout-minutes: 30`, `.github/dependabot.yml` for dev tooling and actions. |

---

## 2. Behavioural changes

### Retry policy (`lib/retry.js`)

* Retryable statuses: `408, 421, 425, 429, 500, 502, 503, 504`.
* `429` and `503` are marked `rateLimited` so the whole origin is cooled down.
* `Retry-After` accepts both delta-seconds and HTTP-date.
* Permanent 4xx responses, unsupported redirects and TLS/parse failures are
  marked fatal and are never retried.
* `isTransientError()` also recognises reset/refused/timed-out sockets, while
  explicitly excluding aborts and fatal errors.

### Origin cooldown (`lib/hostgate.js`)

* One deadline per `scheme://host:port`, shared by every download.
* A longer existing deadline is never shortened; the delay is capped at five
  minutes and defaults to two seconds when the server gives no hint.
* The class takes an injectable clock, so the tests do not sleep.
* `_waitForHost()` re-checks the deadline while waiting, so a cooldown that
  grows while a worker sleeps is respected.

### Probe, ranges and streams

* `Download.start()` retries a transient probe failure with back-off instead
  of turning a single 429/503 into a permanently failed download.
* `_fetchChunk()` and `_fetchSingle()` use the shared classifier and notify the
  gate on 429/503. Range parsing, 416 and file-change restarts are unchanged.
* HLS/DASH playlist fetches retry transient failures; stream parts honour
  `Retry-After` (capped at two minutes) and keep the existing five-attempt
  local bound.
* A probe that sees one permanent 404 and one transient 503 prefers the
  transient error, so mirrors are retried instead of failing on the 404.

### File safety

* Completion captures the part path **before** resolving a name collision.
  This fixes a latent bug: the part-path getter is derived from the final file
  name, so the old "dedupe then rename" fallback could look for a file that no
  longer had that name.
* `promoteFile()` returns `false` instead of throwing when the destination
  exists. Both the part file and the DASH audio file use it.
* A successful download now clears any stale error text from earlier retries.

### Socket budget

* `configureAgents()` is applied at engine construction and after a settings
  update. `maxConnections = 0` means `Infinity`, not zero sockets.
* The engine constructor had the `_allowPrivate`/`_lookup`/`_strictLookup`
  block duplicated; the copy is removed.
* A pump worker now allocates its 512 KB write slab on first use.

---

## 3. Regression tests

`test/units.test.mjs` (174 checks) adds:

* retry statuses, fatal 404, `Retry-After` seconds/date, transient socket codes;
* host-gate default/cap/extend/expire/independent-origin behaviour;
* `promoteFile()` success, refusal to clobber, source retention;
* strong vs weak `If-Range` validators;
* agent budget mapping for `0`, `128`, invalid input and restore.

`test/self-test.mjs` (136 checks) adds:

* a 503 on the probe followed by success;
* a 429 on a range request followed by success;
* byte-perfect output after both transient errors;
* an assertion that the connection-budget test never produces an internal
  `is not defined` error (the old `sleep`/`parseRetryAfter` bug).

---

## 4. Verification

```text
npm run lint          → 77 files parse, version/settings/translations consistent
node test/units.test.mjs → 174/174
node test/self-test.mjs  → 136/136
```

Full `npm test` and the release checks are run before committing this pass.

---

## 5. Deliberately deferred

* Migrating the custom assertion harness to `node:test`.
* Splitting `lib/download.js` (949 lines) and `test/self-test.mjs`; both are
  flagged by the linter but a split would obscure this focused change.
* A persistent retry budget across restarts; the current budget is per run and
  a manual retry resets it.
* Per-download (rather than per-origin) cooldowns. The shared gate is the
  safer default because the server sees one client.
