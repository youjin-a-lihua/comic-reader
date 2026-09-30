# Comic Reader · self-hosted manga & novel reader

A self-hosted reader for comics and books with two kinds of content source:

- **Local library** — scans PDF / CBZ / CBR / EPUB on the server, generates covers, tracks reading progress, favourites and likes.
- **Online sources (pluggable)** — ships with `jm` as an example source: search → detail → read online, with images restored server-side (de-obfuscation, referer bypass). The front end never deals with a site's protocol.

Includes account login (JWT), shelves, progress sync and optional AstrBot integration.

> 中文版见 [README.md](README.md)

---

## Features

- Local library: PDF / CBZ / CBR (including encrypted PDFs) and EPUB
- Search, rankings, full-library browsing, continue reading
- Favourites, likes, custom shelves, multiple users
- **Annotations / highlights** — select text in an EPUB to highlight it in one of four colours or attach a note. Stored per book on the server, so it survives refresh and follows you across devices. See [ANNOTATIONS.en.md](ANNOTATIONS.en.md)
- **AI chapter summary** — one-click summary of the current EPUB chapter
- **Online sources** — search / detail / chapters / online reading, images proxied and restored server-side
- **Pluggable sources** — adding a site means dropping one file implementing the shared interface into `lib/sources/`
- Optional AstrBot integration: enter its address and account in the UI to send `/jm`-style commands and poll the result

---

## Deploy (Docker Compose)

```bash
git clone https://github.com/youjin-a-lihua/comic-reader.git
cd comic-reader
mkdir -p comics
docker compose up -d --build
```

Books go in `comics/`. To use another directory, change the mount in `docker-compose.yml`.

Open `http://<your-host>:3000`. The first account to log in becomes the administrator; further users can be added under "Me".

Data (users, shelves, JWT secret, AstrBot config) is persisted in the `comic-data` volume.

### Without Compose

```bash
docker build -t comic-reader .
docker run -d -p 3000:3000 \
  -v $(pwd)/comics:/comics \
  -v comic-data:/app/data \
  --name comic-reader comic-reader
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `COMICS_DIR` | `/comics` | Local library root (mounted volume) |
| `DATA_DIR` | `/app/data` | Runtime data directory — mount it, or you lose the admin account on restart |
| `JWT_SECRET` | empty | Left empty, a secret is generated on first start and written to `DATA_DIR/.jwt-secret`. You may supply a fixed string of 32+ characters instead |
| `ONLINE_SOURCE` | empty (off) | Which online sources to enable. Empty enables **none**. Accepts one (`jm`), several separated by commas or spaces (`jm,kavita`), or `all` for everything listed in `lib/sources/sources.json` |
| `NOVEL_DIR` | empty | Absolute path to a novel directory; without it the "novels" library is not shown |
| `DECRYPT_PASSWORD` | empty | Open password for encrypted PDFs. Can also be set on the admin page (**takes precedence** — it is persisted to `DATA_DIR/settings.json`). Empty in both places means nothing is decrypted. The value is **never sent back to the browser** (the page only shows configured/not) and is redacted to `***` in the audit log |

---

## How pluggable sources work

> **Off by default.** The repo ships `jm` as an example source but **does not register or enable it** unless you set `ONLINE_SOURCE=jm` explicitly. Left empty, the whole online module is disabled: search, detail and the image proxy all answer "not enabled". Enabling a third-party site is always your decision.

The online module is decoupled from any specific site. `server.js` only talks to sources through the `lib/sources` registry, so **adding or enabling a source never touches `server.js`**.

**Source manifest** (`lib/sources/sources.json`):

```json
[
  { "key": "jm", "name": "jm", "file": "jm.js", "enabledByDefault": false, "description": "example online source, enable manually" }
]
```

`ONLINE_SOURCE` decides what is enabled: unset (only sources with `enabledByDefault: true`, currently none) → `jm` → `jm,kavita` → `all`.

**The shared interface** (see `lib/sources/jm.js`):

```js
module.exports = {
  name: 'jm',                       // source key
  label: 'jm',                      // display name
  search(keyword, order, page),     // -> { total, maxPage, comics:[{id,title,author,cover,tags,description}] }
  album(id),                        // -> { id, title, author, cover, description, likes, tags, chapters:[{id,title}], related }
  chapter(epId),                    // -> { epId, images:[url...] }
  getCoverUrl(id), getImageUrl(epId, name),   // optional
  decodeImage(buffer, parsed),      // restore a fetched image; return the buffer unchanged if not needed
  parseImageUrl(u),                 // -> { kind, epId?, pictureName?, isGif } or null; the proxy uses it to pick a decoder
};
```

**Adding a source**: implement the interface in a new file under `lib/sources/`, then add an entry to `lib/sources/sources.json` (`key` / `name` / `file` / `enabledByDefault`). The front end, back end and image proxy adapt automatically.

The image proxy (`lib/online-image.js`) handles SSRF checks, downloading and an LRU cache; with several sources it routes each image URL to the source that recognises it. Full details in [ONLINE_SOURCES.en.md](ONLINE_SOURCES.en.md).

---

## Layout

```
server.js              Express entry point
lib/
  sources/              online sources: jm.js is the example, sources.json the manifest, index.js the registry
  online-image.js      image proxy (SSRF guard + fetch + cache + decode dispatch)
  scanner/cbz/epub/... local library scanning and parsing
  progress/auth/...    progress, accounts, shelves
