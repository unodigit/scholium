# Review form (`/review/[id]`)

The formal review form from `docs/design.md` §5.5: the paper on the left; on
the right the anonymity notice, the conflict check and the rubric form, which
seals the review as a signed `review.commit`.

This feature covers displaying the form (spec feature 165), committing it
(166), who the review is credited to — "Sign with my name instead", the
stylometry tip and "Cite in review" (167; see [Signing with your
name](#signing-with-your-name), [The stylometry tip](#the-stylometry-tip) and
[Cite in review](#cite-in-review)) — and the two actions on a revealed review
card, an author's point-by-point reply and a tier-3 member's quality rating
(168; see [Replying and rating on the review
card](#replying-and-rating-on-the-review-card)).

## What the page shows

| Where | What |
| --- | --- |
| Header | `Reviewing: {title} · v{n}` (the one `h1`), above a `scholium / review / sch:…` kicker. |
| Left | The paper: id pill (click copies), version, categories, abstract, then the full text paragraph by paragraph. Each carries `data-paragraph-id` and `data-cite` (the name a citation gives it). Selecting words offers **Cite in review**. |
| Right, top | The anonymity notice, in the design's words: "You are reviewing anonymously. Your identity is hidden from authors, readers and this node. It can be opened only by 3 of 5 integrity committee members in a misconduct case." Beneath it, **Sign with my name instead**. |
| Right, above the form | **Conflict check** — the three checks for this reviewer, each with an icon and a status word: not an author, no co-authorship in 3 years, different institution. |
| Right | Six rubric dimensions, each five `1`–`5` radios and a **required** justification box; **Confidence** (Low / Medium / High); **Recommendation** (Sound as is / Minor revisions / Major concerns / Fundamentally flawed); the checkbox "I used AI assistance in writing this review (declared on the report)"; a progress line. |
| Right, bottom | **Commit review**. After a successful commit the form is replaced by **Your review is sealed**, the reveal date, the review id and **Reveal review**; a revealed review says **Your review is revealed** (see [Revealing](#revealing)). |

Nothing is pre-chosen: every radio starts unselected and the AI box starts
unticked, so every answer is a decision.

The six dimensions, and the confidence and recommendation values, are the ones
`apps/api/packages/record-core/schemas/review.formal.json` names;
`rubric.test.ts` reads that schema, so the form cannot drift from it.

## Signing with your name

A reviewer is anonymous unless they choose otherwise. **Sign with my name
instead** sits beneath the anonymity notice (`docs/design.md` §5.5). Choosing it
replaces the notice's words with what signing means — "You are signing this
review with your name. When the review is revealed it will be credited to you by
name and listed on your public profile." — and the same button now reads **Stay
anonymous instead**. It is one button whose label changes, so keyboard focus
stays on it, and the notice is a polite live region, so the change is read out.

What it does on the wire: the commit seals `"signed": true` inside the
`review.formal` body it commits to. `POST /v1/reviews/reveal` covers `signed`
with a first reveal's commitment, honours it only for the reviewer who sealed
the review (their account DID is proved against the escrow's uniqueness token),
and then lists the review on `GET /v1/profiles/{did}/reviews`. So:

- **The choice is made before committing, and sealed with the review.** The
  notice says so. A first reveal whose body differs from what was sealed —
  `signed: true` added to an anonymous commit, say — is refused by the API
  because the commitment no longer matches. (A later *update* of a revealed
  review is not sealed, and the API lets such an update take a name; this page
  does not offer that.)
- **It stays out of the public commit record.** The `review.commit` carries
  only the pseudonymous review key, the commitment and the nullifier; `signed`
  lives inside the commitment, so a reader of the log cannot tell.
- **`signed` is in the body only when `true`.** An anonymous review's body, and
  so its commitment, is byte-for-byte what it was before the option existed
  (`commit.test.ts` checks both digests against the API's own
  `commitment_digest`). `ReviewDraft.signed` and `ReviewBody.signed` are
  booleans; anything but an explicit `true` stays anonymous.
- **It is fixed while the commit is being signed, and once sealed.** The button
  goes, so what the page says is what the commitment covers. If the commit
  fails the choice is given back, as chosen.
- **The sealed card says it.** A signed review's "Your review is sealed" adds
  "It will carry your name when it is revealed."

The notice (top of the right column), the form (below it) and the paper (on the
left) are siblings in a server-rendered page but must agree, so they share a
small client-side session (`review-session.tsx`: the choice, the form's phase,
and the hand-off for citations). `ReviewPage` mounts one around the split view;
a `ReviewForm` used on its own mounts its own, and a bare `AnonymityNotice` is
the plain anonymous notice with no button, since there would be nothing for the
choice to reach.

## The stylometry tip

While the review is anonymous the form shows the design's hint above the
rubric, with an eye icon: "Tip: avoid phrases that identify you or your lab."
It is there from the start (anonymous is the default) and goes the moment the
reviewer signs with their name, since writing style no longer hides anything;
it returns if they switch back. It is a fixed sentence: the page does not try
to detect identifying phrases, which would promise a protection it cannot give.

## Cite in review

Selecting words in the paper — the abstract or the full text — floats a **Cite
in review** button just under the end of the selection. Pressing it puts the
quote into a justification box:

```text
“We define a safety score for each branch.” [¶ 2 · 3fa9c1d2]
```

- **Where it goes.** The justification the reviewer last had open; the first
  one (Soundness of method) before they have opened any. The quote is added
  after what is already written, on its own paragraph, and nothing the reviewer
  wrote is changed. The box is then focused with the caret at the end, so they
  carry on writing, and a polite live region says where it went ("Quoted ¶ 2 ·
  3fa9c1d2 in the justification for Soundness of method.") — the box may be out
  of sight in the sticky column.
- **What it says.** A quote in curly quotes, whitespace collapsed, cut at a
  word with "…" past 300 characters; then where it is: the abstract is
  `abstract`, a paragraph is `¶ {number} · {first 8 characters of its id}` (the
  number for a reader counting down the paper, the id because it is the
  stable one `data-paragraph-id` carries). A selection spanning paragraphs names
  the first and the last (`¶ 3 · … – ¶ 5 · …`). Only text inside the paper's
  blocks is quoted, so a heading between the abstract and the text never ends
  up in it.
- **It is plain text in the justification.** So it is part of the sealed
  review and shows wherever a justification is shown, with no new field for the
  API or the Reviews tab to learn.
- **When it is offered.** Not while the pointer is down (a drag in progress),
  and not for a selection that reaches outside the paper (into the form). Only
  while the form can still change: not while the commit is being signed, nor
  once sealed. **Escape** dismisses it. A press on the button does not take the
  selection away from the text. The button is placed inside the paper's column,
  so it scrolls with the words it quotes and never runs off either edge.
- **Without a form**, a `PaperPane` on its own offers nothing: there is
  nowhere to cite into.

A citation counts as text in a justification, so a justification made only of a
quote satisfies "required". The rule is still a format check, as it is for any
other text; it does not judge the reasoning.

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

## Revealing

A commit only seals the review: the public record carries the commitment, not
the review. `POST /v1/reviews/reveal` opens it as a signed `review.formal`
whose content hashes to that commitment, and the API refuses a first reveal
until the reveal gate is open (two independent reviews committed on the
version, or `REVEAL_WINDOW_DAYS` after the first).

The sealed card is where the reviewer opens it:

- **The gate is read, then honoured.** Pressing **Reveal review** first reads
  the public `GET /v1/papers/{id}/reviews` for this version's `gate_open`.
  While it is shut the card says so in words ("The report gate is still closed
  for this version…") and signs nothing, so no passkey prompt is spent on a
  reveal the API would refuse. Once it opens the same action signs and sends.
  An unreadable gate (or one about a newer version) still proceeds: **the API
  is the gate**, and a refusal is shown in its own words.
- **The reveal signs with the same per-paper key.** Pressing **Reveal review**
  derives the review key again from the device key (one passkey prompt; the
  seed is never stored), signs a `review.formal` with the sealed content plus
  the commitment (`buildRevealBody`), and posts it to
  `POST /v1/reviews/reveal` with the reviewer's access token. Nothing is sent
  until the record is signed.
- **The content is kept locally until then.** A successful commit stores the
  material the reveal needs — the paper id, version, review cid, reveal date,
  commitment and the `review.formal` body — under
  `scholium.sealed-review.v1:{paperId}` in `localStorage`
  (`sealed-review.ts`). Returning to `/review/{id}` therefore shows the sealed
  card again instead of a blank form, with the reveal action. The entry is
  removed the moment the reveal is accepted. The signing key is not stored:
  it is derived again, from the device key, at reveal time.
- **What it says.** While the gate is read the button reads **Checking…**, and
  while the reveal is signing **Revealing…**. On success the card says **Your
  review is revealed**, that the rubric and report are now public, and names
  the review. A failure says what happened and **Nothing was sent.**, keeps
  the sealed card and the action, and offers **Sign in** when the session has
  ended. The gate's own `409` detail ("The report gate is still closed for
  this version…") is shown as the API wrote it.

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
plugin, so this feature ships the component. The card mounts it with one line
after its replies:

```tsx
import { ReviewCardActions } from "../review-form";

<ReviewCardActions review={review} paperId={paperId} />
```

`ReviewCard` takes `paperId`, which `ReviewsView` already holds. The actions
decide for themselves whether there is anything to show, so the line is
harmless on every card.

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
| `reveal.ts` | The reveal: the `review.formal` body, signing with the per-paper key, `POST /v1/reviews/reveal`, the gate read and reveal failures. |
| `sealed-review.ts` | The committed-but-unrevealed review kept on the device, so a return to the page can reveal it. |
| `review-form.tsx` | The rubric form, Commit review, the sealed card and its Reveal action (client components; hold the draft and the sealed state). |
| `paper-pane.tsx` | The paper on the left. Server-safe; writes each block's `data-cite`. |
| `anonymity-notice.tsx` | The notice and **Sign with my name instead** (client component; reads the session). |
| `identity.ts` | The words for the identity choice and the stylometry tip, so the notice, the form and the sealed card never drift. Pure. |
| `citation.ts` | What a citation says and how it is added to a justification; `citationFromSelection` reads a browser selection. No React. |
| `cite-in-review.tsx` | `CiteInReview`: wraps the paper's text and floats the **Cite in review** button at a selection (client component). |
| `review-cite.css` | The button's styles; every value is a design token; prefix `rc-`. |
| `review-session.tsx` | `ReviewSessionProvider` / `useReviewSession`: the signed choice, the form's phase and the paper-to-form hand-off, shared by the notice, the form and the paper. |
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
| `*.test.ts(x)` | Rubric, paper loading, conflict check, key derivation, commitment vectors (signed and anonymous, against the API's own digest), commit flow, the reveal flow and its gate, form behaviour, the identity choice, selections and citations (real DOM ranges), page composition, server render of the route, stylesheet contract. |
| `app/(review-form)/layout.tsx` | Global nav + page shell (`rfs-shell`). |
| `app/(review-form)/review-form-shell.css` | The shell's width (wider than the reading column). |
| `app/(review-form)/review/[id]/page.tsx` | The `/review/[id]` route: metadata, id parsing, loading. |

## Not here yet

- **No Save draft.** The design shows one beside Commit review; this feature
  commits only. A draft is not persisted, so a reload loses it.
- **No reveal from the dashboard.** `/me` lists a reviewer's sealed and
  revealed reviews; opening one happens on `/review/{id}`, where the sealed
  material is kept. A "Reveal" action on the dashboard card is a later feature.
- **No stepped pages under 640 px.** design.md §10 asks for the review form as
  stepped pages on phones; here it is one long column under the paper.
- **No "Open reproduction log"** beside Reproducibility (design.md §5.5).
- **Cite in review has no target picker.** A quote goes to the justification
  last opened; the reviewer moves it by cutting and pasting. A button at the
  selection cannot offer six destinations without taking focus off the text.
- **No citation chips or links.** A citation is text in the justification; it
  does not link back to the paragraph, and the Reviews tab shows it as typed.
- **No signing an already-revealed review.** The page signs a review as it is
  sealed; taking a name on a later update (which the API allows) is not offered.
- The paper is shown as plain paragraphs. Math (KaTeX) and figures are not
  rendered, as the reading text is plain text.
