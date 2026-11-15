# Moderation console (`/mod`)

The tier-4 moderation queue from `GET /v1/moderation/queue`
(`apps/api/src/app/modules/moderation/router.py`): one row per version waiting
for a decision, with the paper, category, age and the automated signals a
moderator decides with. `docs/design.md` §4 puts Moderation (tier 4) at `/mod`;
§5.7 describes the queue table.

This feature covers the **queue table**, the **decision detail view** and the
**decision form**. Flags and appeals are a later feature of this same plugin
(`mod-console`); they add files here and link from the detail view.

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

## The decision detail view (`/mod/{versionCid}`)

A queue title opens `/mod/{versionCid}`: the paper on the left, the decision
form on the right (stacked on a phone). `docs/design.md` §5.7 asks for
"action, policy clause (required select), reason (required), preview of what
the author will see" and the statement **"This decision is a public signed
record."**

### Where the paper comes from

A version in `moderation` is not in the public catalog, so `GET
/v1/papers/{id}` answers `404` for it. The detail view reads the version's
signed record from the public `GET /v1/records/{cid}` instead and shows what
the record says: title, authors, categories, version (`sch:…/vN`), licence,
change note and abstract. The route passes the `{cid}`; the browser fetches
the record and the policy clauses after mount, so the server HTML is the shell
and "Loading the paper…" (as on `/mod`).

### The form

| Field | Rule |
| --- | --- |
| Action | Required select: `list`, `hold`, `reclassify`, `reject` or `delist` |
| Policy clause | Required select, every clause from `GET /v1/moderation/policies`; the chosen clause's text and `/policies#MOD-xx` link appear beneath it |
| Reason | Required textarea; published verbatim, whitespace trimmed |
| New category | Required only when the action is `reclassify` (the API's rule) |

The **author preview** is assembled from the same values that will be signed:
the outcome sentence, the reason, the cited clause and — for hold, reject and
delist — "You can appeal once." It updates as the moderator types. The
required-field rules live in `validateDecisionDraft`; `buildDecisionBody`
trims and rejects anything the API's schema would refuse, before the passkey
prompt.

Submitting signs `moderation.decision` with the moderator's device key
(`signRecord`, `prev: null`) and posts it to `POST
/v1/moderation/decisions`. On `201` the form becomes "Decision published",
still stating "This decision is a public signed record.", with **View the
signed record** (`RecordLink`) and a link back to the queue. A dismissed
passkey prompt says nothing was published; a `403` says only a moderator can
record a decision; a `409` repeats the API's conflict reason. The form and its
values stay up after any failure.

**The API decides who may decide.** The page asks a visitor with no session
to sign in (no request is made), and a non-moderator's decision is refused
with `403` by the API. The tier claim inside a short-lived token is never used
by the page to hide the form.

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
| `queue.ts` | Wire type + validation (`parseQueue`), ordering, formatters, signal wording (`*Signal`), `loadQueue`, `modDetailHref`, error classification. Pure, no React. |
| `queue-table.tsx` | The table: columns, row, signal cells. The paper title links to the detail view. Server-safe. |
| `mod-console.tsx` | The queue page component: header, state machine, notices, empty state, refresh. |
| `decision.ts` | The version record (`parseVersionRecord`, `loadModeratedPaper`), actions and labels, required-field rules (`validateDecisionDraft`), the signed body (`buildDecisionBody`), the author preview (`authorPreview`), the passkey signing and endpoint submit, and one-sentence failures. Pure apart from the default loaders. |
| `decision-form.tsx` | The decision form and published-decision panel: required fields, live author preview, the public-record statement, signing state and failures. Client-only. |
| `mod-detail.tsx` | The detail view: sign-in/failed/loading states, the paper pane, the detail grid and its header. Client-only. |
| `mod-console.css` | Table, signal, notice, detail-grid, form, preview and statement styles; every value is a design token. |
| `index.ts` | Public surface for route files and later console views. |
| `queue.test.ts` | Parsing, ordering, formatting, signals, error classification, request shape, detail hrefs. |
| `mod-console.test.tsx` | Every queue page state in jsdom: table, empty, signed out, 401, 403, failure, retry, refresh, row link. |
| `mod-route.test.tsx` | Server render: shell and loading line, no API call, no flash of sign-in. |
| `decision.test.ts` | Record parsing, action set, required-field rules, body building, preview wording, accepted-response parsing, submit request, error messages. |
| `decision-form.test.tsx` | Required fields, exact public-record statement, live preview, reclassify category, validation, signing/submitting, passkey cancellation and API refusal. |
| `mod-detail.test.tsx` | Signed-out, loading, paper-beside-form, token-store session, 403, retry and 404 states. |
| `mod-detail-route.test.tsx` | Server render of `/mod/{cid}`: shell and loading line, no API call. |
| `mod-console.css.test.ts` | Token-only colours, status tokens on icon/border, focus ring, 44 px targets. |
| `app/(mod-console)/layout.tsx` | Global nav + page shell (`mc-shell`). |
| `app/(mod-console)/mod-console.css` | The shell's width (wider than the reading column). |
| `app/(mod-console)/mod/page.tsx` | `/mod` route: metadata and `<ModConsole />`. |
| `app/(mod-console)/mod/[cid]/page.tsx` | `/mod/{versionCid}` route: metadata and `<ModDetail />`. |

## Not here yet

- The detail view shows the signed metadata and abstract, not a PDF/HTML
  rendition: an unlisted version has no public reading endpoint yet.
- Flags and appeals are a later feature of this plugin.
- On a phone (390 px) the queue table shows Paper and Category without
  sideways scrolling only if a stacked row layout is added; the detail view
  already stacks the form under the paper.
- The global nav has no "Moderation" entry; `components/nav` belongs to the nav
  feature, and a link to `/mod` for tier 4 belongs there.
