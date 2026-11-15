# submit — the /submit wizard

`/submit` is a five-step wizard (docs/design.md §5.4): **1 Files · 2 Details ·
3 Authors · 4 Checks · 5 Sign**. This feature owns it; the route is
`apps/web/src/app/(submit)/submit/page.tsx`, the shell is `SubmitWizard`.

**Steps 1, Files, 2, Details and 3, Authors** are built so far. `SubmitWizard`
keeps the Files step mounted while later steps are open, so going back finds the
same uploads, and it owns the Details draft and the author roster so stepping
back and forward keeps what was typed.

## Step 1 — Files

Drop PDF and/or LaTeX, optional code and data; every file uploads resumably and
is fingerprinted on the author's device; the size limits are stated before
anything is dropped.

- **Two drop zones.** *Paper* takes a PDF, LaTeX project files, figures or a
  `.zip`/`.tar.gz` of them. *Code and data (optional)* takes anything. Each also
  has a "Choose files" button, so dragging is never the only way in. A dropped
  folder is named in a notice (folders cannot be uploaded as folders).
- **Roles.** `pdf` · `source` · `code` · `data`, picked from the zone and the
  extension, changeable per file (only a real PDF can be the paper PDF). The role
  is also sent as `role` in the tus `Upload-Metadata`; the API stores it and does
  not interpret it.
- **Size limits** mirror `apps/api/.../uploads/limits.py`: **50 MB for a PDF,
  5 GB for any other file**, in binary units (50 MiB = 52,428,800 bytes). The
  server decides "PDF" from the file name or media type; `limits.ts` applies the
  same rule so an oversized file is listed as *Not added*, with both exact sizes,
  instead of failing after a long upload. Empty files and duplicate names are
  refused too.
- **Fingerprint.** The raw CIDv1 over SHA-256 of the file (`bafkrei…`), read in
  4 MiB chunks so a 5 GB file never sits in memory, with its own progress bar.
  It runs *alongside* the upload. The server answers the final `PATCH` with
  `Upload-Cid`; a file is **Uploaded** only when the two agree. A mismatch fails
  the file and Retry starts it over from byte zero.
- **Resumable upload.** tus-js-client against `POST /v1/uploads`, 16 MiB per
  `PATCH`, retried with back-off; the row says *Reconnecting* meanwhile.
  tus-js-client keeps each upload's URL in `localStorage`, so after a crash or a
  closed tab, **adding the same file again continues from the server's offset**
  ("Continuing an earlier upload of this file"). Browsers cannot reopen a file
  by themselves, which is why the file has to be chosen again. Coming back online
  restarts uploads that stopped for want of a connection. If the final response
  was lost, the CID is fetched with the API's documented empty `PATCH`.
- **Limits on concurrency:** 2 uploads and 2 fingerprints at a time.
- **Leaving the page** mid-upload asks the browser to confirm, and a file
  dropped outside a zone is ignored rather than opened (which would end the
  upload).
- **Continue** opens when no file is moving, paused or failed and at least one
  finished file is a PDF or LaTeX source, and goes on to Details.

## Step 2 — Details

Title, abstract, categories and licence — the fields that appear on the paper
page and travel inside the signed record.

- **Title and abstract** are required. The character limits (300 and 5,000) are
  counted beside each field before they are reached. Metadata extraction will
  pre-fill both from the PDF when that lands; `DetailsStep` already takes its
  values from the wizard, so there is one place to add the fill.
- **Categories** are a fixed, grouped list of arXiv-style ids (the record stores
  `cs.AI`, not a display name). At least one is required and at most three are
  allowed; a chosen chip carries a check icon and `aria-pressed`, so selection
  is never colour alone. The plain-language name of each id is read out with it.
- **Licence** is a radio group with **CC BY 4.0 selected by default** (PRD
  PUB-9). Every option explains itself in one line and carries a
  journal-compatibility flag in words and an icon ("Accepted by most journals"
  or "Check your journal"), with a note that this is guidance, not legal advice.
  The picker stores the ids the signed record uses: `CC-BY-4.0`,
  `CC-BY-SA-4.0`, `CC-BY-NC-4.0`, `CC-BY-NC-ND-4.0`, `CC0-1.0`.
- **Continue** names the first thing missing; with no step 3 to go to it stays
  closed and says so. **Back to Files** returns to the same file list.

## Step 3 — Authors

Co-authors by DID, ORCID iD or email, their CRediT roles, the byline order, and
a tracker of who has agreed to be listed.

- **One box to add.** The identifier box takes a DID (`did:key:…`), an ORCID iD
  (`0000-0002-1825-0097`, also pasted as `orcid.org/…` or with the `ORCID:`
  label) or an email, tells them apart by shape and says which it saw while
  typing. An ORCID iD is checked against its ISO 7064 check digit, so a mistyped
  number is refused with that reason. An optional name sets how the author reads
  in the byline. The same person cannot be added twice.
