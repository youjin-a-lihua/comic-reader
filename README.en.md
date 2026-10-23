# Comic Reader

> 中文说明：[README.md](README.md)

A self-hosted reading server for comics, manga and novels. One container, readable from any browser, phone or tablet.

- Local library: scans PDF / CBZ / CBR / EPUB, generates covers, tracks reading progress
- Encrypted PDFs: automatic decryption, password set in the admin panel or via environment
- EPUB reader: TOC, typography, annotations & highlights, AI chapter summaries (see [ANNOTATIONS.en.md](ANNOTATIONS.en.md))
- Multi-user: accounts, shelves, favourites, continue reading, rankings
- Pluggable online sources: search / online reading / download to library, off by default (see [ONLINE_SOURCES.en.md](ONLINE_SOURCES.en.md))
- Optional AstrBot integration

## Quick start

Images are published to GHCR for linux/amd64 and linux/arm64, built automatically by GitHub Actions on every push:

```bash
docker run -d --name comic-reader \
  -p 3000:3000 \
  -e TZ=Asia/Shanghai \
  -v /path/to/comics:/comics \
  -v comic-data:/app/data \
  ghcr.io/youjin-a-lihua/comic-reader:latest
```

Or with docker compose:

```bash
git clone https://github.com/youjin-a-lihua/comic-reader.git
cd comic-reader
mkdir comics
docker compose up -d      # add --build to test local changes
```

Open `http://<server-ip>:3000`. The first account to register becomes the administrator.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `COMICS_DIR` | `/comics` | Root of the local comics library (mounted volume) |
| `DATA_DIR` | `/app/data` | Runtime data directory (persist with a volume) |
| `JWT_SECRET` | empty | Leave empty to auto-generate on first start and store in `DATA_DIR/.jwt-secret`; or set a ≥32-char string |
| `ONLINE_SOURCE` | empty (off) | Online sources to enable. Empty disables all of them. One name (`jm`), a comma-separated list (`jm,kavita`), or `all` for everything in `lib/sources/sources.json` |
| `NOVEL_DIR` | empty | Absolute path to a novels directory; omit to hide the "Novels" library |
| `DECRYPT_PASSWORD` | empty | Password for encrypted PDFs. Can also be set in the admin panel (stored in `DATA_DIR/settings.json`, takes precedence). Never sent back to the browser; masked as `***` in the audit log |

## File permissions

The container runs as uid/gid 1000 and needs read access to the comics directory and write access to the data directory:

```bash
sudo chown -R 1000:1000 ./data        # data directory (skip if using a named volume)
sudo chmod -R a+rX /path/to/comics    # comics directory
```

You can also change the runtime identity with `user: "uid:gid"` (compose) or `docker run --user`.
Typical symptoms of wrong permissions: `EACCES` during cover generation, progress not saved, `Permission denied` in logs.

## Health check

The image ships a `HEALTHCHECK` probing `GET /healthz` (unauthenticated, no disk access):

```bash
curl -s http://127.0.0.1:3000/healthz
# {"ok":true,"version":"1.5.0","uptime":12,"scanReady":true,"online":false}
```

## Upgrading & backup

```bash
docker compose pull && docker compose up -d
```

All data lives in `DATA_DIR` (the `comic-data` volume) and is backward compatible. Back it up before upgrading:

```bash
docker run --rm -v comic-data:/d -v $PWD:/b alpine tar czf /b/data.tgz -C /d .
```

## Pluggable online sources

`jm` ships as an example source and is **off by default**: without `ONLINE_SOURCE` the online module is disabled entirely and the app is purely local.

When enabled, the front end offers a source switcher and aggregates search across all enabled sources. Images are proxied and restored server-side (de-obfuscation, referer handling) with SSRF protection and caching.

Adding a source takes two steps: implement the unified interface in a file under `lib/sources/`, then add an entry to `lib/sources/sources.json`. See [ONLINE_SOURCES.en.md](ONLINE_SOURCES.en.md) for the interface and a walkthrough.

## Layout

```
server.js              Express entry point
lib/
  sources/              Online sources: jm.js example, sources.json manifest, index.js registry
  online-image.js       Image proxy (SSRF guard, fetch, cache, decode dispatch)
  scanner / cbz / epub / decrypt / thumbnail ...
  progress / auth / settings / jsonstore ...
public/                Front end (index.html / app.js / reader.js / vendor/pdfjs ...)
```

## Development

```bash
npm install
npm start            # or npm run dev (hot reload); default http://localhost:3000
```

Requires Node.js ≥ 20 (`sharp` ships prebuilt binaries, no local compilation).

## Disclaimer

`jm` is included only as an example implementation of the pluggable source interface.

- Availability of online sources depends on third-party sites and may change or disappear at any time; this project does not guarantee or maintain reachability of any site.
- Follow the laws of your country or region and only access content you are entitled to access.
- Any copyright or compliance responsibility from using online sources lies with the user.
- Online features are off by default; without `ONLINE_SOURCE` the app makes no third-party requests.

## Changelog

### 1.5.0 (2026-10-23)

Added

- Adjacent-page preloading: CBZ/CBR prefetch the next two images, PDF pre-renders the next page; invalidated on zoom or rotation
- `GET /healthz` endpoint plus a Docker `HEALTHCHECK` in the image
- GitHub Actions builds amd64 / arm64 images and publishes them to GHCR
- docker-compose gained `TZ`, `DECRYPT_PASSWORD`, and a reference to the published image

Fixed

- Some EPUBs opened with an empty table of contents: OPF manifest parsing no longer depends on attribute order
- The auto-decrypt watchdog kept running with the switch off; it now honours the setting and only processes new or changed files
- Deleting a comic left its fallback cover behind, accumulating orphan files over time
- PDF range requests did not release the file handle on client disconnect
- Opening another book right after returning to the shelf could be hidden by the previous teardown

Changed

- Docker base image moved to node:22-alpine, shrinking the image from ~1.3GB to ~305MB
- The image ships bsdtar; CBR falls back to it when unrar is missing (CBR was unreadable in containers before)
- Dependencies install with `npm ci` for reproducible builds
- Library cover lookup, scan de-duplication and ETag changes: clients no longer re-download the whole catalogue when nothing changed

### 1.4.7 (2026-10-01)

- Progress and bookmarks survive when a file is deleted or renamed outside the app; shown as "file is gone"
- Admin panel gained an orphan-records view; deletes can preview their impact

### 1.4.6 (2026-10-01)

- Fixed empty shelf pages for non-ASCII usernames (usernames are hashed before entering the ETag)

### 1.4.5 (2026-09-30)

- UI icons replaced with inline SVG (100 spots), no new files or dependencies

### 1.4.4 (2026-09-30)

- Removed redundant content from the README and code comments

### 1.4.3 (2026-09-29)

- Settings API no longer returns plaintext passwords; masked in the audit log; "clear password" added

### 1.4.2 (2026-09-29)

- Removed the built-in default decryption password

### 1.4.1 (2026-09-29)

- Trimmed code comments; added English docs

### 1.4.0 (2026-09-24)

- EPUB annotations / highlights (four colours), stored per book and synced across devices
- AI chapter summaries
- Fixed: tap zones blocking text selection, untagged comics invisible, novel-library PDF typing, EPUB TOC prefixes

### 1.3.0 (2026-09-21)

- Admin audit log; online download list and download history
- Encrypted-PDF detection now reads only the file tail instead of whole files
- Fixed CBZ/CBR paging, cover mix-ups, settings persistence; hardened the image proxy against SSRF