public/                front end (index.html / app.js / reader.js / vendor/pdfjs ...)
testdata/              a real book in EPUB + PDF for readability checks after deployment
```

---

## Compliance and disclaimer

This repository is a **generic reader**. The `jm` source is only **an example implementation** of the pluggable-source interface.

- Online sources depend on third-party sites and may break or change at any time; nothing here guarantees or maintains their availability.
- **Follow the laws and regulations of your jurisdiction** and only access content you are entitled to access.
- Any copyright or compliance consequences of using an online source are yours; the project and its author accept no liability.
- Online features are **off by default**: leave `ONLINE_SOURCE` unset and the app runs purely locally without contacting any third party.
- Local post-processing of jm downloads (host `python3` + `jmcomic` + AstrBot) is out of scope for this repository and is not shipped with it.

---

## Development

```bash
npm install
npm start            # or npm run dev for watch mode; serves http://localhost:3000
```

Requires Node.js ≥ 20. `sharp` installs from a prebuilt binary, so no local toolchain is needed.

---

## Changelog

### v1.4.5 (2026-09-30)

**UI**
- Every emoji in the interface is now an inline SVG icon: a 34-symbol set plus an `ico()` helper, both defined inside `index.html` (no new files, no external dependency). 100 replacements across `app.js`, `reader.js`, `index.html` and `login.html`
- Buttons that used a bare glyph as an icon (`↕` `↔` `⇄` `⇦` `⊟`) joined the same set; typographic arrows (`→` `←`) were left alone
- Icons are `1em` and use `currentColor`, so they follow the surrounding font size and colour with no layout change
- Dropped the decorative `──` / `═══` comment banners in `app.js` (19 lines)
- Asset version `?v=20260924d` to `?v=20260930` so clients pick up the new files

### v1.4.4 (2026-09-30)

**Docs**
- Removed the comment noise inside the README code blocks (comments such as `# start` that restate the next line, and the `<this repo>` placeholder now the real URL). The v1.4.1 pass only looked at `.js/.css/.html` - markdown was never audited
- Dropped the chatty, salesy wording and the emoji in headings and list bullets, in favour of plain statements of fact

### v1.4.3 (2026-09-29)

**Security**
- Closed the remaining gaps in credential handling: `GET /api/admin/settings` **no longer returns the plaintext** (it only reports `hasDecryptPassword`); the settings field is now `type="password"`; the **audit log no longer stores the raw value** (redacted to `***`); and a *Clear password* button was added, since a stored password could previously never be removed

### v1.4.2 (2026-09-29)

**Security**
- **Removed the hardcoded default decrypt password.** The plaintext default baked into `lib/settings.js` is gone; the password now comes from the admin page or `DECRYPT_PASSWORD`. With neither set, auto-decrypt stays idle rather than trying an empty password

