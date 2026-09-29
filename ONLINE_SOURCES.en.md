# Online module — pluggable multi-source architecture

> For people who want to **deploy** the reader with online comics enabled, or who want to **add a new site themselves**.
> The local library (PDF / CBZ / EPUB) is covered in the main [README.md](README.md); this document is only about online sources.

> 中文版见 [ONLINE_SOURCES.md](ONLINE_SOURCES.md)

---

## 0. In one paragraph

The online module is a **pluggable architecture decoupled from any specific site**:

- `server.js` only calls sources through a registry (`lib/sources`) and **never implements a site protocol itself**;
- each site is one file implementing a **shared interface** (see `lib/sources/jm.js`);
- the repo ships `jm` as an **example source**, **disabled by default** — whether to enable it, and which sources to enable, is entirely up to the deployer via the `ONLINE_SOURCE` variable;
- the front end's online tab renders a **source switcher** from whatever is enabled, and search aggregates across all enabled sources.

---

## 1. Design principles

| Principle | Meaning |
|---|---|
| **Opt-in** | An empty `ONLINE_SOURCE` registers and enables nothing. Search, detail and the image proxy all answer "not enabled". **Leave it unset and the app is purely local and never contacts a third party.** |
| **Pluggable** | A new site is one file under `lib/sources/` plus one entry in `sources.json`. Front end, back end and image proxy adapt automatically — **`server.js` is untouched**. |
| **Decoupled** | Authentication, encryption, de-obfuscation and host probing all live inside the source file. When a site breaks, only that file changes. |
| **Server-side proxy** | Images are fetched and restored by the server; the front end only ever sees `/api/online/img?url=...`. Referer checks and image scrambling are invisible to it. |

Compliance and disclaimer: section 8.

---

## 2. Deploying with an online source

### 2.1 Environment variables

| Variable | Default | Description |
|---|---|---|
| `ONLINE_SOURCE` | empty (off) | Sources to enable; see below |
| `PORT` | `3000` | Listen port (`docker-compose.yml` maps `${PORT:-3000}:3000`) |
| `DATA_DIR` | `/app/data` | Runtime data (users, JWT secret, shelves). **Mount it**, or the admin account disappears on restart |
| `JWT_SECRET` | empty | Generated on first start and written to `DATA_DIR/.jwt-secret` if empty; a fixed string of 32+ characters also works |

### 2.2 Values of `ONLINE_SOURCE`

| Value | Meaning |
|---|---|
| _(unset / empty)_ | Only sources with `enabledByDefault: true`. None currently qualify → **everything off** |
| `jm` | Only `jm` |
| `jm,kavita` | Several, separated by commas or spaces |
| `all` | Everything listed in `sources.json` |

### 2.3 Docker Compose (recommended)

Add one line to `environment` in `docker-compose.yml`:

```yaml
environment:
  PORT: 3000
  ONLINE_SOURCE: "jm"        # this enables jm
  # JWT_SECRET: "<32+ random chars>"   # optional, pins the secret
```

Then:

```bash
docker compose up -d --build
```

Open `http://<host>:3000`; **the first account to log in becomes the administrator**.

### 2.4 Plain docker run

```bash
docker build -t comic-reader .
docker run -d -p 3000:3000 \
  -e ONLINE_SOURCE=jm \
  -v $(pwd)/comics:/comics \
  -v comic-data:/app/data \
  --name comic-reader comic-reader
```

---

## 3. HTTP API

> **Auth**: every `/api/online/*` route requires a login. Send `Authorization: Bearer <token>`.
> Log in first via `POST /api/login` (or the login page) to obtain the JWT.
> The first account to log in is the administrator.

### `GET /api/online/sources`

Enabled sources, used by the front end to render the switcher.

```json
{
  "enabled": true,
  "sources": [
    { "key": "jm", "name": "jm", "description": "example online source, enable manually" }
  ]
}
```

### `GET /api/online/status`

Overall state of the online module, so the front end can show a hint without triggering a search first.

```json
{
  "enabled": true,
  "source": "jm",
  "available": [
    { "key": "jm", "name": "jm", "description": "...", "enabled": true }
  ]
}
```

### `GET /api/online/search`

Searches **all enabled sources concurrently** and merges the results; each result carries a `_source` tag used later to route `album` / `chapter`.

| Parameter | Required | Description |
|---|---|---|
| `q` | yes | Keyword |
| `order` | no | Sort order, default `mr` (newest), passed through to the source |
| `page` | no | Page number, default 1 |

