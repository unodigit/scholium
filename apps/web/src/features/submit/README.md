# submit — the /submit wizard

`/submit` is a five-step wizard (docs/design.md §5.4): **1 Files · 2 Details ·
3 Authors · 4 Checks · 5 Sign**. This feature owns it; the route is
`apps/web/src/app/(submit)/submit/page.tsx`, the shell is `SubmitWizard`.

**Steps 1, Files, 2, Details, 3, Authors and 4, Checks** are built so far.
`SubmitWizard` keeps the Files step mounted while later steps are open, so
going back finds the same uploads, and it owns the Details draft, the author
roster and the finished files so stepping back and forward keeps what was
typed. The **New version form** (`/submit/new-version/[ref]`, below) extends a
paper that already exists instead of starting one.

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
  with no DID, an author with no role) and opens step 4, Checks. **Back to
  Details** keeps everything.

## Step 4 — Checks

The version's automated results: **file safety**, **references resolved**,
**similarity** and **metadata match**. All four rows are always shown; a check
that has not run says **Not run yet**, it does not disappear or turn green.

- **File safety** is the sanitizer's verdict on every file of the version's
  manifest (`blobs.scan_status` and the `scan_reports` behind it). Each file
  gets its own chip — **Passed**, **Failed**, **Scanning** or **Not scanned
  yet** — and a failing check is named in plain words ("JavaScript", "embedded
  files", "hidden or near-invisible text", "a path that escapes the archive").
  A failure offers **Replace in Files**, which takes the author back to step 1.
- **References** reads `check_results.references_total` and
  `references_unresolved`: "6 of 10 references resolved". An entry is unresolved
  when it has no DOI or Crossref does not know it; a version with no recognised
  reference list says **Nothing to resolve**. Unresolved references are shown,
  never hidden, and do not block.
- **Similarity** reads `check_results.similarity_pct` and says **Low overlap**,
  **Worth a look** (15% and above) or **High overlap** (30% and above), with a
  sentence explaining that it is a signal for moderators, not a verdict. It does
  not block.
- **Metadata match** reads `check_results.metadata_match`: whether the title in
  Details appears in the text of the PDF's first page. A miss offers **Edit the
  title** and a note to replace the PDF, and blocks until fixed.
- **Live, but quiet when nothing is changing.** `useChecks` asks once, then
  every 5 s while the version is `scanning` or a file is still being scanned,
  and stops when the checks settle. **Check again** asks on demand after a file
  is replaced. A failed request keeps the last report on screen, says it will
  try again, and does not invent a verdict.
- **Before the version exists** (the draft wizard) there is nothing to ask the
  node, so the step says the checks run on the signed version and lists the
  draft files with **Not scanned yet**. Pass `checksFor={{ paper, version }}` —
  the version the node holds, as with `consentsFor` on step 3 — and the step
  shows the version's real results and polls them.
- **Continue** to Sign stays open before the version exists: the checks only
  run on the signed version, so there is no report to wait for, and checks are
  advisory (PRD PUB-4/MOD-1) — they never block signing. The hint still names
  what has not run. With a report in hand (`checksFor`), a failed file safety
  scan or a title that is not on page 1 is named in the hint with the place to
  fix it. With no `onContinue` the button stays closed: there is no step 5 to
  go to. **Back to Authors** keeps everything.

## The consent page — `/consent/[version]`

Where a co-author reviews a version and signs a `coauthor.consent` to **accept**
or **decline** authorship. The route is
`apps/web/src/app/(submit)/consent/[version]/page.tsx`; it only reads the URL and
renders `ConsentPage`, which runs in the author's browser because the signing key
never leaves the device.

- **`[version]` is the id of the `paper.version` record** (`bafyrei…`), the link
  the API's consent notification builds (`notifications/consent.py`). The page
  reads it with `GET /v1/records/{id}`, then asks
  `GET /v1/papers/{genesis id}/v/{n}/consents` for who has answered (the
  report accepts the genesis id in place of the `sch:` id). A link that cannot be
  a record id is refused before the server is asked anything.
- **What you read is what you sign.** A consent signs the id from the link, so the
  page recomputes the id of the record the server sent (verify-core's
  `computeRecordId`) and shows nothing unless it matches ("Do not sign anything
  for it" otherwise). The manifest's file list is checked the same way; if it
  cannot be loaded or checked the version is still shown, with a line saying the
  list is not.
- **What is shown.** Title, abstract, categories, licence, what changed, who
  signed the version and when; the byline as a consent tracker with each author's
  CRediT roles, Waiting / Signed / Declined chip and a "(you)" marker; the files,
  each opening through `GET /v1/content/{cid}` (served only once the safety scan
  has passed); then **Your decision**.
- **Who is offered buttons.** Only an author who is listed on the signed version
  (matched by the DID of this device's key), who has not answered, while the
  version is `awaiting_consent`. Everyone else gets a sentence that says why:
  *no key on this device* (links to `/signin?next=/consent/…` and `/onboarding`),
  *key not listed*, *already answered* (the answer, with a link to the record),
  *version back in draft / past consent*, or *could not read who has signed*
  (signing stays off rather than guessing, with **Try again now**).
- **An answer is final.** The page never offers a second one: a consent is a
  public record, and verify-core counts the first acceptance and every decline,
  so a change of mind would be ambiguous. After a decline the version is back in
  draft, and a re-submission gets a new version and a new link.
- **Decline asks first.** It sends the version back to draft for every author, so
  **Decline authorship** opens a confirmation (focus moves to it); **Keep
  reviewing** returns focus to the button. **Accept authorship** goes straight to
  the passkey prompt, which is the confirmation. An optional public comment
  (500 characters) goes in either record.
- **The record.** `signRecord("coauthor.consent", body, null)` with
  `body = { version, role, decision, comment? }`, then `POST /v1/records`.
  `prev` is `null`: a consent is not a link in the paper's chain, verifiers find it
  by `body.version` (which is why the key is `version`, not `versionCid`), and the
  API's own tests sign it that way. `role` names **every** CRediT role the version
  lists for the author, joined with `, ` and in the listed order (the schema has
  one `role` string; naming only one would quietly narrow what they accepted);
  an author listed with none accepts as `Author`.
- **Failures are said in words.** A dismissed passkey prompt says nothing was
  sent; an expired session offers **Sign in**; a refusal is named; when the
  outcome is unknown (network error, 5xx, 409) the report is read again, and if
  the answer did land the page shows it. A second press while the passkey prompt
  is open does nothing.

`consent-version.verify-core.test.ts` signs real consents with Ed25519 keys and
checks the real `verifyPaper` counts them (accept, decline, missing).

## The New version form — `/submit/new-version/[ref]`

Where an author publishes the **next** version of a paper that already exists
(feature 163). `/submit` signs a `paper.genesis` and starts a paper; this form
signs exactly one `paper.version` whose envelope **`prev` is the cid of the
paper's current latest version** and whose `n` is one more — the only pair the
API's chain check accepts (`apps/api/.../submissions/versions.py` refuses
anything else with `409`). The route is
`apps/web/src/app/(submit)/submit/new-version/[ref]/page.tsx`; `[ref]` is the
paper's `sch:` id (or a record cid), URL-encoded by `newVersionHref` — the
href the paper page's **Submit a new version** action (`NewVersionLink`) uses.

- **Pre-filled from what was signed, not from a summary.** The form asks
  `GET /v1/papers/{id}` which version is the latest listed, then reads that
  version's own record (`GET /v1/records/{versionCid}`) and recomputes its id
  with verify-core before showing anything — an author edits what the previous
  version committed to, or they are editing a claim nobody signed (the same
  rule `/consent` signs under). Title, abstract, categories and licence are
  filled in and edited through the wizard's own `DetailsStep` ("Continue to
  the change note").
- **A change note is required.** The one field a new version must answer:
  what changed, up to 500 characters, counted beside the field. Signing stays
  closed until it is written (and the details are complete).
- **Carried over, and said so.** The byline (names, ORCID iDs, CRediT roles,
  order) and the file manifest are signed exactly as the previous version
  signed them; a "Carried over from version N" card says so in words rather
  than implying files were chosen again. A key that is not on the byline is
  named in a notice, not hidden; whether it may publish is the server's to
  say (its rule is a trust tier, not byline membership).
- **Signing.** `submitNewVersion` signs
  `paper.version` with `prev = latest version cid`, checks the signed record
  really is a `paper.version` carrying that `prev` (a broken signer fails on
  the device rather than forking the timeline on the server), then posts it
  once to `POST /v1/records`. Afterwards the page shows the same status
  tracker as the wizard's Sign step — every listed author is asked to consent
  again — polling `GET /v1/papers/{id}/v/{n}/consents` for the **new** number.
- **A version that landed first.** Two authors editing at once, or this form
  opened before another version landed, means a stale `prev`; the server
  answers `409` and the form says what happened and offers **Load the paper
  again** — a fresh pre-fill that keeps the change note the author typed,
  because what they changed is still theirs to say. A dismissed passkey
  prompt says nothing was sent and can be asked again.

`new-version.test.ts` pins the ref parsing, the checked load, the pre-filled
draft, the record body (`paper`, `n + 1`, carried byline and manifest,
trimmed note), the signer checks and every failure sentence;
`new-version-page.test.tsx` drives the rendered form; and
`new-version-route.test.tsx` pins the server's first HTML (loading, and
never a sign button before the browser has checked the paper).

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
per author, in order.

`ChecksStep` reports through `onContinue` — the last `VersionChecks` when the
node has one, `null` before the version exists — and never holds the author
back: checks are advisory. Step 5 (`SignStep`) is wired into `SubmitWizard`;
after signing, its status tracker polls `GET /v1/papers/{id}/v/{n}/checks`
alongside the consents, shows **Checks pending** while the node answers 404,
and displays the advisory report — the four verdicts, no blockers — once it
lands. The request carries the author's bearer token: while a version is
unlisted (awaiting consent, scanning, in moderation) its report is served only
to its authors and to moderators, and anyone else gets that same 404, so a
tokenless read would show an author nothing. A listed paper's report is still
readable anonymously.
`ConsentTracker` is exported on its own for the post-submit status page.

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
| `consent-tracker.tsx`, `icons.tsx` | the Waiting / Signed / Declined tracker (optionally with roles) and its icons |
| `consent-version.ts` | `/consent/[version]`'s rules, no React: link parsing, loading and id-checking the version, who may answer (`consentGate`), the consent body, signing and its failures in words |
| `use-consent-version.ts`, `use-device-did.ts` | load the version; read this device's DID with a "checking" phase (so "no key" and "not looked yet" differ) |
| `consent-page.tsx`, `consent-page.css` | the page: version, tracker, files, the decision panel |
| `checks.ts` | the check report's types, wire normalisation, fetch, and the four verdicts and blockers |
| `use-checks.ts` | polls the report while the node is scanning |
| `checks-step.tsx` | the Checks step: four results, per-file safety, fix actions, Continue |
| `use-submitter-did.ts` | the submitter's DID, from this device's key |
| `new-version.ts` | the New version form's rules, no React: ref parsing, the checked load, the pre-filled draft, the `paper.version` body (`prev` = latest), signing and failures in words |
| `new-version-page.tsx`, `new-version.css` | `/submit/new-version/[ref]`: the Details step pre-filled, the change note, the carried-over card, sign and the status tracker |
| `new-version-link.tsx` | the paper page's **Submit a new version** action: a server-safe link to the form |
| `wizard-rail.tsx`, `wizard-steps.ts`, `submit-wizard.tsx` | the shell, progress rail and step switching |
| `submit.css` | styles; global design tokens only |

Components are `.tsx`, so `tsconfig.json` here sets `jsx: react-jsx` for vitest
(as `components/nav` does).

## Needs from the API

A browser at the web origin can only upload if the API answers CORS preflights
and exposes `Location`, `Upload-Offset` and `Upload-Cid`. The API has no CORS
configuration yet; the change needed in `apps/api/src/app/main.py` was reported
to the operator rather than made here.

**The paper page's link to the New version form.** The paper page lives in the
`search-page` plugin (`apps/web/src/features/search-page/paper-page.tsx`), so
the one-line edit that renders this feature's `NewVersionLink` there was
reported to the operator rather than made here; the form itself is reachable
at `/submit/new-version/{paper id}` meanwhile.

**Signing.** Everything this feature signs goes through `signRecord`
(`features/web-auth`), which signs the binary **CID bytes**. The API
(`ingest/service.py` → `verify_envelope`) and verify-core check the signature
over the canonical **record bytes** (`record_bytes` / `recordBytes`), so a record
signed by `signRecord` as it stands fails with `401` at `POST /v1/records` — the
Sign step's records, the consent page's and the New version form's alike. The
fix is in `web-auth/sign-record.ts` (sign `recordBytes(envelope)`) and was
reported to the operator rather than made here; the pages work against a real
API once it lands. Their tests inject their own signer, so they do not depend
on it.

Step 4 asks for `GET /v1/papers/{id}/v/{n}/checks`, and the API exposes no such
route yet: the checks plugin writes `check_results` and the sanitizer writes each
file's scan status, but neither mounts a router. The step therefore takes its
fetcher as a prop (`fetchChecks`) and defaults to that path. The response the
step normalises is:

```json
{
  "paper": "sch:xxxx-xxxx-xxxx",
  "version": 1,
  "versionCid": "bafyrei…",
  "state": "scanning",
  "files": [
    { "path": "paper.pdf", "cid": "bafkrei…", "role": "pdf",
      "scan": "failed", "checks": ["javascript"], "detail": "…" }
  ],
  "references": { "total": 42, "unresolved": 3 },
  "similarity": { "pct": 7.4 },
  "metadata": { "match": true, "signedTitle": "…" },
  "checkedAt": "2026-11-15T12:00:00Z"
}
```

The flat `check_results` spellings (`similarity_pct`, `references_total`,
`references_unresolved`, `metadata_match`) and `scan_status` are accepted too,
so the route can return the table's own column names. Until the route exists,
passing `checksFor` against a real node shows "This node does not have that
version yet" rather than an empty report.

## Tests

`npm test --workspace apps/web` (or `npx vitest run src/features/submit` in
`apps/web`). `tus-upload.test.ts` drives the real tus-js-client against an
in-memory stand-in for the API's tus endpoints. `checks.test.ts` pins the wire
normalisation and the four verdicts; `use-checks.test.tsx` pins when the step
polls and when it stops; `checks-step.test.tsx` and `submit-wizard.test.tsx`
drive the rendered step.
