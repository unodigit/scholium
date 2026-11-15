# Review form (`/review/[id]`)

The formal review form from `docs/design.md` §5.5: the paper on the left; on
the right the anonymity notice, the conflict check and the rubric form, which
seals the review as a signed `review.commit`.

This feature covers displaying the form (spec feature 165) and committing it
(166). "Sign with my name instead", the stylometry tip and "Cite in review"
(167), and author replies and review ratings (168) are later features of this
same plugin; they add files here and extend `ReviewPage`.

## What the page shows

| Where | What |
| --- | --- |
| Header | `Reviewing: {title} · v{n}` (the one `h1`), above a `scholium / review / sch:…` kicker. |
| Left | The paper: id pill (click copies), version, categories, abstract, then the full text paragraph by paragraph. Each paragraph carries `data-paragraph-id`, which "Cite in review" will name. |
| Right, top | The anonymity notice, in the design's words: "You are reviewing anonymously. Your identity is hidden from authors, readers and this node. It can be opened only by 3 of 5 integrity committee members in a misconduct case." |
| Right, above the form | **Conflict check** — the three checks for this reviewer, each with an icon and a status word: not an author, no co-authorship in 3 years, different institution. |
| Right | Six rubric dimensions, each five `1`–`5` radios and a **required** justification box; **Confidence** (Low / Medium / High); **Recommendation** (Sound as is / Minor revisions / Major concerns / Fundamentally flawed); the checkbox "I used AI assistance in writing this review (declared on the report)"; a progress line. |
| Right, bottom | **Commit review**. After a successful commit the form is replaced by **Your review is sealed**, the reveal date and the review id. |

Nothing is pre-chosen: every radio starts unselected and the AI box starts
unticked, so every answer is a decision.

The six dimensions, and the confidence and recommendation values, are the ones
`apps/api/packages/record-core/schemas/review.formal.json` names;
`rubric.test.ts` reads that schema, so the form cannot drift from it.

## The conflict check

`conflict.ts` reads `GET /v1/papers/{id}/coi-check`, which answers for the
signed-in caller and names no one else. Each check has a `status` of `pass`,
`fail` or `unknown` and a sentence for the reviewer:

| Status | Shown as |
| --- | --- |
| `pass` | ✓ **Passed**, then the check's label and detail |
| `fail` | ✕ **Conflict**, then the check's label and detail |
| `unknown` | ? **Couldn’t check**, then what profile detail would complete it |

The icon shape differs by state as well as the colour (`docs/design.md` §9).
The check is **advisory**: a conflict is declared with the review; the commit
endpoint decides who may review. A failed conflict check never hides the form.

A signed-out visitor is asked to sign in instead of being shown three empty
rows. A report already fetched elsewhere is shown whether or not the current
render can see the session. Failures offer **Try again**.

## Committing and sealing

`commitReview` (`commit.ts`) does, in order:

1. Validates the rubric — an incomplete review never reaches the passkey
   prompt.
2. Derives the reviewer's **per-paper review key**. The device key signs one
   domain-separated challenge per paper; the deterministic Ed25519 signature is
   hashed into a 32-byte seed (`review-key.ts`). This is the one passkey
   prompt. The review key's `did:key` — not the reviewer's device DID — is the
   commit's `author` and `reviewKey`, so the public record does not name the
   reviewer.
3. Builds the `review.commit` body: `target` (the version cid), `commitment`,
   `nullifier` and `reviewKey`.
   - `commitment` is SHA-256 over the canonical JSON of the `review.formal`
     body that will be revealed later (the rubric plus the target version).
     `canonicalJson` matches Python's
     `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)`,
     which is what `POST /v1/reviews/reveal` recomputes.
   - `nullifier` is derived from the review key's secret seed and the paper, so
     it is stable for one reviewer and one paper and reveals nothing.
4. Signs the record with `signRecord` using the derived key, checks it is a
   `review.commit` with no `prev`, and sends it to
   `POST /v1/reviews/commit` with the access token.
5. Replaces the form with **Your review is sealed** and the reveal date.

The reveal date is the design's promise: a review is revealed with the others
when a second review is committed, or `REVEAL_WINDOW_DAYS` (21) days after the
first commit. The page uses the commit record's `created` plus 21 days; if the
API later reports an earlier reveal date (`revealAt` / `reveal_at`), that wins.
The date is shown in UTC as `14 Dec`, with the full instant in `<time>`, so the
server and browser cannot disagree about the day.

A failed commit says what happened and **Nothing was sent.**, and leaves the
draft in the form: a cancelled passkey, no device key, an ended session
(`401`, with a sign-in link), a refused author or lower tier (`403`), a second
review on the same paper (`409`), an offline API, or the API's own detail.

## Validation