```json
{
  "total": 12,
  "maxPage": 1,
  "comics": [
    { "id": "12345", "title": "...", "author": "...", "cover": "https://...", "tags": [], "description": "...", "_source": "jm" }
  ]
}
```

> Search always aggregates; the endpoint takes no `source` parameter. Use `_source` from the results to tell them apart.

### `GET /api/online/album/:id`

Work detail: chapter list, author, tags, related items.

| Parameter | Required | Description |
|---|---|---|
| `source` | no | Source key; defaults to the first enabled source. With several sources, pass the `_source` from the search result |

```json
{
  "id": "12345",
  "title": "...",
  "author": "...",
  "cover": "https://...",
  "description": "...",
  "likes": 123,
  "tags": { "author": [], "works": [], "tags": [] },
  "chapters": [ { "id": "67890", "title": "Chapter 1" } ],
  "related": [],
  "_source": "jm"
}
```

### `GET /api/online/chapter/:id`

Image URLs for one chapter. These are raw URLs; the front end displays them through the image proxy.

| Parameter | Required | Description |
|---|---|---|
| `source` | no | As for `album` |

```json
{ "epId": "67890", "images": [ "https://cdn.../media/photos/67890/001.webp" ] }
```

### `GET /api/online/img`

**Image proxy**: fetches the original, calls the owning source's `decodeImage` to restore it, and returns a displayable image. The front end just uses `<img src="/api/online/img?url=<original>">`.

| Parameter | Required | Description |
|---|---|---|
| `url` | yes | Original image URL (must be an http/https domain; **IP literals and localhost are rejected**, see section 5) |

Success returns the image bytes (`Content-Type: image/webp`; content images are normalised to webp, covers keep their original format) with `Cache-Control: public, max-age=86400`.
Failure returns `400` or `502` with `{ "error": "..." }`.

---

## 4. Front-end switcher behaviour

- Entering the online tab fetches `/api/online/sources`.
- `enabled=false` (no `ONLINE_SOURCE`): a hint is shown and no switcher appears.
- One source enabled: it is shown directly, no switcher.
- Two or more: a dropdown appears; switching refetches that source's results.
- Results come from all enabled sources; opening a work passes its `_source` through to `album` / `chapter`.

---

## 5. Image proxy and SSRF protection (`lib/online-image.js`)

```
<img src="/api/online/img?url=U">
  -> protocol/SSRF check: http(s) only, no IP literals, no localhost
  -> findDecoder(U): whichever enabled source recognises the URL decodes it; otherwise the first enabled source
  -> fetch with Referer/UA to get past hotlink protection
  -> source.decodeImage(buffer, parsed)
  -> LRU cache (200 entries) -> return the image
```

Protection rules worth knowing when wiring up a self-hosted source:

- The scheme must be `http:` or `https:`.
- **IP literals are rejected** (`http://1.2.3.4/...` will not work); use a domain name.
- `localhost` and `*.localhost` are rejected.

> A source served from a CDN domain works fine. A LAN source addressed by IP will be blocked — that is deliberate.

---

## 6. Writing a new source

### 6.1 Implement the interface

Create `lib/sources/mysite.js` exporting the following (see `lib/sources/jm.js`):

```js
'use strict';
const https = require('https');

module.exports = {
  name: 'mysite',            // source key, must match the manifest
  label: 'My Site',          // display name

  // search -> { total, maxPage, comics:[{ id, title, author, cover, tags, description }] }
  async search(keyword, order, page) { /* ... */ },

  // detail -> { id, title, author, cover, description, likes, tags, chapters:[{ id, title }], related }
  async album(id) { /* ... */ },

  // chapter -> { epId, images:[ url1, url2, ... ] }
  async chapter(epId) { /* ... */ },

  getCoverUrl(id) { /* ... */ },
  getImageUrl(epId, name) { /* ... */ },

  // Restore a fetched image. `parsed` comes from parseImageUrl.
  // Return the buffer untouched if there is nothing to do.
  async decodeImage(buffer, parsed) { return buffer; },

  // Does this URL belong to this source? -> { kind:'photo'|'cover', epId?, pictureName?, isGif? } or null.
  // The proxy uses it to route, and passes the object straight to decodeImage.
  parseImageUrl(u) {
    const m = /^\/media\/photos\/(\d+)\/([^/]+)$/.exec(u.pathname);
    if (!m) return null;
    return { kind: 'photo', epId: m[1], pictureName: m[2].replace(/\.[^.]+$/, ''), isGif: /\.gif$/i.test(m[2]) };
  },
};
```

