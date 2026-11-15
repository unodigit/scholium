# Paper meta (the Versions and Files tabs)

`VersionsTab` and `FilesTab` are the two metadata tabs of the paper page
(`docs/design.md` §5.2). The paper page mounts them in its 360 px margin
panel; `/meta/{id}[/v{n}]` shows both on a page of their own.

```tsx
import { FilesTab, VersionsTab } from "@/features/paper-meta";

<VersionsTab
  paperId="sch:6sel-2dio-orm6"
  currentVersion={2}
  compareHref={(from, to) => `/p/6sel-2dio-orm6/compare/${from}..${to}`}
/>
<FilesTab paperId="sch:6sel-2dio-orm6" version={2} />
```

`compareHref` is the seam for the paper page's compare view (feature 186):
without it the tab shows no compare action, rather than a dead link.

## Versions

```text
2 versions · newest v2
○ Version 1                                     1 Jan 2026
  First version.
  ✓ Anchored 2 Mar 2027 04:00 UTC   View transaction ↗
○ Version 2  [Current]                          1 Feb 2026
  Fixed the proof of Lemma 2.
  ◔ Anchor pending
```

Oldest first, as the design's `v1 → vN` reads. Each row carries:

- the **change note** the authors signed, or "First version." / "No change
  note was given." — never an empty line;
- the **listed date** (UTC, `1 Feb 2026`);
- the **anchor status**: `Anchor pending` today for every version (the node
  does not timestamp its log on-chain yet), or `Anchored 2 Mar 2027 04:00 UTC`
  once a node sends the anchored form, with the transaction link only when it
  is `https:`. Pending is a **state, not a failure**.

The newest version is marked **Current** unless the page passes
`currentVersion`; when the page shows an older version, the newest is marked
**Latest** instead.

## Files

```text
1 file · CC BY 4.0
paper.pdf                                        ✓ Scan passed
Manuscript · 1 MiB · CC BY 4.0
Download paper.pdf
```

One row per signed manifest entry: path, role (`Manuscript`, `Source`,
`Reproduction log`…), exact size, the version's licence and the sanitizer's
live verdict. A file is linked to `GET /v1/content/{cid}` **only when its scan
passed** — that is the only thing the node serves. Scanning, failed, missing
and unknown files say why in words instead of offering a download that would
fail.

## Where the data comes from

Both are public catalog reads (plugin: catalog, features 80 and 81), through
the shared API client:

| Tab | Read |
| --- | --- |
| Versions | `GET /v1/papers/{id}/versions` → `loadVersions` |
| Files | `GET /v1/papers/{id}/v/{n}/manifest` → `loadManifest` |

`/meta/…` fetches both on the server and passes them as `initial`, so the
first HTML response already has the timeline and the file list. A failed read
is handed down as `initialError`: the tab says what happened and offers **Try
again**, which fetches in the browser. Hosts without server data can leave
both out; the tab loads on mount.

Both components accept `load` (and `FilesTab` `downloadUrl`) for tests or a
different node. Keep injected functions stable — a new one re-runs the effect.

## Reading a node's answer

`parseVersions` and `parseManifest` accept the API's camelCase and snake_case
spellings, and:

- a body that is not a list is an **error**, never an empty tab ("nothing is
  listed" would be a lie when the truth is "we don't know");
- one unreadable row is **dropped**, so a single bad entry cannot take the
  tab down;
- status is read conservatively: an anchor the tab does not recognise is
  pending, and a scan verdict it does not recognise is "Scan unknown" — never
  more trusted than the node actually said.

## Accessibility

- Every verdict has a **word** plus an icon of its own silhouette; colour is
  reinforcement (design.md §9). Scan chips and the anchor line never rely on
  amber vs green.
- Status colour is on icons and borders, never on the text (the 4.5:1 rule in
  `src/styles/README.md`).
- `role="status"` while loading; `role="alert"` for a failure; the retry
  button and download links are at least 44 px tall.
- File meta separators are generated content with empty alt text, so a
  screen reader does not read "dot".
- Spinners stop under `prefers-reduced-motion`; forced-colours maps links,
  icons and borders to system colours.

## Files

| File | Responsibility |
| --- | --- |
| `versions-tab.tsx` | The Version timeline: change notes, dates, anchor status, current marker, optional compare link. |
| `files-tab.tsx` | The file list: path, role, size, licence, scan status, download links. |
| `meta.ts` | Wire shapes, parsers, loaders, endpoints, paper refs and the words/formats. Pure. |
| `paper-meta.css` | Styles; every value is a design token, prefixed `pm-`. |
| `index.ts` | Public surface for the paper page. |
| `*.test.ts(x)` | Parsers, loaders, both components (including SSR), the route and the CSS contract. |
| `app/(paper-meta)/layout.tsx`, `paper-meta.css` | Global nav + page shell for `/meta/…`. |
| `app/(paper-meta)/meta/[...ref]/page.tsx` | The `/meta/{id}[/v{n}]` route: metadata, ref parsing, server fetch, bad-id notice. |
