# Moderation console (`/mod`)

The tier-4 moderation queue from `GET /v1/moderation/queue`
(`apps/api/src/app/modules/moderation/router.py`): one row per version waiting
for a decision, with the paper, category, age and the automated signals a
moderator decides with. `docs/design.md` §4 puts Moderation (tier 4) at `/mod`;
§5.7 describes the queue table.

This feature covers the **queue table**, the **decision detail view**, the
**decision form**, and — beneath the queue on the same page — **flags**,
**appeals** and the **panel vote form** (see "Flags and appeals" below).

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

## Flags and appeals (beneath the queue on `/mod`)

`ModCases` renders two sections after the queue: **Flags** and **Appeals**. It
is a *sibling* of `ModConsole` in `app/(mod-console)/mod/page.tsx`, not part of
it, on purpose: the queue answers `403` below tier 4 and that ends the queue's
view, but a panel is drawn from **tier 3 as well as tier 4**
(`appeals/panel.py`), so a reviewer who is not a moderator still has to reach
their vote. Each section loads, fails and retries on its own. A visitor with no
session sees nothing from `ModCases` (the queue's "Sign in to continue" covers
them) and nothing is requested for them.

### What the API gives us, and what it does not

Written against the API as it is, not as the spec imagines it:

| Need | Endpoint | Status |
| --- | --- | --- |
| Cast a panel vote | `POST /v1/appeals/{cid}/votes` | **Exists** (feature 76) |
| Read one flag | `GET /v1/flags/{id}` | **Exists** (feature 78); reporter or tier 4 |
| List appeals | none | **Missing.** Read from the public log instead (below) |
| List flags | `GET /v1/flags` | **Exists**; tier 4 only, open flags by default (`?state=`, `?target=`). An older server answers `404`/`405` and the console degrades honestly (below) |
| Which members hold a seat | none | **Missing.** The vote's `403` is the only signal (below) |

`GET /v1/moderation/queue` lists versions, not flags: flags reach moderators
through `GET /v1/flags`. A moderation decision on a flagged target settles that
target's open flags (`pending` → `decided`, with the decision's cid), so they
leave the list.

### Appeals: read from the public log

Every `appeal`, `appeal.decision`, `moderation.decision` and `paper.version` is
a public record. `loadAppealCases` replays `GET /v1/sync/range` (public, no
token, `limit=1000` per page, `no-store`) and `buildAppealCases` joins them:

| Record | Gives the card |
| --- | --- |
| `appeal` | grounds, appellant, filed date, the cid a vote is cast on |
| `appeal.decision` (`target` = appeal cid) | the panel's outcome and reasons; its presence **closes** the appeal |
| `moderation.decision` | what was appealed: action, clause, reason, moderator |
| `paper.version` | title and `sch:…/vN` |

An appeal with no `appeal.decision` is **open**. Open ones come first (oldest
first), then decided ones (latest first). An appeal whose decision or paper is
not in this server's log is still shown, with that part marked as missing: a
gap in the log is never a reason to hide something a panel must decide.

The replay stops after 200 pages (200 000 entries) and says so (`truncated`)
rather than silently dropping later appeals. A full page whose `seq` does not
advance is refused as a malformed log, not retried for ever. Replaying a whole
log in the browser is the cost of there being no list endpoint; see "API gaps".

### The panel vote form