**Return shapes the front end relies on — do not rename fields:**

| Method | Returns | Key fields |
|---|---|---|
| `search` | `{ total, maxPage, comics:[...] }` | `comics[].id` / `title` / `author` / `cover` / `tags` / `description` |
| `album` | object | `id` / `title` / `author` / `cover` / `description` / `likes` / `tags` / `chapters:[{id,title}]` / `related` |
| `chapter` | `{ epId, images:[...] }` | `images` holds **absolute URLs** |
| `decodeImage` | `Buffer` | restored image bytes |
| `parseImageUrl` | object / `null` | `kind` / `epId` / `pictureName` / `isGif` |

### 6.2 Register it

Add an entry to `lib/sources/sources.json`:

```json
[
  { "key": "jm", "name": "jm", "file": "jm.js", "enabledByDefault": false, "description": "example online source" },
  { "key": "mysite", "name": "My Site", "file": "mysite.js", "enabledByDefault": false, "description": "self-hosted example" }
]
```

| Field | Meaning |
|---|---|
| `key` | Unique lowercase identifier; the front end passes it as `?source=` |
| `name` | Display name in the switcher |
| `file` | Implementation filename under `lib/sources/` |
| `enabledByDefault` | Whether it is enabled when `ONLINE_SOURCE` is unset. **Keep this `false`** — the repo never turns on a third-party site on the user's behalf |
| `description` | Text shown in the switcher and the status endpoint |

### 6.3 Enable and debug

1. Deploy with `ONLINE_SOURCE=jm,mysite` (or `all`).
2. Restart the service.
3. Verify: `GET /api/online/sources` lists `mysite`, and `mysite.enabled` is `true` in `GET /api/online/status`.
4. Tips:
   - A source that fails to load logs `[sources] failed to load <key>: ...`; check the `file` path and the exports.
   - Images not rendering: confirm `parseImageUrl` matches your URLs and `decodeImage` returns sensible bytes.
   - "current online source does not support this image URL" means `findDecoder` found no match — check `parseImageUrl` and the enabled set.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` from `/api/online/*` | Expected — these routes need a JWT. Log in and send `Authorization: Bearer` |
| `403 online module not enabled` | `ONLINE_SOURCE` is unset or names an unknown source. Set it and **restart** |
| The online tab shows "not enabled" | Same as above: the variable is not in effect or the service was not restarted |
| Blank images / `502` | The origin could not be fetched (hotlink protection, dead hostname, timeout). Check the `[online/img]` log |
| `400 IP literals are not allowed` | The URL uses an IP or localhost and was blocked (section 5). Use a domain |
| All `jm` requests fail | The jm API hostname moves. Update the `API_DOMAINS` candidates in `lib/sources/jm.js` and rebuild |
| Restored images are still scrambled | `computeScrambleNum` in `jm.js` derives the block count from the epId; if jm changes the scheme it must be updated |

---

## 8. Compliance and disclaimer

This repository is a **generic reader**. The `jm` source is only **an example implementation** of the pluggable-source interface.

- Online sources depend on third-party sites and may break or change at any time; nothing here guarantees or maintains their availability.
- **Follow the laws and regulations of your jurisdiction** and only access content you are entitled to access.
- Any copyright or compliance consequences of using an online source are yours; the project and its author accept no liability.
- Online features are **off by default**: leave `ONLINE_SOURCE` unset and the app runs purely locally.
- Local post-processing of jm downloads (host `python3` + `jmcomic` + AstrBot) is out of scope and is not shipped with this repository.

---

## Appendix: key files

| File | Responsibility |
|---|---|
| `lib/sources/index.js` | Registry: loads `sources.json`, parses `ONLINE_SOURCE`, exports `getEnabled` / `getSource` / `findDecoder` |
| `lib/sources/sources.json` | Source manifest (key / name / file / enabledByDefault / description) |
| `lib/sources/jm.js` | Full example source: auth, AES decryption, host probing, image de-scrambling, URL parsing |
| `lib/online-image.js` | Image proxy: SSRF guard, fetch, LRU cache, dispatch to `decodeImage` |
| `server.js` | Online routes: `/api/online/{sources,status,search,album,chapter,img}` |
| `.env.example`, `docker-compose.yml` | Environment variable examples |