### v1.4.1 (2026-09-29)

**Housekeeping / docs**
- Trimmed comment noise across the codebase: dated change logs, restatements of the code below and decorative separators are gone; comment density went from 9.8% to 0.8% and the notes that remain are in English
- English versions of the documentation: [ANNOTATIONS.en.md](ANNOTATIONS.en.md) · [ONLINE_SOURCES.en.md](ONLINE_SOURCES.en.md)

### v1.4.0 (2026-09-24)

**Added · annotations**
- **Select text → highlight or annotate** in the EPUB reader. Four colours (yellow / green / blue / pink) or attach a note. Stored per book on the server, so a refresh or another device still shows it
- A "" button with a count badge in the toolbar opens an annotations tab in the sidebar: jump to a highlight, edit it, or delete it
- **AI chapter summary** — the "AI" button summarises the current chapter (cached client-side)
- New endpoints: `GET/POST /api/comic/:id/annotations`, `PATCH/DELETE /api/comic/:id/annotations/:aid`, `GET /api/comic/:id/summary[/:chapter]`
  - Stored in `DATA_DIR/annotations/<comicId>.json`, cleaned up when a book is deleted
  - Details in [ANNOTATIONS.en.md](ANNOTATIONS.en.md)

**Fixed**
- The page-turn hot zone (`.epub-tap-zone`) was 25% wide with `z-index: 5`, floating above the text and making **the outer 25% on each side unselectable** — a click there turned the page instead. It now uses `max(10%, calc((100% - 800px) / 2))`, so wide screens keep it outside the text column. Page turning still works from the buttons
- **Books without tags were invisible in the "comics" tab**: grouping only collected tagged books, and the fallback never fired on a large library (170+ books affected here). They now form an "uncategorised" group
- **A PDF placed in the novel library was still treated as a comic**: a sidecar-declared `type` now wins over extension sniffing. Note the scanner has both a sync and an async path — patching only one changes nothing
- EPUB table of contents failed to match chapter titles when `spine.href` carried a directory prefix such as `OEBPS/`

### v1.3.0 (2026-09-21)

**Performance**
- **Stopped the watchdog from reading every SSD pointlessly.** `lib/decrypt.js` used to load the **entire file** just to test whether a PDF was encrypted (about 1290 books averaging 26 MB, every 30 minutes), measured at **1.6 TB/day** read on `/vol3` and 6.0% average CPU.
  It now inspects only the **last 256 KB** — the trailer dictionary sits at the end of the file — with a safety valve: if no `%%EOF` appears in that window it falls back to the full path.
  - Result: 1.6 TB/day → 6.4 GB (**−99.6%**), steady-state CPU 6.0% → 0.2%
  - Regression: encrypted PDFs are still detected and decrypted; plaintext files are byte-for-byte untouched

**Added**
- **Audit log** (admin only): account, IP, time, action, result. JSONL append plus a 500-entry in-memory ring and 5 MB rotation
- **Download cart**: long-press online comics to add them to a list, then download the whole cart
- **Download history**: task results persisted to `downloads.json`

**UX**
- Login page and admin console moved onto the main design language
- ↩ Fixed the missing back button on the online detail page
- Fixed the detail page keeping the previous scroll position (and the resulting transition glitch)
- Fixed a duplicated back button in the reader

**Robustness / security**
- Fixed settings not being persisted (`jsonstore` lacked a dirty flag, so switches such as auto-decrypt reverted on restart)
- Express 4 never sees async rejections, which left requests **hanging forever**; every handler is now wrapped
- `users.json` is written atomically — a truncated file used to look like a fresh install, **recreating the admin and losing every account**
- Fixed a missing `await` in the CBZ/CBR page endpoint that made **archives unreadable**
- Image proxy **SSRF hardening**: resolve DNS and judge the resulting addresses (covers IPv6, IPv4-mapped, decimal IPs and domains pointing inward), plus a 20 MB response cap and CRLF injection guards
- Cover cache keys moved to a hash of the absolute path so different comics can no longer **share a cover**