A dimension is complete only with **both** a score and a non-blank
justification (`rubric.ts`, mirroring `POST /v1/reviews/reveal`, which rejects
scores without justification). Problems are shown for a dimension once the
reviewer has left its justification box — not while they are still typing — as
an icon plus words tied to the field with `aria-describedby`. A commit attempt
shows every problem at once, including the missing confidence and
recommendation. The progress line (`role="status"`) says "2 of 6 rubric
dimensions complete · still needed: confidence and recommendation" and changes
only when a dimension, the confidence or the recommendation is completed, so it
does not chatter at a screen reader on every keystroke.

Each score radio is named with its text equivalent ("4 of 5"), so no state
rests on the circle alone (design.md §9).

`toReviewBody(draft)` turns a finished draft into the `review.formal` rubric
body (`scores.<dimension>.{score, justification}`, `confidence`,
`recommendation`, `aiAssisted`) and throws `IncompleteReviewError` otherwise.
`aiAssisted` is not named by the schema (it allows extra properties); it is how
the AI declaration travels on the report and is part of the sealed commitment.

## Layout

- **≥ 1024 px:** two columns. The paper scrolls with the page; the form column
  is sticky below the 64 px global nav and scrolls on its own, so the rubric is
  always at hand while the reader moves through the text.
- **< 1024 px:** one column, paper first, then the notice, the conflict check
  and the form.

## Where the paper comes from

Rendered on the server from two **public** reads (no account, never cached):

1. `GET /v1/papers/{id}` — title, abstract, categories, the newest listed
   version and that version's cid (the commit's `target`).
2. `GET /v1/papers/{id}/v/{n}/text` — that version's paragraphs.

`[id]` is `sch:xxxx-xxxx-xxxx`, with or without the `sch:` prefix, or with the
colon percent-encoded; the checksum is verified. A version id (`…/v2`) is
refused: a review is written against the newest version.

| Situation | What the page does |
| --- | --- |
| Bad id | "That is not a paper id", with the reason. No API call. No form. |
| `404` | "No such paper". No retry (asking again will not list it). No form. |
| Network, `5xx`, or a body that is not a paper | "Couldn't load the paper" with **Try again** (a link back to the same URL). No form. |
| Text fails or is malformed, paper is fine | The abstract and the form are shown, with a note that the full text could not be loaded. A reviewer may hold the PDF. |
| Paper has no version cid | The form is shown but the commit explains which version is missing; nothing is signed. |

A failure replaces the whole split view: a form that does not show what it
reviews would invite a review of the wrong paper. The page sends
`robots: noindex`.

## Files

| File | Responsibility |
| --- | --- |
| `rubric.ts` | Dimensions, options, draft type, validation, progress, `toReviewBody`. Pure, no React. |
| `paper.ts` | Route-id parsing, wire parsing (including the version cid), `loadReviewPaper`, failure wording. Pure, no React. |
| `links.ts` | Review and sign-in URLs, kept tiny so client components do not pull in the loader. |
| `conflict.ts` | Conflict-check wire parsing, status words, summary and failure wording. Pure, no React. |
| `conflict-check.tsx` | The three checks above the form (client component; loads when signed in). |
| `review-key.ts` | Per-paper review key derivation and the nullifier. |
| `commit.ts` | Canonical JSON, the commitment, the commit body, signing/submission and commit failures. |
| `review-form.tsx` | The rubric form and Commit review (client component; holds the draft and the sealed state). |
| `paper-pane.tsx` | The paper on the left. Server-safe. |
| `anonymity-notice.tsx` | The notice. Server-safe. |
| `review-page.tsx` | Header, split view, conflict check, form, and the failure notice. |
| `review-form.css` | All content styles; every value is a design token; prefix `rf-`. |
| `index.ts` | Public surface for later features of this plugin. |
| `*.test.ts(x)` | Rubric, paper loading, conflict check, key derivation, commitment vectors, commit flow, form behaviour, page composition, server render of the route, stylesheet contract. |
| `app/(review-form)/layout.tsx` | Global nav + page shell (`rfs-shell`). |
| `app/(review-form)/review-form-shell.css` | The shell's width (wider than the reading column). |
| `app/(review-form)/review/[id]/page.tsx` | The `/review/[id]` route: metadata, id parsing, loading. |

## Not here yet

- **No Save draft.** The design shows one beside Commit review; this feature
  commits only. A draft is not persisted, so a reload loses it.
- **No reveal flow.** Committing seals the review; `POST /v1/reviews/reveal`
  and its UI are a later feature. The commitment is built now so the reveal
  can match it.
- **No stepped pages under 640 px.** design.md §10 asks for the review form as
  stepped pages on phones; here it is one long column under the paper.
- **No "Open reproduction log"** beside Reproducibility (design.md §5.5), and
  no text-selection "Cite in review" (167).
- The paper is shown as plain paragraphs. Math (KaTeX) and figures are not
  rendered, as the reading text is plain text.
