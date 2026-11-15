# Paper proof (the Proof tab)

`ProofTab` runs verify-core **in the browser** and shows the plain-language
checklist of `docs/design.md` §5.3, with the technical details and the command
that repeats the check offline.

```tsx
import { ProofTab } from "@/features/paper-proof";
import { VerifyBadge, type VerifyState } from "@/features/ui-kit";

const [state, setState] = useState<VerifyState>("checking");

<VerifyBadge state={state} />
<ProofTab schId="sch:k3f9-q2xz-7mwd/v2" onStateChange={setState} />
```

`/proof/k3f9-q2xz-7mwd/v2` (and `/proof/k3f9-q2xz-7mwd` for the newest version)
shows the same tab on a page of its own. The URL mirrors the paper page's
`/p/{id}[/v{n}]`; the `sch:` prefix is optional. The server only reads the URL:
the first HTML says "Checking…", never a verdict.

## What it shows

```text
✓ Verified in your browser                                 [Re-run check]
✓ Signed by all 4 listed authors
✓ Version history is intact (v1 → v2)
✓ Files match what the authors signed (3 files)
◔ Timestamp anchor pending: the public timestamp will be added within the hour
✓ No retraction or correction on record
▸ Technical details
    Version record  bafyrei…q7x2 ⧉     Manifest  bafyrei…m1ka ⧉
    Anchor          pending            Signer 1  did:key:z6Mk…ab12 ⧉
    Checks run in your browser: chain, signatures, prev_hashes, consents, …
    Verify offline: scholium verify sch:k3f9-q2xz-7mwd/v2 --node https://node ⧉
```

Five header states, the VerifyBadge's: **Verified**, **Signed · anchor
pending**, **Checking…**, **Could not check**, **Verification failed**. The
words come from `ui-kit/verify.ts`, so the badge in the paper header and this
tab always agree (`onStateChange` hands the state up; the check is not run
twice).

## It agrees with the CLI

The PRD asks that "indicator result equals CLI verifier result" (cq-19). Both
verifiers call the same `verify_paper` (Python and TypeScript, pinned to
`apps/api/packages/record-core/vectors/verification.json`) and fold its six
checks into the same five lines with the same rules
(`apps/api/packages/cli/src/scholium_cli/checklist.py`, ported in
`checklist.ts`):

| Line | From | Fails when |
| --- | --- | --- |
| Signed by all authors | `signatures` + `consents` | either failed |
| History intact | `chain` + `prev_hashes` | either failed |
| Files match | `manifests` + the files | manifest failed, or a file differs |
| Timestamp | the node's proof | never (pending or anchored) |
| No retraction | `supersession` | the notice is forged |

A retraction, correction or tombstone is a **warning**, not a failure: the
history still verifies, and the line says so. `checklist.test.ts` runs every
shared vector through the checklist and asserts the verdict is the CLI's exit
code (`failed` exactly for `invalid`). The `authorities` prop is the CLI's
`--authority`: a tombstone applies only if a `did:key` you trust signed it.

## "Could not check" is not a failure

Evidence that something does not match is red and says "Do not rely on it". An
inability to *get* the evidence is grey and says it is not a failure
(`design.md` §5.3): the node cannot be reached, it has no records for that
paper or version (a mistyped id), it sends no signatures, or its log is too long
to replay. `runProofCheck` makes the distinction; it never rejects for a failed
check or an unreachable node, only when its `AbortSignal` fires.

## Comparing the files

The signed manifest says what the files are; whether the bytes a reader would
download match is a separate question, so the tab also fetches each listed file
(`GET /v1/content/{cid}`), hashes it in the browser (raw CIDv1 over SHA-256, the
id the Submit wizard computes) and compares id and size. A mismatch fails the
paper. A file that is not compared (over the 32 MiB download budget, withheld
by the node, a failed download) makes the line a **warning**, "the files
themselves were not compared here", never a pass. Nothing is downloaded for a
paper that already failed.

## Where the records come from

