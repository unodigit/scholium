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
| Paragraphs with margin markers and the `A` shortcut | `reading-text.tsx` | client island |
| Margin panel (360 px): badge, tabs | `margin-panel.tsx` | client island |
| Reads | `paper-page-data.ts` | server |

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

## The four actions

Each is a real link, so the row works before any JavaScript runs.

- **PDF** — the version's PDF from the node's content endpoint, in a new tab. If
  it cannot be opened (no PDF, still scanning, scan failed) the word stays, dashed,
  with the reason beneath it. What the browser does with the file is the content
  endpoint's call: it serves files inert (`Content-Security-Policy: sandbox`,
  `nosniff`), and a file uploaded with no declared media type comes back as
  `application/octet-stream`.
- **HTML** — the rendition on screen; marked as the current view; jumps to the
  reading column.
- **Cite** — `GET /v1/papers/{id}/v{n}/cite?format=bibtex`: BibTeX of the exact
  version on screen.
- **Download** — `GET /v1/export/paper/{id}.car`: the whole paper's archive.

Cite and Download are plain links for now. The Cite dialog (BibTeX and RIS, copy)
and the Download menu replace those two elements and keep the endpoints.

## Not here (other features)

Status banners above the title (Retracted, Corrected, newer version, content
removed); the Cite dialog and Download menu; the drawer and bottom sheet; KaTeX
math and a PDF.js view in the reading column; the compare view; Invite reviewer.
Until the banners land, a retraction or correction is shown by the status chip
only.

## Tests

`npm test --workspace apps/web`. The route tests render the real route files
against a stubbed node (`paper-page-fixtures.ts`); `margin-panel.test.tsx` covers
the tab mechanics with the six tabs stubbed; `paper-page.css.test.ts` pins the
tokens, the 720/360 widths, focus rings and touch targets.
