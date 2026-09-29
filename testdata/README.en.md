# testdata — a book to check readability after deployment

This directory holds **one real Chinese textbook in both EPUB and PDF form**. Its only purpose is
**verifying that a fresh deployment can actually read a book** — instead of pretending an empty
library or a handful of fake images counts as acceptance.

> 中文版见 [README.md](README.md)

## Files

| File | Size | MD5 | Exercised endpoint |
|---|---|---|---|
| `法理学-第二版-马工程.epub` | 453,197 B | `525fb28a4911b4c52142df309dcd4e42` | `GET /api/comic/:id/epub/toc`, `/epub/chapter/:index` |
| `法理学-第二版-马工程.pdf` | 56,875,980 B | `f0f62f67b0fe484081d2f0d639d996af` | `GET /api/comic/:id/file` (Range), `/api/comic/:id/page/:n` |

- **EPUB** — "Jurisprudence, 2nd ed., Marxist Project", **412 pages of text, 16 chapters + cover and contents**, 19 xhtml files. The text was cross-checked against the PDF's own text layer, so it is a good signal for whether body text renders as readable Chinese or mojibake.
- **PDF** — the same book, 412 pages, **54 MB**, included specifically to exercise Range requests, cover extraction and the chapter outline.

## How to use it

1. Drop both files into any **novel** library directory (the one with `type: novel` in `libraries.json`).
2. Trigger a scan (restart the service or hit the rescan), and confirm both appear in the **novels** section.
   - ⚠️ Key regression: a **PDF in the novel library must be classified as `novel`**, not sniffed to `comic` from its extension. This depends on `lib/scanner.js` passing the sidecar `type` through and `server.js` preferring `metaType`.
3. Open the EPUB:
   - the contents should have **18 entries** (cover + chapters) and **15 chapters**
   - any chapter should render as normal Simplified Chinese, with **no split radicals or substituted characters** such as `讠正` / `氵台` / `纳人`
   - dragging over text should raise the four-colour palette (the v1.4.0 annotations feature)
4. Open the PDF:
   - it should reach page 412, and scrubbing the progress bar should stay smooth
   - the outline should be readable and a cover should be generated

## Notes

- **Why a 54 MB PDF is committed to git**: it is an acceptance sample and has to travel with the repo
  so a fresh clone has something to read. The cost is repository size. If that ever stops being worth it,
  move it to **Git LFS** or a **release asset** and leave a download note here instead.
- The text-repair work behind the EPUB is described in its commit messages; the PDF is a reference copy and its text layer was not modified.