A `ProofSource` (`source.ts`): `loadRecords`, and optionally `loadRecordProof`
and `loadFile`. The default, `createNodeProofSource()`, replays the node's
event log (`GET /v1/sync/range`, paged, at most 100 pages) the way
`scholium verify --node` does, reads the ledger proof
(`GET /v1/records/{cid}/proof`) and file bytes (`GET /v1/content/{cid}`), all
unauthenticated. Pass your own `source` (a stable object) when the paper page
already holds the records.

**Known gap: signatures.** The ledger does not retain `sig` (it is checked at
ingest; `GET /v1/sync/range` and `GET /v1/records/{cid}` serve the seven content
fields only), so records rebuilt from a node today carry no signature. The
default source picks up a `sig` on a log entry if the node starts sending one;
until then a node that sends none at all yields "Could not check: this node did
not send the authors' signatures", rather than a red failure on every paper.
A signed record with a bad signature, or one unsigned record among signed ones,
is still a real failure. Fixing it is an API change (serve `sig`, or an archive
endpoint) and needs no change here beyond a source.

## The anchor

Today the node answers `"anchor": "pending"` for every record, so a paper that
verifies is **Signed · anchor pending**, which is also what the CLI prints (it
never checks the chain offline). `anchor.ts` also reads the anchored form that
`design.md` §5.3 shows (`{ status: "anchored", anchored_at, chain, batch,
tx_url }`) so **Verified** is reachable once the node anchors. The browser does
not check the chain: the technical details say "reported by the node", and
anything unrecognised is read as pending, never as more verified than it is.
The transaction link is rendered only for `https:` URLs.

## The offline command

`scholium verify sch:k3f9-q2xz-7mwd/v2 --node https://node.example`. The design
sketch shows no `--node`, but the CLI reads a bare argument as an archive file;
a `sch:` id needs `--node`. The command always names the version that was
verified, and is shown (open) even when the browser could not check, since that
is when it is most useful. `scholium verify FILE.car` is the fully offline form
for an exported archive.

## Accessibility

- The verdict is a polite `role="status"` region that stays mounted from
  "Checking…" to the verdict, so a screen reader says the result.
- Every line has an icon of its own shape plus a visually hidden word
  ("Passed", "Failed", "Pending", "Warning"); colour is reinforcement only.
- Status colour is on icons, never on text (the `--pending` on `--pending-soft`
  contrast rule in `src/styles/README.md`); forced-colours and
  reduced-motion are handled; targets are at least 44 px.
- Technical details is a native `<details>`: closed when all is well, open after
  a failure or "Could not check".

## Files

| File | Responsibility |
| --- | --- |
| `proof-tab.tsx` | The component: verdict, checklist, technical details, copy controls, re-run. |
| `proof-tab.css` | Styles; every value is a design token. |
| `run-proof-check.ts` | One check, end to end: load, verify, compare files, read the proof, build the outcome. |
| `checklist.ts` | The five plain lines, the verdict, the technical rows, the offline command. Pure. |
| `files.ts` | Manifest lookup and the file comparison (size and CID) with a download budget. |
| `anchor.ts` | Reads the ledger proof (pending or anchored); `https`-only links. |
| `source.ts` | `ProofSource`, the default node source, `ProofUnavailableError`, error wording. |
| `paper-ref.ts` | `sch:` id and route-segment parsing with checksum validation. |
| `proof-fixtures.ts` | Test-only: a genuinely signed paper built with verify-core. |
| `index.ts` | Public surface for the paper page. |
| `*.test.ts(x)` | Vector parity with the CLI, end-to-end checks with real signatures, source, files, anchor, component, route, CSS contract. |
| `app/(paper-proof)/layout.tsx`, `paper-proof.css` | Global nav + page shell for `/proof/…`. |
| `app/(paper-proof)/proof/[...ref]/page.tsx` | The `/proof/{id}[/v{n}]` route: metadata, URL parsing, bad-id notice. |

The node's API is cross-origin from the web app: the browser calls
`NEXT_PUBLIC_API_URL` directly, as the Submit wizard and `RecordLink` do, so the
node must allow the web origin (or be served from the same origin).
