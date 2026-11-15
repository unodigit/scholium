# Review form (`/review/[id]`)

The formal review form from `docs/design.md` §5.5: the paper on the left, the
rubric form on the right, and the anonymity notice above the form.

This feature covers **displaying the form** (spec feature 165). The conflict
check, signing and sealing the review (166), "Sign with my name instead", the
stylometry tip and "Cite in review" (167), and author replies and review
ratings (168) are later features of this same plugin (`review-form`); they add
files here and extend `ReviewPage`.

## What the page shows

| Where | What |
| --- | --- |
| Header | `Reviewing: {title} · v{n}` (the one `h1`), above a `scholium / review / sch:…` kicker. |
| Left | The paper: id pill (click copies), version, categories, abstract, then the full text paragraph by paragraph. Each paragraph carries `data-paragraph-id`, which "Cite in review" will name. |
| Right, top | The anonymity notice, in the design's words: "You are reviewing anonymously. Your identity is hidden from authors, readers and this node. It can be opened only by 3 of 5 integrity committee members in a misconduct case." |
| Right | Six rubric dimensions, each five `1`–`5` radios and a **required** justification box; **Confidence** (Low / Medium / High); **Recommendation** (Sound as is / Minor revisions / Major concerns / Fundamentally flawed); the checkbox "I used AI assistance in writing this review (declared on the report)"; a progress line. |

Nothing is pre-chosen: every radio starts unselected and the AI box starts
unticked, so every answer is a decision.

The six dimensions, and the confidence and recommendation values, are the ones
`apps/api/packages/record-core/schemas/review.formal.json` names;
`rubric.test.ts` reads that schema, so the form cannot drift from it.

## Layout

- **≥ 1024 px:** two columns. The paper scrolls with the page; the form column
  is sticky below the 64 px global nav and scrolls on its own, so the rubric is
  always at hand while the reader moves through the text.
- **< 1024 px:** one column, paper first, then the notice and form.

## Validation

A dimension is complete only with **both** a score and a non-blank
justification (`rubric.ts`, mirroring `POST /v1/reviews/reveal`, which rejects
scores without justification). Problems are shown for a dimension once the
reviewer has left its justification box — not while they are still typing — as
an icon plus words tied to the field with `aria-describedby`. The progress line
(`role="status"`) says "2 of 6 rubric dimensions complete · still needed:
confidence and recommendation" and changes only when a dimension, the
confidence or the recommendation is completed, so it does not chatter at a
screen reader on every keystroke.

Each score radio is named with its text equivalent ("4 of 5"), so no state
rests on the circle alone (design.md §9).

`toReviewBody(draft)` turns a finished draft into the `review.formal` rubric
body (`scores.<dimension>.{score, justification}`, `confidence`,
`recommendation`, `aiAssisted`) and throws `IncompleteReviewError` otherwise.
`aiAssisted` is not named by the schema (it allows extra properties); it is how
the AI declaration travels on the report. The form does not call it yet — that
is the commit feature.

## Where the paper comes from

Rendered on the server from two **public** reads (no account, never cached):

1. `GET /v1/papers/{id}` — title, abstract, categories and the newest listed
   version.
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

A failure replaces the whole split view: a form that does not show what it
reviews would invite a review of the wrong paper. The page sends
`robots: noindex`.

## Files

| File | Responsibility |
| --- | --- |
| `rubric.ts` | Dimensions, options, draft type, validation, progress, `toReviewBody`. Pure, no React. |
| `paper.ts` | Route-id parsing, wire parsing, `loadReviewPaper`, failure wording. Pure, no React. |
| `review-form.tsx` | The rubric form (client component; holds the draft). |
| `paper-pane.tsx` | The paper on the left. Server-safe. |
| `anonymity-notice.tsx` | The notice. Server-safe. |
| `review-page.tsx` | Header, split view, and the failure notice. |
| `review-form.css` | All content styles; every value is a design token; prefix `rf-`. |
| `index.ts` | Public surface for later features of this plugin. |
| `*.test.ts(x)` | Rubric, paper loading, form behaviour, page composition, server render of the route, stylesheet contract. |
| `app/(review-form)/layout.tsx` | Global nav + page shell (`rfs-shell`). |
| `app/(review-form)/review-form-shell.css` | The shell's width (wider than the reading column). |
| `app/(review-form)/review/[id]/page.tsx` | The `/review/[id]` route: metadata, id parsing, loading. |

## Not here yet

- **No Commit or Save draft button.** Committing is feature 166 (it signs
  `review.commit` and shows the sealed message); the form only holds the draft.
  A draft is not persisted, so a reload loses it. Because there is no commit,
  confidence and recommendation have no error message yet — the progress line
  says they are still needed.
- **No conflict check** above the form (166), and the page does not check who
  is signed in: a visitor who cannot review sees the form. Refusing a commit
  from a co-author or a non-reviewer is the commit endpoint's job (feature
  107, not in the API yet); the conflict check endpoint
  (`GET /v1/papers/{id}/coi-check`) exists but this page does not call it.
- **No stepped pages under 640 px.** design.md §10 asks for the review form as
  stepped pages on phones; here it is one long column under the paper.
- **No "Open reproduction log"** beside Reproducibility (design.md §5.5), and
  no text-selection "Cite in review" (167).
- The paper is shown as plain paragraphs. Math (KaTeX) and figures are not
  rendered, as the reading text is plain text.
