# Home feed (`features/feed`)

The home page at `/` from `docs/design.md` §5.1: **Latest · Reviewed ·
Following** tabs, a **category** selector and a **sort** selector, and a row
per paper with a serif title, authors, categories, version, age, a two-line
abstract and status chips. **There are no vote counts** — not on the page, not
in the data the page reads, not in the sort options.

```text
Latest | Reviewed | Following            Category: cs.AI ▾   Sort ▾
────────────────────────────────────────────────────────────────────
Can a Meta-Agent Choose the Safer Branch?
M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago
An evaluation framework for whether meta-agents can identify safer…
✓ Reviewed
```

## Where things live

| Path | What |
| --- | --- |
| `src/app/(feed)/page.tsx` | The route (`/`). Reads `searchParams`, fetches the first page on the server. |
| `src/app/(feed)/layout.tsx` | Shell: `GlobalNav`, the page column, `NavTabBarSpacer`. |
| `src/features/feed/feed.ts` | Pure data: URL state, the `GET /v1/papers` request and parse, ages, bylines. |
| `src/features/feed/feed-row.tsx` | `FeedRow` — one paper. Server-safe; the category pages reuse it. |
| `src/features/feed/feed-page.tsx` | `FeedPage` — the client component: tabs, selectors, paging, states. |
| `src/features/feed/feed.css`, `src/app/(feed)/feed-shell.css` | Styles (`fd-*`), design tokens only. |

## URL

`/?tab=latest|reviewed|following&category=cs.AI&sort=newest|recently_reviewed|recently_updated`

Defaults are left out (`/` is Latest, every category, Newest). Anything the API
would refuse — an unknown tab or sort, a category over 64 characters — falls
back to the default rather than becoming a `422`.

## Data

`GET /v1/papers?tab=&category=&sort=&limit=20&cursor=` (catalog plugin, feature
82). The response is parsed field by field (`parseFeedPage`), so a vote, like or
score field in a payload never reaches a row; a body that is not a list is an
error, never an empty feed.

- **Latest / Reviewed** — fetched on the server, so the first HTML already has
  the rows and works without JavaScript. The tabs are real links and the
  selectors a GET form with an **Apply** button inside `<noscript>`.
- **Following** — fetched in the browser only. It lists the caller's own
  follows, and the session token is in browser storage, not a cookie the server
  could forward. A visitor with no session sees "Sign in to follow categories…"
  (linking to `/signin?next=…` back to this view) and no request is made. The
  tab needs the follows plugin (feature 179); until it ships the API answers
  `422` and the page says "Following is not available on this node yet."
- **Show more papers** — keyset pagination with `nextCursor`, appended in
  place, never showing a paper twice. A page that fails keeps what is on
  screen and says so.

With JavaScript the component takes tab and selector changes over: it rewrites
the address with the History API, fetches the new list, ignores an answer that
arrives after a newer choice, and follows the back button (`popstate`).

## Row details

- **Authors** — the list API carries author DIDs and, today, no display names.
  A row shows `name` / `displayName` when the API supplies one and otherwise a
  short DID (`z6Mkha…2doK`). Up to three authors are named; with four or more
  the first two are named and the rest counted (`M. Zhang, A. Okafor, +2`),
  with everyone in the tooltip.
- **Age** — counts from when the paper first appeared (`listedAt`), or from the
  latest listing (`updatedAt`) when sorted by *Recently updated*, so it agrees
  with the order. The API sends UTC timestamps with no zone
  (`2026-11-15T09:00:00`); they are read as UTC, never as the viewer's local
  time. The tooltip has the exact date.
- **Status chips** — the shared `StatusChip` (icon + word). The list API gives
  one status per paper, so one chip; the mock's code, AI pre-review and
  discussion chips need data this endpoint does not return yet.
- **Links** — the title goes to `/p/{id}` (no `sch:` prefix, as for every paper
  URL) and each category to `/c/{category}`.

## Tests

`feed.test.ts` (URL, parse, ages, bylines), `feed-page.test.tsx` (component
behaviour with a stub loader), `feed-route.test.tsx` (the server render with a
stubbed `fetch`), `feed.css.test.ts` (design-system contract: tokens only,
serif title, two-line clamp, no shadows, 44px targets).

The local `tsconfig.json` files exist for the same reason as in the other
features: the app tsconfig sets `jsx: preserve` for Next.js and Vitest's
transform needs `react-jsx`; Vite uses the nearest tsconfig.
