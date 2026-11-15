# Paper page (`/p/{id}` and `/p/{id}/v{n}`)

The core screen (`docs/design.md` §5.2): the paper on the left, its margin on the
right.

```text
┌──────────────────────────────────────┬───────────────────────────┐
│ ← cs.AI                              │ ? Could not check  Details›│
│ Can a Meta-Agent Choose the Safer…?  │ sch:kosf-osvu-xlev/v1  ⧉  │
│ Mei Zhang · Rafael Silva · Lena H…   │ ◔ Anchor pending          │
│ ○ Preprint · v1 of 1 · CC BY 4.0     ├───────────────────────────┤
│ [ PDF ] [ HTML ] [ Cite ] [Download] │ Reviews (2)   AI  Discuss…│
│                                      │ Versions   Files   Proof  │
│ Abstract                             ├───────────────────────────┤
│ We propose an evaluation framework…  │ …the open tab…            │
│ (max 720 px)                         │ (360 px)                  │
└──────────────────────────────────────┴───────────────────────────┘
```

The feature owns this directory and the route group `app/(paper-page)/`. The two
route files are two lines each; everything they do is in `paper-route.tsx`.

| URL | Shows |
| --- | --- |
| `/p/k3f9-q2xz-7mwd` | the newest listed version |
| `/p/k3f9-q2xz-7mwd/v2` | version 2 |
| `/p/k3f9-q2xz-7mwd/compare/1..2` | the paragraph diff between versions 1 and 2 |

The `sch:` prefix is optional (`/p/sch%3Ak3f9-…` works), the id is case-insensitive,
and a record cid is accepted too, because a search hit without a short id links to
it. Only the *shape* is checked: whether the paper exists is the API's answer, so a
mistyped id gets "No paper with that id is listed on this node." rather than a parse
error.

## What it is made of

| Piece | File | Rendered |
| --- | --- | --- |
| Header: title, authors, status chip, `v2 of 2`, licence | `paper-header.tsx` | server |
| Actions: PDF, HTML, Cite, Download | `paper-actions.tsx` | server |
| Reading column (≤ 720 px): abstract, then the text | `reading-column.tsx` | server |
| Paragraphs with margin markers, the `A` shortcut and typeset math | `reading-text.tsx` | client island |
| Which rendition shows (HTML or PDF); the PDF and HTML actions' state | `reading-view.tsx` | client islands |
| The PDF, drawn by PDF.js | `pdf-view.tsx` | client island |
| Margin panel (360 px): badge, tabs | `margin-panel.tsx` | client island |
| Compare view: both change notes, changed/added/removed paragraphs | `compare-view.tsx` | server |
| Reads | `paper-page-data.ts`, `compare.ts` | server |

The page is server-rendered, so a shared link shows the title, the byline, the
abstract and the Reviews tab in the first HTML response, before JavaScript loads.

### The six tabs

The tabs are the components of the features that own them; this feature only
places them and hands them data.

| Tab | From | Given |
| --- | --- | --- |
| Reviews | `paper-reviews` | the version id and the reviews the server read |
| AI | `paper-ai` | the version id (it reads its own report in the browser) |
| Discussion | `paper-discussion` | the paper, the version's record id, the threads |
| Versions | `paper-meta` | the paper, the version on screen, the timeline |
| Files | `paper-meta` | the paper, the version, the file list |
| Proof | `paper-proof` | the version id (it runs in the browser) |

- **Tabs are addresses.** `#reviews` … `#proof` open a tab, so a link can; the
  Verify badge's `#proof` works; opening a tab updates the address with
  `replaceState`, so the back button leaves the paper instead of stepping through
  tabs.
- **WAI-ARIA tabs.** One `tablist`; only the open tab is in the tab order; arrow
  keys, Home and End move between tabs; each tab owns a `tabpanel`.
- **Tabs cost nothing until opened.** Reviews (the default) and Proof mount at
  once; the others mount the first time they are opened and then stay, so a
  half-written reply survives a trip to another tab.
- **The badge is the Proof tab's verdict.** The Proof tab runs verify-core in the
  reader's browser and reports its state; the badge above the tabs shows it and
  always opens Proof. That is why Proof is mounted from the start. It begins as
  "Checking…" and never claims a verdict the browser has not reached. "Could not
  check" is a state, not a failure.

### Reads

`loadPaperPageData` reads the paper first (title, canonical id, version number, and
the profile name behind each author), then the other five parts together:

