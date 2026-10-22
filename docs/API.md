# downloadX REST API

The server listens on `http://127.0.0.1:9765` (or the first free port from
9765 upwards). Every endpoint is local-only; the server rejects requests whose
`Host` header is not a loopback name and only answers cross-origin requests
from loopback or browser-extension origins.

All request bodies must be `application/json` (the server answers `415`
otherwise) and are capped at 1 MB.

```bash
# every example assumes:
BASE=http://127.0.0.1:9765
```

---

## Service

### `GET /api/health`

```json
{ "ok": true, "instance": "0f3c…", "version": "1.4.0", "uptime": 42,
  "pid": 8123, "platform": "win32", "node": "v24.0.0" }
```

### `GET /api/state`

The full snapshot: every download, the settings and the counters. This is the
same payload the live feed sends.

```json
{
  "version": 2,
  "uptime": 42,
  "items": [ /* … */ ],
  "settings": { /* … */ },
  "globalSpeed": 1048576,
  "activeCount": 1,
  "activeConnections": 8,
  "connectionLimit": 64,
  "scheduleHalted": false,
  "shutdownArmed": false,
  "shutdownIn": 0
}
```

### `GET /api/free-space`

Free bytes on the volume that holds the download folder.

```json
{ "ok": true, "dir": "C:\\Users\\you\\Downloads", "free": 35826191360 }
```

`free` is `null` when the platform cannot report it.

### `GET /api/update-check`

Reads the update manifest configured in `updateUrl`. The result is cached for
six hours.

```json
{ "ok": true, "configured": true, "current": "1.4.0", "latest": "1.5.0",
  "updateAvailable": true, "url": "https://…/downloadX.exe", "notes": "…",
  "checkedAt": 1700000000000 }
```

Without a manifest: `{ "ok": true, "configured": false, "updateAvailable": false }`.
A broken manifest answers `502` with `{ "ok": false, "error": "…" }`.

### `GET /api/events`

A Server-Sent Events stream. The first event is a complete snapshot, later
events follow when something changes (at most every ~700 ms).

```
retry: 2000

event: snapshot
data: {"version":2,"items":[…],…}
```

---

## Downloads

### `POST /api/downloads`

Adds one or more downloads. `201` on success, `400` on a bad request.

| Field | Type | Meaning |
|---|---|---|
| `url` | string | A single URL |
| `urls` | string[] | Several URLs (one download each) |
| `text` | string | Newline separated URLs and patterns |
| `filename` | string | Target name (single URL only) |
| `category` | string | `auto`, `Programs`, `Compressed`, `Video`, `Music`, `Documents`, `Images`, `Others` |
| `segments` | number | Connections for this file (1-64) |
| `speedLimitKBs` | number | Speed limit for this file (0 = none) |
| `mirrors` | string[] | Fallback URLs, used one after another |
| `referer` | string | `Referer` header |
| `cookies` | string | `Cookie` header |
| `headers` | object | Extra request headers |
| `username` / `password` | string | Basic or Digest authentication |
| `proxy` | string | `http://`, `https://` or `socks5://` proxy for this file |
| `dir` | string | Target folder (overrides the category folder) |
| `expectedChecksum` | string | Hash verified when the download finishes |
| `checksumAlgo` | string | `sha256`, `sha1`, `md5` or `sha512` |
| `priority` | number | -100 … 100, higher starts first |
| `startedPaused` | boolean | Queue the download without starting it |

```bash
curl -X POST $BASE/api/downloads -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/file.zip","segments":16,"referer":"https://example.com/page"}'
```

With several URLs the answer is a batch:

```json
{ "batch": [ { "id": "…", "status": "queued", … } ], "count": 12 }
```

With one URL the answer is the download itself:

```json
{ "id": "…", "url": "https://example.com/file.zip", "filename": "file.zip",
  "status": "queued", "total": 0, "received": 0, "segments": [], … }
```

### `GET /api/downloads/:id`

The snapshot of one download, or `404` when the id is unknown.

### `DELETE /api/downloads/:id`

Removes the entry from the list. Add `?file=1` to delete the downloaded file
and the partial data as well — without it nothing on disk is touched.

```
DELETE /api/downloads/<id>          # only the list entry
DELETE /api/downloads/<id>?file=1   # and the files
```

### `POST /api/downloads/:id/<action>`

