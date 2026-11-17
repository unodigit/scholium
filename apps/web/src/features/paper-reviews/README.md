# Paper reviews (the Reviews tab)

`ReviewsTab` is the paper page's Reviews margin tab (docs/design.md §5.2):
formal reviews as cards under a median-per-dimension summary bar.

```tsx
import { ReviewsTab } from "@/features/paper-reviews";

<ReviewsTab paperId="sch:k3f9-q2xz-7mwd/v2" />
```

`/reviews/k3f9-q2xz-7mwd/v2` (and `/reviews/k3f9-q2xz-7mwd` for the newest
version) shows the same tab on a page of its own. The URL mirrors the paper
page's `/p/{id}[/v{n}]`; the `sch:` prefix is optional.

## What it shows

```text
┌────────────────────────────────────────────────┐
│ Version 2 · 3 reviews · reports sealed         │
│ Report bodies stay sealed until two reviews…   │
│ ┌ Median scores ────────────────────────────┐  │
│ │ Soundness   ███████▁▁  4.0 of 5           │  │
│ │ Evidence    ██████▁▁▁  3.5 of 5           │  │
│ │ …                                         │  │
│ └───────────────────────────────────────────┘  │
│ Reviewer A                                      │
│ Anonymous reviewer · Reviewed 2 Mar 2027        │
│ [✓ Minor revisions]                             │
│ Soundness  ●●●●○  4 of 5                        │
│ Evidence   ●●●○○  3 of 5                        │
│ ▸ Read the report                               │  ← <details>
│ Author reply · v2                               │
│   Soundness  The baseline is named in §3.2.     │
│ ▸ Reply point by point   (authors)              │  ← review-form
│ Rate this review’s quality (tier-3 members)     │  ← review-form
└────────────────────────────────────────────────┘
```

- **A card leads with who and what they concluded.** the reviewer label, the
  recommendation as an icon plus its word (never colour alone), and the date.
- **Every rubric score has a text equivalent.** The five dots are
  `aria-hidden`; `4 of 5` is the value a screen reader reads and the value a
  reader comparing cards scans.
- **The summary bar is the median per dimension.** With an even number of
  reviews the median can be a half point, and `3.5 of 5` is shown rather than
  rounded away. Unrevealed or unscored reviews simply do not contribute.
- **The report is an expander, not a wall.** `<details><summary>` keeps a
  long report out of the way until asked for. While the reveal gate is shut
  the card says so in words instead of showing an empty expander.
- **Author replies travel with the card.** Point-by-point answers
  (`review.response` items, keyed by rubric dimension) are labelled with the
  dimension they answer; a plain reply is shown as prose.
- **A revealed card carries its actions.** The foot of every revealed card
  mounts `ReviewCardActions` from `review-form`: a paper author sees **Reply
  point by point** and a tier-3 member who is not an author sees **Rate this
  review’s quality**. The component offers nothing on a sealed review or to a
  reader who may not act, and the API is the gate for both. See
  `review-form/README.md` for who is offered what.

## Where the data comes from

`GET /v1/papers/{id}/reviews` (feature 110), read anonymously and uncached.
The endpoint serves the paper's resolved listed version; its `{paper_id}` is
one path segment, so a `sch:…/vN` URL first reads
`GET /v1/papers/{id}/versions` and passes that version's **cid**, which the
endpoint resolves to exactly that version. (A percent-encoded slash is decoded
by the server before routing, so the suffix cannot ride in the one segment.)
The payload's `version` and `versionCid` say which version the reviews belong
to. Report bodies are absent while `gate_open` is false.

A revealed review is one whose `revealed_at` is set, never one whose report
happens to be present: the form's written report is optional, so `report` is
`null` for a revealed review that has none. The card shows the rubric with each
dimension's justification, the report when served ("No written report"
otherwise), and a **Revised** marker with an expandable history of earlier
recommendations (version and date) when `history` carries more than the
current review.

The listing of a version also carries each reviewer's newest *revealed* review
of an earlier version, marked by the `version` it targets (a review still sealed
on an earlier version is not listed there). The card says **Review of v1** and
offers its reviewer, and only them, **Update for v{latest}**, which opens the
review form with `?prev=` set to the review they stand on. Who wrote an
anonymous review is escrowed, so which cards are the viewer's own is read from
their dashboard (`review-form`'s `useMyReviews`); a review signed with a name is
the viewer's when the name is theirs. A review counts as revealed by its
`revealed_at` (or its scores), not by its report: a version listed a moment ago
has no review committed on it, so its reports are still sealed and the carried
reviews have none to show.

A `404` is the calm empty state (“No reviews yet… Review this paper”), not a
failure; a transport or server error is shown with *Try again*.

The server route (`app/(paper-reviews)/reviews/[...ref]/page.tsx`) fetches
first and passes `initial`, so the first HTML contains the reviews. Mounted in
the paper page's margin panel without `initial`, the tab loads in the
reader's browser.

## Files

| File | What it owns |
| --- | --- |
| `review.ts` | Wire parsing, labels, medians, score text, dates |
| `reviews-api.ts` | `GET /papers/{id}/reviews`, error classification |
| `reviews-tab.tsx` | The panel, summary bar and review cards (each revealed card mounts `review-form`'s `ReviewCardActions`) |
| `reviews-tab.css` | Tokens-only styles (`pr-` prefix) |
| `app/(paper-reviews)/` | The `/reviews/{id}[/v{n}]` route and shell |
