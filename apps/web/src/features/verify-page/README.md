# Verify a file (`/verify`)

A reader names a version of a paper and drops a file they hold. The page works
out the file's id **in the browser** and compares it with the ids in that
version's signed file list (`docs/design.md` §4: *Docs · Policies · Verify a
file*).

```text
Paper version   [ sch:6sel-2dio-orm6/v2                    ]

┌ - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┐
  main.pdf · 38 B          [ Choose a different file ]
  Your file stays on this device. nothing is uploaded.
└ - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┘

✓ This file matches what the authors signed
  It is main.pdf (manuscript), one of the 2 files signed for sch:6sel-2dio-orm6/v2.

✕ This file does not match what the authors signed
  It is not one of the 2 files signed for sch:6sel-2dio-orm6/v2. Do not rely on it
  as the authors' version.
```

`/verify?id=sch:6sel-2dio-orm6/v2` starts with the id filled in, so a paper page
can link straight to it:

```tsx
import { verifyHref } from "@/features/verify-page";

<a href={verifyHref("sch:6sel-2dio-orm6/v2")}>Verify a file you downloaded</a>;
```

## How a file is compared

A file id is the raw-codec CIDv1 over the SHA-256 of its bytes (`bafkrei…`), the
id the node files the bytes under and the Submit wizard shows. Two files with
one id are byte-for-byte equal, so **only the contents are compared**: the name
on the reader's copy does not matter (a renamed download still matches, and the
page says so). The comparison is exact string equality of canonical ids; there
is no fuzzy matching.

1. The id field is parsed (`version-ref.ts`): optional `sch:` prefix, checksum
   checked by verify-core, version required. A mistyped id is told apart from an
   unknown one.
2. When the id is valid, the version's signed list is loaded:
   `GET /v1/papers/{id}/v/{n}/manifest` (`manifest-source.ts`), public, no
   account. The answer is checked before it is believed: it must name the
   version asked for, and every file must carry a canonical raw file id
   (verify-core's `parseFileCid`). A node that answers for another version would
   turn a genuine file into a "mismatch", so that answer is discarded.
3. When a file is chosen it is read in 4 MiB chunks and hashed incrementally
   (`submit/fingerprint.ts`, the Submit wizard's code), with progress, so a
   multi-gigabyte dataset never has to fit in memory. Choosing another file
   abandons the first.
4. `deriveVerdict` (`verdict.ts`) folds whatever has arrived into one answer.
   The two inputs arrive independently, in either order.

## The answers

| Kind | Look | When |
| --- | --- | --- |
| idle | a hint, no icon | the id or the file is still missing |
| checking | grey ring, "Checking…" | reading the file or loading the list |
| match | green ✓, "This file matches what the authors signed" | the file's id is a signed id |
| mismatch | red ✕, **"This file does not match what the authors signed"** | it is none of them |
| cannot_check | grey ?, "Could not check" / "Could not read this file" | the evidence could not be obtained |

**A mismatch is the only red**, and it is said only when both sides were read.
Not reaching the node, a version it does not hold, an answer for the wrong
version, or a file that cannot be read are all grey and say that this is not a
statement about the file (`design.md` §5.3, the rule the Proof tab follows). A
mismatch also says what to try: the file may belong to another version, and when
a signed file has the same name it says how the sizes differ.

## What it does not prove

This page compares the file with the list the node serves for the version; the
API documents those `path`/`cid`/`size` values as the signed ones. It does
**not** check the authors' signatures. The Proof page does
(`/proof/{id}/v{n}`), and every match or mismatch links to it. Today the ledger
does not retain `sig` (see `paper-proof/README.md`, "Known gap: signatures"), so
a full in-browser signature check is not possible against a node yet; that is an
API change, not something this page can paper over.

## Privacy

The file is never uploaded. The only request is the `GET` for the signed list,
and it carries neither the file nor its name. This is stated on the page, and
`verify-page.test.tsx` asserts it against a stubbed `fetch`.

## Accessibility

- The result is a polite `role="status"` region that stays mounted from the
  first hint to the verdict, so a screen reader says the result when it lands.
  The wrapper is `aria-busy` while checking.
- Every state has an icon of its own shape and the words; the mismatch card also
  has a heavier border. Status colour is on icons and borders, never on words
  (`src/styles/README.md`). Forced-colours and reduced-motion are handled.
- Dragging is never the only way in: "Choose a file" is a real button that opens
  the picker. Several dropped files check the first and say so; a dropped folder
  is named, not turned into an empty file.
- The id field is labelled, and its problem is tied to it with
  `aria-describedby`. Its sentence is hidden while the reader edits the field
  and shown when they leave it (or choose a file), so a half-typed id is not
  scolded.
- Targets are at least 44 px; long ids and file names wrap rather than overflow.

## Files

| File | Responsibility |
| --- | --- |
| `verify-page.tsx` | The page: id field, drop zone, verdict, technical details. |
| `file-drop.tsx` | The single-file drop target and picker. |
| `copy-value.tsx` | A monospace value that copies on click, with the "Copied" toast. |
| `use-file-check.ts` | State: the id, the signed list, the file; runs both loads, aborts the stale. |
| `verdict.ts` | Pure: the answers, their words, `manifestStateFor` (never use a list for a version the reader left). |
| `compare.ts` | Pure: a file's id against the signed ids, and the same-name hint. |
| `manifest-source.ts` | `GET …/manifest`, validation of the answer, reader-facing error sentences. |
| `version-ref.ts` | `sch:…/vN` parsing with checksum, the Proof page link. |
| `verify-href.ts` | `verifyHref()`: `/verify?id=…`. No React, safe for server components. |
| `verify-page.css` | Styles; every value is a design token. |
| `verify-fixtures.ts` | Test-only: a signed list built from real bytes, ids from `paper-proof`'s independent `fileCid`. |
| `*.test.ts(x)` | Parsing, loader validation, comparison, verdicts, the component with real `File`s, the server render, the CSS contract. |
| `index.ts` | Public surface. |
| `app/(verify-page)/layout.tsx`, `verify-page.css` | Global nav + page shell for `/verify`. |
| `app/(verify-page)/verify/page.tsx` | The route: metadata and the starting id from `?id=`. |

The node's API is cross-origin from the web app: the browser calls
`NEXT_PUBLIC_API_URL` directly, as the Proof tab and the Submit wizard do, so the
node must allow the web origin (or be served from the same origin).