Each open appeal carries the form: **outcome** (required; uphold, overturn,
modify or send back to the moderators — each an outcome the API accepts) and
**reasons** (required). `POST /v1/appeals/{cid}/votes` takes `{outcome,
reasons}` with the account's bearer token; the voter is the token's DID, so
the body never says who is voting, and **no passkey signature is involved**
(unlike a moderation decision, the *node* signs the panel's `appeal.decision`).

The API only needs an outcome; the form also requires reasons, because the
panel's decision publishes each member's vote and reasons (`votes` in the
`appeal.decision` body). The form says so beside the fields: "The panel's
decision is a public signed record. It includes each member's vote and
reasons."

**The API decides who holds a seat.** No endpoint names the three drawn
members, so the console cannot hide the form from everyone else. It offers the
form on every open appeal and lets the API answer:

| Answer | What the form does |
| --- | --- |
| `200`, one vote | "Your vote is recorded", "N of 3 members have voted", **Change my vote** (the API keeps a member's latest vote) |
| `200` with `decision` | "The panel has decided", the outcome, a link to the signed record; no change button; the card turns "Decided by the panel" at once |
| `403` | The form is replaced by a plain note: "You do not hold a seat on this appeal's panel." Not an alert, because for most visitors it is the expected answer |
| `401` | An alert with a sign-in link; the form and what was typed stay |
| `409` | "No panel has been seated yet" (too few eligible members); the form stays |
| `503` | "Two members agree, but this server has no signing key… Your vote is saved" — the API keeps the vote and decides on the next one |
| `422`, network, other | The API's sentence, or a plain one; the form stays |

### Flags

Flags are moderator-only. The Flags section has two reads:

- **The list**, `GET /v1/flags`, in the same item shape `GET /v1/flags/{id}`
  returns: the open flags, tier 4 only (`?state=decided|all` and `?target=` filter
  it; this section asks for the default). A server without the route answers
  `404`/`405`, which is its own failure kind (`unsupported`): the section says
  "This server does not list flags yet" in a note. It never shows "No flags are
  waiting" for a list it could not read, because that would claim the opposite
  of what is known.
- **Open a flag by its id**, `GET /v1/flags/{id}`, which also reads a decided
  flag and the cid of the decision that settled it. A `404`
  reads "No flag with that id is on this server" (the API answers a flag the
  caller may not read the same way, so ids cannot be probed).

A flag card shows the reason, the flagged record (with **View the flagged
record**), the reporter, the flag id and where it stands. An open flag links
to **Decide on it** (`/mod/{target}`, the existing decision view, which reads
the target's signed record); a decided one links to its decision record.

A `403` on flags is an expected condition for a tier-3 panel member and is
shown as a note with their tier, not an alert.

### API gaps (what would make this simpler and cheaper)

The web feature cannot add these (they belong to other plugins); they have been
reported as shared edits:

1. ~~`GET /v1/flags` for tier 4~~ — now served (see "Flags" above).
2. `GET /v1/appeals` (and ideally `viewer_on_panel: bool` per appeal, from
   `appeal_panels`): replaces the log replay, and would let the form show only
   to the members who are drawn instead of to everyone.

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
| `wire.ts` | Small `unknown` → clean-value readers (`readText`, `readReasons`, `formatDate`) shared by the modules below. |
| `flags.ts` | Flag shape (`parseFlag`, `parseFlags`), `loadFlags`/`loadFlag`, status wording, and `classifyFlagsError` (including the `unsupported` kind). Pure, no React. |
| `appeals.ts` | Log replay (`loadAppealCases`), the join (`buildAppealCases`), outcome and action wording. Pure apart from the loader. |
| `panel-vote.ts` | The four vote outcomes, required-field rules, request body, `castPanelVote`, and `describeVoteError` (`signed-out` / `not-seated` / `error`). |
| `appeal-vote-form.tsx` | The panel vote form and its recorded / decided / not-seated states. Client-only. |
| `appeal-card.tsx` | One appeal: decision appealed, grounds, record links, then the panel's decision or the vote form. |
| `appeals-section.tsx` | The Appeals section: load/failed/ready states, counts, refresh, truncation note. |
| `flags-section.tsx` | The Flags section: list states, flag cards, and the open-by-id lookup. |
| `mod-cases.tsx` | Mounts both sections once there is a session; renders nothing for a signed-out visitor. |
| `index.ts` | Public surface for route files and later console views. |
| `queue.test.ts` | Parsing, ordering, formatting, signals, error classification, request shape, detail hrefs. |
| `mod-console.test.tsx` | Every queue page state in jsdom: table, empty, signed out, 401, 403, failure, retry, refresh, row link. |
| `mod-route.test.tsx` | Server render: shell and loading line, no API call, no flash of sign-in. |
| `decision.test.ts` | Record parsing, action set, required-field rules, body building, preview wording, accepted-response parsing, submit request, error messages. |
| `decision-form.test.tsx` | Required fields, exact public-record statement, live preview, reclassify category, validation, signing/submitting, passkey cancellation and API refusal. |
| `mod-detail.test.tsx` | Signed-out, loading, paper-beside-form, token-store session, 403, retry and 404 states. |
| `mod-detail-route.test.tsx` | Server render of `/mod/{cid}`: shell and loading line, no API call. |
| `flags.test.ts` | Flag parsing and ordering, wording, request shape, every failure kind (list vs lookup). |
| `appeals.test.ts` | The log join, ordering, paging, truncation, non-advancing and malformed pages, wording. |
| `panel-vote.test.ts` | Outcomes are API-accepted, validation, body, answer parsing, every vote failure. |
| `appeal-vote-form.test.tsx` | Fields, validation, in-flight lock, recorded/decided states, change vote, 403/401/409/retry. |
| `mod-cases.test.tsx` | Session handling, flags list/unsupported/forbidden/lookup, appeal cards, voting from a card, tier-3 reaches the vote. |
| `mod-console.css.test.ts` | Token-only colours, status tokens on icon/border, focus ring, 44 px targets, flags/appeals rules. |
| `app/(mod-console)/layout.tsx` | Global nav + page shell (`mc-shell`). |
| `app/(mod-console)/mod-console.css` | The shell's width (wider than the reading column). |
| `app/(mod-console)/mod/page.tsx` | `/mod` route: metadata and `<ModConsole />`. |
| `app/(mod-console)/mod/[cid]/page.tsx` | `/mod/{versionCid}` route: metadata and `<ModDetail />`. |

## Not here yet

- The detail view shows the signed metadata and abstract, not a PDF/HTML
  rendition: an unlisted version has no public reading endpoint yet.
- The flag list shows open flags only (the API's default); decided flags are
  reached by id. Appeals are read by replaying the public log until the API
  lists them.
- The vote form is shown on every open appeal, because nothing says which
  members were drawn; see "API gaps".
- On a phone (390 px) the queue table shows Paper and Category without
  sideways scrolling only if a stacked row layout is added; the detail view
  already stacks the form under the paper.
- The global nav has no "Moderation" entry; `components/nav` belongs to the nav
  feature, and a link to `/mod` for tier 4 belongs there.