- **The submitter is author 1.** Their DID comes from this device's key
  (`use-submitter-did.ts`); they cannot be removed. If a co-author was added by
  that DID first, the two rows are folded together.
- **Who can be listed.** A signed `paper.version` lists authors by DID, so an
  author added by ORCID iD or email is only a candidate until something matches
  them to an account. The API has no such lookup in this release; they show as
  **Not matched** and block Continue until removed (or re-added by DID).
  `SubmitWizard` and `AuthorsStep` take a `resolveAuthor` prop, the one place a
  lookup plugs in; it also drives the "Looking for an account…" state and a
  **Check again** button.
- **CRediT roles.** All fourteen roles of the taxonomy as toggle chips
  (`aria-pressed` plus a check icon, so a choice is never colour alone), each
  with its one-line meaning read out to a screen reader. At least one role per
  author is required, because a co-author accepts a named role when they
  consent. Roles are stored in the taxonomy's own order.
- **Order.** The list is the byline. Move up and Move down are buttons, so
  reordering never depends on dragging; focus stays on the button that was
  pressed and the new position is announced.
- **Consent tracker.** An avatar, a name and a chip reading **Waiting**,
  **Signed** or **Declined** for each author — an icon and a word, never colour
  alone — under a polite "2 of 3 signed" summary. With no version yet nothing has
  been sent, so everyone is shown as waiting. Pass `consentsFor={{ paper,
  version }}` and the tracker shows the node's real status from
  `GET /v1/papers/{id}/v/{n}/consents`, polling every 15 s while anyone is
  waiting and stopping when everyone has signed or someone declines (which sends
  the version back to draft, in a notice that says so). A failed poll keeps the
  last good report on screen and says it will try again.
- **Continue** names the first thing missing (the submitter's DID, a co-author
  with no DID, an author with no role); with no step 4 to go to it stays closed
  and says so. **Back to Details** keeps everything.

## For the next steps

`FilesStep` reports the finished files as `SubmitFile[]` — `{ id, path, size,
mediaType, role, cid }`, the shape a manifest is built from — through
`onFilesChange` (whenever that set changes) and `onContinue`.

`DetailsStep` reports `DetailsValues` — `{ title, abstract, categories,
licence }` — through `onChange` for the wizard's draft and `onContinue` for step
3.

`AuthorsStep` reports the roster as `DraftAuthor[]` through `onChange`, and
through `onContinue`. `recordAuthors(authors)` turns it into the byline the
signed `paper.version` lists — `{ did, name?, orcid?, creditRoles, position }`
per author, in order. Steps 4 (Checks) and 5 (Sign) plug into `SubmitWizard`
beside the current three: pass an `onContinue` to `AuthorsStep` and render the
new step when `step` becomes `"checks"`. `ConsentTracker` is exported on its own
for step 5 and the post-submit status page.

## Layout

| File | Job |
| --- | --- |
| `limits.ts`, `file-roles.ts` | size limits, formatting, roles by zone and extension |
| `fingerprint.ts` | chunked SHA-256 → raw CIDv1, progress, abort |
| `tus-upload.ts` | one tus upload: resume, retries, `Upload-Cid`, plain-language failures |
| `upload-manager.ts` | the file list and its state machine; no React |
| `use-upload-manager.ts` | binds the manager to React; online, unload and stray-drop handling |
| `files-step.tsx`, `drop-zone.tsx`, `file-row.tsx`, `file-view.ts` | the Files step's UI and its wording |
| `details.ts` | licence options and ids, category groups, the step's rules |
| `details-step.tsx` | the Details form: title, abstract, categories, licence |
| `authors.ts` | CRediT roles, identifier parsing (DID / ORCID / email), the roster's rules, `recordAuthors` |
| `authors-step.tsx` | the Authors form: add, roles, order, lookup state, Continue |
| `consents.ts`, `use-consents.ts` | consent report types and fetch, tracker rows and wording; polling hook |
| `consent-tracker.tsx`, `icons.tsx` | the Waiting / Signed / Declined tracker and its icons |
| `use-submitter-did.ts` | the submitter's DID, from this device's key |
| `wizard-rail.tsx`, `wizard-steps.ts`, `submit-wizard.tsx` | the shell, progress rail and step switching |
| `submit.css` | styles; global design tokens only |

Components are `.tsx`, so `tsconfig.json` here sets `jsx: react-jsx` for vitest
(as `components/nav` does).

## Needs from the API

A browser at the web origin can only upload if the API answers CORS preflights
and exposes `Location`, `Upload-Offset` and `Upload-Cid`. The API has no CORS
configuration yet; the change needed in `apps/api/src/app/main.py` was reported
to the operator rather than made here.

## Tests

`npm test --workspace apps/web` (or `npx vitest run src/features/submit` in
`apps/web`). `tus-upload.test.ts` drives the real tus-js-client against an
in-memory stand-in for the API's tus endpoints.
