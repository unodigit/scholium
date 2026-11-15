# Review form (`/review/[id]`)

The formal review form from `docs/design.md` §5.5: the paper on the left; on
the right the anonymity notice, the conflict check and the rubric form, which
seals the review as a signed `review.commit`.

This feature covers displaying the form (spec feature 165), committing it
(166), and the two actions on a revealed review card — an author's
point-by-point reply and a tier-3 member's quality rating (168; see
[Replying and rating on the review card](#replying-and-rating-on-the-review-card)).
"Sign with my name instead", the stylometry tip and "Cite in review" (167) are
a later feature of this same plugin; it adds files here and extends
`ReviewPage`.

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

## Replying and rating on the review card

`ReviewCardActions` sits at the foot of a **revealed** review card (the
Reviews tab, docs/design.md §5.2) and offers whoever may act one control:

```tsx
import { ReviewCardActions } from "@/features/review-form";

<ReviewCardActions review={review} paperId="sch:k3f9-q2xz-7mwd" />
```

`review` is the Reviews tab's own `Review` (it only needs `reviewCid`, `label`,
`report` and `scores`, so this feature does not import that one).

| Who | Sees | Sent as |
| --- | --- | --- |
| A paper author | **Reply point by point**: an expander with a labelled box for each rubric dimension and a *General reply*. Beside each point, what the reviewer scored it (`Reviewer scored 4 of 5`). | A signed `review.response` to `POST /v1/reviews/{cid}/response` |
| A tier-3 member who is not an author | **Rate this review’s quality**: five radios, each named `N of 5`, and **Send rating** | `{"rating": N}` to `POST /v1/reviews/{cid}/rating` |
| Anyone else, a signed-out reader, or a still-sealed review | Nothing — the card is as it was | — |

**The reply** needs at least one answered point and does not require every
dimension (the API accepts one reply or six); blank points are not sent. It is
signed with the author's **own** device key — not the reviewer's pseudonymous
key — behind one passkey prompt, with `prev: null`, using `signRecord`. The
form says what signing does in the design's words ("You’re signing with your
passkey. Scholium never sees your key.") and, once sent, shows back what was
sent. A reply is sent once, not edited in place.

**The rating** is about the review’s quality, not its verdict, and affects the
reviewer’s reputation only (PRD REV-6). It needs no passkey prompt: the API
takes the plain `{"rating": N}` with the member's access token. The API keeps
**one rating per member per review** (its primary key), so the control offers no
"change rating", and a repeat is explained ("your first rating stands") instead
of being retried.

### Who is offered what — and who decides

The control shown is only a convenience; **the API is the gate**. It answers
`403` to a non-author's reply and to a rating from a lower tier, from the
review's own reviewer, or from an author. So `viewer.ts` reads the signed-in
account's access-token claims (`sub` = their `did:key`, `tier`) **without
verifying them** and uses them only to pick a control:

- **Reply** is offered when the viewer's DID is on the paper's byline
  (`GET /v1/papers/{id}`, public, one shared request however many cards ask).
- **Rating** is offered to a signed-in viewer whose tier is not known to be
  below 3 and who is not an author. An unknown or stale tier is let through,
  because the API reads the *current* tier, not the one in a 15-minute token.
- Whether the viewer *wrote* the review cannot be known — a reviewer's identity
  is escrowed by design — so the API says so ("The reviewer of a review may not
  rate it.") and the card shows that sentence, with **Nothing was sent.**
- While the byline is loading nothing is shown, so a control never appears and
  then vanishes. If the byline cannot be read, the reply form stays out of the
  way and a tier-3 member still sees the rating.

A refusal is shown in the API's own words when it gave any; otherwise in a
plain sentence. Every failure ends with whether anything was sent, and a
session that has ended offers **Sign in**. A failure keeps the draft or the
chosen rating where it was.

### Mounting it on the card

The review card itself belongs to `paper-reviews` (`reviews-tab.tsx`), another
plugin, so this feature ships the component and does not edit that file. The
card mounts it with one line after its replies:

```tsx
import { ReviewCardActions } from "../review-form";

<ReviewCardActions review={review} paperId={paperId} />
```

`ReviewCard` needs `paperId`, which `ReviewsView` already holds. Until that
line is added the Reviews tab shows no reply form or rating.

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
| `reply.ts` | The author's reply: points, draft, the `review.response` body, signing and sending, failure wording. Pure, no React. |
| `rating.ts` | The quality rating: values, sending, failure wording. Pure, no React. |
| `action-errors.ts` | The failure sentences the reply and the rating share (cancelled passkey, ended session, refusal, offline). |
| `viewer.ts` | Access-token claims as a viewer, what to offer them, and the paper's byline. Pure, no React. |
| `use-viewer.ts` | `useViewer` (live from the token store) and `usePaperAuthors` (one shared read). |
| `review-actions.tsx` | `ReviewCardActions`, the reply form and the rating control (client components). |
| `review-actions.css` | Their styles; every value is a design token; prefix `ra-`. |
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
