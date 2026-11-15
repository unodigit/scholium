# submit — the /submit wizard

`/submit` is a five-step wizard (docs/design.md §5.4): **1 Files · 2 Details ·
3 Authors · 4 Checks · 5 Sign**. This feature owns it; the route is
`apps/web/src/app/(submit)/submit/page.tsx`, the shell is `SubmitWizard`.

Only **step 1, Files** is built so far.

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
  finished file is a PDF or LaTeX source. With no `onContinue` (no step 2 yet)
  it stays closed and says why.

## For the next steps

`FilesStep` reports the finished files as `SubmitFile[]` — `{ id, path, size,
mediaType, role, cid }`, the shape a manifest is built from — through
`onFilesChange` (whenever that set changes) and `onContinue`.

## Layout

| File | Job |
| --- | --- |
| `limits.ts`, `file-roles.ts` | size limits, formatting, roles by zone and extension |
| `fingerprint.ts` | chunked SHA-256 → raw CIDv1, progress, abort |
| `tus-upload.ts` | one tus upload: resume, retries, `Upload-Cid`, plain-language failures |
| `upload-manager.ts` | the file list and its state machine; no React |
| `use-upload-manager.ts` | binds the manager to React; online, unload and stray-drop handling |
| `files-step.tsx`, `drop-zone.tsx`, `file-row.tsx`, `file-view.ts` | the step's UI and its wording |
| `wizard-rail.tsx`, `wizard-steps.ts`, `submit-wizard.tsx` | the shell and progress rail |
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