| Part | Read |
| --- | --- |
| versions | `GET /v1/papers/{id}/versions` (the "of 2", the anchor line) |
| manifest | `GET /v1/papers/{id}/v/{n}/manifest` (the PDF action, the Files tab) |
| reviews | `GET /v1/papers/{id}/reviews` (the Reviews tab, its count, the chip's count) |
| discussion | `GET /v1/papers/{id}/threads` (the Discussion tab and its count) |
| reading | `GET /v1/papers/{id}/v/{n}/text` (the reading column) |

**The paper decides whether there is a page; everything else is a part.** If the
paper cannot be read the route says why (a message and a link back to search, never
a thrown error). If a *part* fails, that tab shows its own message and a retry
while the rest of the page reads normally. A paper with no reviews answers `404`
for reviews; that is the calm empty state, not an error.

## Layout

| Width | Layout |
| --- | --- |
| ≥ 1280 px | reading column (≤ 720 px, `--reading-column`) beside a sticky 360 px margin panel (`--margin-panel`) |
| below | one column; the panel follows the text |

The drawer between 1024 and 1279 px and the bottom sheet under 1024 px
(`docs/design.md` §10) are a separate feature that builds on this stacking.

## The reading column

The column is the paper itself: the abstract, then the version's text as real
paragraphs (`GET /v1/papers/{id}/v/{n}/text`), each with a margin marker when it
has been annotated. It has two renditions, HTML and PDF, and the header's PDF and
HTML actions choose between them.

### Math (KaTeX)

The text arrives as plain paragraphs, and a paragraph with LaTeX has it written
the way LaTeX writes it. `math.ts` finds the formulas, `math-typeset.ts` typesets
them, and `reading-text.tsx` runs that once the page is running.

| Written | Shown |
| --- | --- |
| `\( … \)` and `$ … $` | inline |
| `\[ … \]` and `$$ … $$` | display (its own line; scrolls sideways if wider than the column) |
| `\$` | a dollar sign |

- **Prices stay prices.** `$ … $` follows pandoc's rules (the opening `$` is
  followed by something other than a space; the closing one does not follow a
  space and is not followed by a digit), and an unescaped `$` never occurs inside an
  inline formula, so "it costs $5 to $10, but $x$ is free" has one formula in it.
  A delimiter with no partner is the text it was. Nothing is ever dropped.
- **The first HTML has the LaTeX as written.** A shared link, a crawler and a
  reader with no JavaScript get every word and every formula in source form; the
  browser then swaps each formula for KaTeX's markup (HTML for the eye, MathML for
  assistive technology, docs/design.md §9).
- **KaTeX loads only when a paragraph has math** (its own chunk). If it cannot be
  fetched, the LaTeX stays.
- **A formula that cannot be typeset is shown as written**, delimiters and all,
  not as a red error and not half-rendered. That covers a parse error and also a
  command that needs trust (`\href`, `\url`, `\includegraphics`): those are refused
  (KaTeX would draw a red command name and drop the arguments), because an uploaded
  paper must not be able to put a link or a request in the page. Sizes are capped at
  10 em and macro expansion is bounded, so `\rule{1000em}{1000em}` cannot paint a
  page-sized box over the paper and a macro bomb cannot hang the tab.
- **It is safe to repeat.** Typeset paragraphs are marked and skipped on a re-run;
  a paragraph whose text React replaces loses its mark and is typeset again. The
  DOM edit is safe because the annotation component renders each paragraph as a
  `<p>` whose one child is a string, which React replaces whole or not at all.

### The PDF view (PDF.js)

Choosing **PDF** swaps the column's HTML for the version's PDF, drawn by PDF.js.

