# Annotations & AI chapter summary

> Introduced in v1.4.0 (2026-09-24). Applies to the EPUB reader.

> 中文版见 [ANNOTATIONS.md](ANNOTATIONS.md)

## What it does

Selecting text in the EPUB reader highlights it like a paper book, optionally with a note
attached, and the toolbar can summarise the current chapter.
Along the way it also fixes a real defect: the page-turn hot zone used to swallow text selection.

## Using it

1. Open any EPUB
2. **Drag to select text** with the mouse or a finger
3. A small toolbar appears: **four colour dots** (yellow / green / blue / pink, one tap to highlight) or **"Add note"**
4. "Add note" opens an input showing the selected text; leave it empty for a plain highlight
5. The annotation button in the toolbar (with a count badge) switches the sidebar to the annotations tab
   - tap an entry to jump to that chapter and scroll to the highlight
   - tap a highlight to edit its note
   - tap the delete button to remove it
6. The "AI" button summarises the current chapter

Annotations live on the server, one file per book, so they survive a refresh and follow you to another device.

## Files involved

| File | Change |
|---|---|
| `server.js` | Annotation storage (`annotationsDir` / `annotationsStore`), four routes, a summary route, and annotation cleanup in `deleteComicFully` |
| `public/js/reader.js` | Toolbar buttons, sidebar tab, floating toolbar, note editor, selection / highlight / list / jump / delete logic |
| `public/js/api.js` | `getAnnotations` / `addAnnotation` / `updateAnnotation` / `deleteAnnotation` on `ComicAPI` |
| `public/css/reader.css` | All annotation styling, plus the `.epub-tap-zone` width fix |
| `public/index.html` | Asset version bumped to `?v=20260924d` |
| `lib/epub.js` | TOC now tolerates a directory prefix in `spine.href` (`OEBPS/xxx.xhtml`) |

> **Deployment note.** On the fnOS instance in use here, `reader.css` and `index.html` are
> **host mounts** (`/vol2/@appdata/fn-comic-reader/`), while `server.js`, `reader.js` and `api.js`
> live in the **container's writable layer** — they are lost when the container is recreated.
> Re-deploy them from this repository after a rebuild.

### Endpoints

```
GET    /api/comic/:id/annotations            list annotations for this book
POST   /api/comic/:id/annotations            create {chapter,text,note,color,occur}
PATCH  /api/comic/:id/annotations/:aid       update note / color
DELETE /api/comic/:id/annotations/:aid       delete
GET    /api/comic/:id/summary/:chapter       AI chapter summary
```

Storage: `DATA_DIR/annotations/<comicId>.json` (`DATA_DIR` defaults to `/app/data`).

## The defect that was fixed on the way

`.epub-tap-zone` was `width: 25%` with `z-index: 5`, sitting on top of the iframe, so
**the outer 25% of the text on both sides could not be selected at all** — a press was read as a page turn.
It now uses an adaptive width, `max(10%, calc((100% - 800px) / 2))`: on a wide screen the zone falls
outside the text column, and on a narrow one it takes at most 10%. Page turning still works from the page buttons in the bottom bar.

## Verification

Driven end to end in a real browser (headless Chrome + CDP with **genuine mouse drags**), 16 steps green:

| Step | Result |
|---|---|
| Login / open EPUB / iframe ready / annotation button | pass |
| Real drag selection (against the left edge of the text, x=184) | `SEL[1949年]` pass |
| Floating toolbar appears | pass |
| Submit annotation → server storage | `STORED:1` pass |
| `<mark>` inside the iframe + badge | `MARKS:1 BADGE:1` pass |
| Sidebar annotation list | "chapter 3 / 1949年 / E2E note" pass |
| **Reload and reopen → highlight persists** | `MARKS:1 title:E2E note` pass |
| Tap a list entry to jump | pass |
| Clean up test data | `CLEANED:0` pass |

## Known limitations

- Highlights are anchored by chapter, original text and occurrence index, so **editing that passage can break the anchor** — irrelevant for a static book.
- Selections spanning several paragraphs are clipped to the first paragraph to avoid breaking the markup.
- The AI summary depends on a model service being configured for the deployment; without one the button reports an error.
