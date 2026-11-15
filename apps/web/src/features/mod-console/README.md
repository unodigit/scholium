# Moderation console (`/mod`)

The tier-4 moderation queue from `GET /v1/moderation/queue`
(`apps/api/src/app/modules/moderation/router.py`): one row per version waiting
for a decision, with the paper, category, age and the automated signals a
moderator decides with. `docs/design.md` §4 puts Moderation (tier 4) at `/mod`;
§5.7 describes the queue table.

This feature covers the **queue table**. The decision detail view, the
decision form, and flags and appeals are later features of this same plugin
(`mod-console`); they add files here and link from the queue rows.

## What a row shows

| Column | Source field | Reads as |
| --- | --- | --- |
| Paper | `title`, `short_id` | Title, with the `sch:` id beneath in mono |
| Category | `categories` (else `category`) | Every category, `—` if none |
| Age | `age_hours` | `<1 h`, `5 h`, `47 h`, then `2 d`, `3 d 4 h` (the decision target is 48 h) |
| Similarity | `similarity_pct` (0–100) | `42.5%`; `Not checked` before the check has run |
| Unresolved references | `references_unresolved` | `None unresolved` (✓), `3 unresolved` (⚠), `Not checked` |
| Scan | `scan_result` | `Passed` (✓), `Failed` (✕), `Pending`, `Unknown` |
| Account | `new_account` | `New account` (⚠), `Established`, `Unknown` |

Rows are sorted **oldest first** (a queue is worked in arrival order); versions
with no known age go last.

Every signal is an icon plus a word, never colour alone (design.md §9). The
status colour sits on the icon and border, and the words stay in `--ink`.
Similarity is shown as a plain number: the spec defines no "too similar"
threshold, so the table does not invent one. A signal the API did not send is
`Not checked` / `Unknown`, and only a clear pass is drawn as a pass — an
unrecognised scan value never gets a tick.

## Who sees it

**The API decides, not the page.** The tier is a claim inside a 15-minute
access token, so a page that read it could keep a freshly promoted moderator
out (or let a stale one in). `ModConsole` therefore just asks for the queue:

| Situation | What the page does |
| --- | --- |
| No session in the token store | "Sign in to continue", linking to `/signin?next=%2Fmod`. No request is made. |
| `401` (session ended; the client already tried a refresh) | The same sign-in prompt, worded for an ended session. |
| `403` (below tier 4) | "Moderators only", repeating the caller's tier from the problem's `caller_tier` member. No retry button: trying again cannot raise a tier. |
| Network, `5xx`, or a body that is not a list | "Couldn't load the queue" with the cause and **Try again**. |
| `200` with `[]` | The empty state: "Nothing is waiting for moderation." and **Check again**. |
| `200` with entries | The table, a count, and **Refresh** (the table stays up while it refreshes). |

A body that is not a list is an error, never an empty table: an empty table
would say "nothing is waiting" when the truth is "we don't know".

## Rendering

The queue needs the signed-in account's bearer token, which lives in the
browser (`src/lib/api` token store). So, unlike `/policies`, there is nothing
to fetch on the server: `app/(mod-console)/mod/page.tsx` renders the shell and
a loading line, and `ModConsole` fetches on mount. The session is read after
mount (not during render) so the first paint matches the server HTML and a
signed-in moderator never sees a flash of the sign-in prompt. The request is
`no-store`: the queue is live work.

The table is wider than a phone, so it scrolls inside a focusable
`role="region"` frame (keyboard reachable) rather than scrolling the page.

## Files

| File | Responsibility |
| --- | --- |
| `queue.ts` | Wire type + validation (`parseQueue`), ordering, formatters, signal wording (`*Signal`), `loadQueue`, error classification. Pure, no React. |
| `queue-table.tsx` | The table: columns, row, signal cells. Server-safe. |
| `mod-console.tsx` | The page component: header, state machine, notices, empty state, refresh. |
| `mod-console.css` | Table, signal and notice styles; every value is a design token. |
| `index.ts` | Public surface for route files and later console views. |
| `queue.test.ts` | Parsing, ordering, formatting, signals, error classification, request shape. |
| `mod-console.test.tsx` | Every page state in jsdom: table, empty, signed out, 401, 403, failure, retry, refresh. |
| `mod-route.test.tsx` | Server render: shell and loading line, no API call, no flash of sign-in. |
| `mod-console.css.test.ts` | Token-only colours, status tokens on icon/border, focus ring, 44 px targets. |
| `app/(mod-console)/layout.tsx` | Global nav + page shell (`mc-shell`). |
| `app/(mod-console)/mod-console.css` | The shell's width (wider than the reading column). |
| `app/(mod-console)/mod/page.tsx` | `/mod` route: metadata and `<ModConsole />`. |

## Not here yet

- Rows do not link anywhere: the detail view is the next feature of this plugin.
- On a phone (390 px) only Paper and Category fit; Age and the signals are
  reached by scrolling the table sideways inside its frame. That is accessible
  (the frame is keyboard-focusable) but not ideal for a screen whose point is
  the signals; a stacked row layout under 640 px is a possible follow-up.
- The global nav has no "Moderation" entry; `components/nav` belongs to the nav
  feature, and a link to `/mod` for tier 4 belongs there.