- **One page, one canvas, drawn as it comes near and let go of when it is far.**
  Pages are stacked down the column, each holding its place (the first page's shape)
  from the start. A page is drawn when within a screenful of the viewport and its
  canvas is freed when it leaves that zone (a retina page at the column's width is
  about 11 MB), then drawn again if the reader returns. A long paper therefore costs
  what is near the reader, not what it contains. Each canvas is "Page 3 of 12" to a
  screen reader. The bar above says how many pages there are and that the HTML has
  the text: the canvas view is pictures of the pages, not selectable text.
- **PDF.js loads only when the PDF is first chosen** (it and its worker are large,
  and are never imported while the page is server-rendered). It parses and draws in
  its worker, with `eval` off, because the file is an untrusted upload.
- **The HTML is never unmounted.** The PDF swaps it for a `hidden` copy, so a
  half-written annotation and the reader's place survive a look at the PDF. The
  PDF is mounted the first time it is chosen and then stays, so going back and
  forth does not fetch it again.
- **The view is an address.** `#pdf` shows the PDF, `#reading` the HTML. Choosing
  the PDF replaces the address (as the margin tabs do), so the back button leaves
  the paper; going back to an address with no fragment shows the HTML. A fragment
  that names neither (a tab, a paragraph) leaves the view alone.
- **It fails in a sentence, with a way out.** PDF.js not loading, a file the server
  no longer has, a file that is not a PDF, a password-protected one: each says so
  in plain words (never PDF.js's own message), and the bar always offers "Open in a
  new tab", with a "Try again" button beside an error. One page that cannot be
  drawn says so on that page; the others still draw.

## The four actions

Each is a real link, so the row works before any JavaScript runs.

- **PDF** — the version's PDF from the node's content endpoint. As a plain link it
  opens in a new tab. Once the page runs, a plain click shows the PDF in the reading
  column instead (above). Anything that is not a plain click (ctrl/cmd/shift/alt,
  middle or right button) still gets the file, and so does a phone (under 640 px):
  there the PDF opens in the device's own viewer, which zooms and selects text
  better than a canvas can (docs/design.md §10). The words a screen reader hears
  after "PDF" say which of the two it will do. If the PDF cannot be opened (no PDF,
  still scanning, scan failed) the word stays, dashed, with the reason beneath it.
  What the browser does with the file is the content endpoint's call: it serves
  files inert (`Content-Security-Policy: sandbox`, `nosniff`), and a file uploaded
  with no declared media type comes back as `application/octet-stream`.
- **HTML** — the rendition the page starts on; marked as the current view; jumps to
  the reading column, and brings the HTML back from the PDF view.
- **Cite** — `GET /v1/papers/{id}/v{n}/cite?format=bibtex`: BibTeX of the exact
  version on screen.
- **Download** — `GET /v1/export/paper/{id}.car`: the whole paper's archive.

Cite and Download are plain links for now. The Cite dialog (BibTeX and RIS, copy)
and the Download menu replace those two elements and keep the endpoints.

## The compare view

The Versions tab offers **Compare v1 with v2** for each adjacent pair
(`features/paper-meta`'s `compareHref` seam; the paper page supplies
`comparePagePath`). It opens `/p/{id}/compare/{from}..{to}`: the node's
paragraph-level diff from `GET /v1/papers/{id}/compare?from=1&to=2`.

```text
Compare v1 with v2
Can a Meta-Agent Choose the Safer Branch?          (links to v2)
1 paragraph changed, 1 paragraph added and 1 paragraph removed between v1 and v2.

Change notes
  Version 1   First version.
  Version 2   Names the adversarial baseline in section 3.2.

Changed paragraphs (1)
  Changed paragraph
  In v1   Multi-agent systems choose between candidate plans.
  In v2   Multi-agent systems increasingly choose between candidate plans.

Added in v2 (1)      Removed from v1 (1)
```

- **The node does the diff.** The page renders its three lists — changed
  (paired old and new), added and removed — and both change notes. It does not
  diff text itself, so "changed" means what the node computed.
- **A reading surface, not a code diff.** Paragraphs use the reading serif at
  the reading size at the 72-character measure, in one column. Old and new
  sides are stacked, so a paragraph is never squeezed into half a line.
- **Words first.** Each section and row says what it is; old text is a real
  `<del>` and new text a real `<ins>`, with `--critical-soft` /
  `--verified-soft` tints and a border as reinforcement (docs/design.md §9).
- **No difference is a result.** Two versions with the same paragraphs say so
  in one calm sentence, rather than showing an empty page.
- **The diff decides the page; the title decorates it.** The paper's title is a
  second, optional read: if it fails, the comparison still renders.
- **Failures have a way back.** A malformed address, a version the node does
  not hold, or a node that cannot be reached says so and links to the version or
  back to search — never a thrown error.

## Not here (other features)

Status banners above the title (Retracted, Corrected, newer version, content
removed); the Cite dialog and Download menu; the drawer and bottom sheet; Invite
reviewer. Until the banners land, a retraction or correction is shown by the
status chip only.

The PDF view has no text layer (no selecting or searching inside the canvas) and no
zoom of its own; the HTML has the text, and "Open in a new tab" has the browser's
viewer. Both are additions to the viewer, not changes to anything above.

## Dependencies

The reading column needs `katex` and `pdfjs-dist` in `apps/web/package.json`
(`katex` ships its own types). `katex/dist/katex.min.css` is imported by
`reading-text.tsx`; PDF.js's worker is found with
`new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`, which the
bundler turns into an emitted asset.

## Tests

`npm test --workspace apps/web`. The route tests render the real route files
against a stubbed node (`paper-page-fixtures.ts`); `margin-panel.test.tsx` covers
the tab mechanics with the six tabs stubbed; `paper-page.css.test.ts` pins the
tokens, the 720/360 widths, focus rings and touch targets.

| Test | Covers |
| --- | --- |
| `math.test.ts` | the four delimiters, prices, escapes, unmatched delimiters, "never loses text" |
| `math-typeset.test.ts` | KaTeX itself in jsdom: MathML, fallbacks, refused commands, idempotence |
| `reading-text.test.tsx` | typesetting through React, the annotation shortcut still working on a typeset paragraph |
| `pdf-render.test.ts` | canvas sizing and the pixel cap, the sentence for each PDF.js failure |
| `pdf-view.test.tsx` | the viewer against a fake PDF.js (`pdf-fixtures.ts`): lazy drawing, errors, retry, teardown |
| `reading-view.test.tsx` | the view switch: plain vs modified click, phones, the address, the HTML staying mounted |
| `compare.test.ts` | the compare body's camelCase/snake_case shapes, dropped rows, the error for "not a diff", the summary's words |
| `compare-route.test.tsx` | the real compare route: both notes, changed/added/removed paragraphs, the empty comparison, bad addresses and node failures |

jsdom has no canvas and the real PDF.js needs a browser, so the viewer's tests use
a fake document, and what only a browser can show (the worker loading, pages
actually drawn, KaTeX's fonts) was checked in Chromium against a built app.