| Action | Body | Effect |
|---|---|---|
| `pause` | – | Pauses the transfer (the data is kept) |
| `resume` | – | Continues a paused download |
| `retry` | – | Queues a failed or canceled download again |
| `restart` | – | Downloads the file from scratch |
| `cancel` | – | Stops the transfer and keeps the partial data |
| `priority` | `{"value": 10}` | Sets the priority (-100 … 100) |
| `limit` | `{"kbs": 500}` | Sets the speed limit (0 = none) |
| `segments` | `{"value": 32}` | Sets the connection count (only while paused) |
| `quality` | `{"index": 0}` | Picks another quality of a stream (the file is downloaded again) |
| `verify` | `{"algo": "sha256", "expected": "…"}` | Verifies the checksum now |
| `zip-entries` | – | Lists the entries of a finished ZIP archive |
| `extract-entries` | `{"names": ["a/setup.exe"]}` | Writes single entries of a ZIP archive next to it |
| `open-file` | – | Opens the finished file |
| `open-folder` | – | Opens the folder in the file manager |

The answer is the updated snapshot. Unknown actions answer `400`, unknown ids
`404`, and changing the connection count of a running download `409`.

---

## Queue and settings

### `POST /api/pause-all` · `POST /api/resume-all`

Pauses or resumes every download. Answers `{ "ok": true }`.

### `POST /api/retry-failed`

Queues every failed download again.

```json
{ "retried": 3 }
```

### `POST /api/clear-finished`

Removes the finished, failed and canceled entries from the list.

```json
{ "removed": 12 }
```

Send `{ "deleteFiles": true }` to delete their files as well.

### `GET /api/settings` · `PUT /api/settings`

Reads or writes the settings. Unknown keys are ignored, every value is
validated and clamped.

| Setting | Type | Default |
|---|---|---|
| `rootDir` | string | the `Downloads` folder |
| `maxConcurrent` | number 1-20 | 3 |
| `maxConnections` | number 0-512 | 64 (0 = unlimited) |
| `defaultSegments` | number 1-64 | 16 |
| `globalSpeedLimit` | bytes/s | 0 (unlimited) |
| `organizeByCategory` | boolean | true |
| `scheduleEnabled` | boolean | false |
| `scheduleFrom` / `scheduleTo` | `HH:MM` | 23:00 / 07:00 |
| `shutdownWhenDone` | boolean | false |
| `proxy` | string | none |
| `allowInvalidTls` | boolean | false |
| `notifications` | boolean | true |
| `notificationSound` | boolean | true |
| `updateUrl` | string | none |
| `maxRetries` | number 1-100 | 12 |
| `webhookUrl` | string | none |

```bash
curl -X PUT $BASE/api/settings -H "Content-Type: application/json" \
  -d '{"maxConnections":32,"maxRetries":20}'
```

### The webhook

With `webhookUrl` set, downloadX posts a JSON body when a download finishes
or fails:

```json
{
  "event": "completed",
  "id": "…",
  "filename": "movie.mp4",
  "url": "https://example.com/movie.mp4",
  "path": "C:\\Users\\you\\Downloads\\movie.mp4",
  "size": 734003200,
  "error": "",
  "at": 1700000000000
}
```

`event` is `completed` or `failed`. The call is fire and forget: a broken
webhook never affects a download.

### `POST /api/cancel-shutdown`

Aborts a pending "shut down when everything is finished".

### `POST /api/extension/install`

Opens the browser extension: the store page when a store id is configured,
otherwise the folder with the unpacked extension. Answers the folder, the
store id and whether a CRX package was built.

### `POST /api/quit`

Shuts the server down. The state is written and the port file is removed
before the process exits.

---

## Patterns

### `POST /api/expand`

Expands a batch pattern into the URLs it stands for.

```bash
curl -X POST $BASE/api/expand -H "Content-Type: application/json" \
  -d '{"text":"https://example.com/photos/img[01-20].jpg"}'
```

```json
{ "urls": ["https://example.com/photos/img01.jpg", "…"],
  "errors": [{ "line": "nonsense", "error": "Not an http(s) or ftp(s) URL" }] }
```

### `POST /api/scrape`

Finds the download links of a web page (the site grabber).

```bash
curl -X POST $BASE/api/scrape -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/downloads"}'
```

```json
{ "ok": true, "url": "https://example.com/downloads", "count": 12,
  "links": [{ "url": "https://example.com/files/manual.pdf", "ext": "pdf", "likely": true }] }
```

The links are absolute, de-duplicated and sorted with the likely downloads
first. Page assets (css, images, scripts) are left out unless
`{"includeAssets": true}` is sent. A page URL that is not http(s) answers
`400`, a page that cannot be read answers `502`.

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | The request succeeded |
| `201` | A download was created |
| `400` | The request was malformed (unknown action, bad URL, …) |
| `404` | Unknown download or unknown route |
| `409` | The action does not fit the current state (running) |
| `413` | The body is larger than 1 MB |
| `415` | The body is not `application/json` |
| `502` | The update manifest could not be read |
