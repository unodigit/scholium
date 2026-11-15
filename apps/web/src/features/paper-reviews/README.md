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

## Where the data comes from

`GET /v1/papers/{id}/reviews` (feature 110), read anonymously and uncached.
The endpoint serves the paper's resolved listed version; its `{paper_id}` is
one path segment, so `loadReviews` splits off a `/vN` suffix and sends the
paper's own id. The payload's `version` and `versionCid` say which version the
reviews belong to. Report bodies are absent while `gate_open` is false; rubric
scores are always present.

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
| `reviews-tab.tsx` | The panel, summary bar and review cards |
| `reviews-tab.css` | Tokens-only styles (`pr-` prefix) |
| `app/(paper-reviews)/` | The `/reviews/{id}[/v{n}]` route and shell |
