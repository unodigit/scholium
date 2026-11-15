# Network page (`/network`)

The public node transparency page. It renders what `GET /v1/network`
(`apps/api/src/app/modules/network/`, feature 127) says about this node right
now: its DID and federation **standing**, the **head of its record log**
(sequence and entry hash), the state of its **last anchor** (always pending in
this build — a state, not an error), its **replication summary** (`1 of 1
local`), and its **moderation statistics by policy clause**, each clause
linking to the rule it cites on `/policies`.

`docs/design.md` §4 puts Network beside Moderation and Governance; §5.8 makes
it the public transparency page ("nodes with standing, last anchor…;
replication summary; recent moderation statistics by clause"); §1 keeps it
calm — "anchor pending" and "1 of 1 replicas" are states, not errors.

## Rendering

The route is server-rendered and dynamic:

1. `app/(network-page)/network/page.tsx` calls `loadNetworkStatus()` — an
   unauthenticated, `no-store` request — and passes the document to the
   component. The first HTML response therefore contains the whole status, and
   the browser makes no cross-origin API request. It is fetched fresh on every
   request because the log head moves with every record the node accepts.
2. `NetworkPage` renders the document immediately. If the server fetch failed
   it retries once in the browser, so a page served while the API was down can
   still recover; a failure is a retryable notice, never a crash.
3. A malformed body is rejected by `parseNetworkStatus` (missing fields,
   non-numbers, duplicate clause ids) instead of rendering a half-empty
   transparency page.

The page needs no account. Everything on it is public by design.

## The display vocabulary

The words the page shows for machine values live in `network.ts`, not in the
markup:

- `standingSpec("local")` → the chip word **Local** and its calm sentence. An
  unknown standing keeps its raw word and a neutral chip — honest, never
  guessed.
- `anchorSpec("pending")` → **Anchor pending** (amber `--pending` family, the
  ◔ glyph) and "Signed. The public timestamp will be added when anchoring is
  enabled."
- `replicaSegments` → which meter segments are filled (`have` of `of`,
  clamped). The meter is `aria-hidden`: the visible "1 of 1 local" line is the
  state; the bar only pictures it. Status is never colour alone.
- Clause ids link through `policyHref` (`features/policies-page`), the same
  `/policies#MOD-02` anchor a decision banner uses. Never hand-build the
  fragment.
- The node DID renders in the shared `IdPill` (`features/ui-kit`): monospace,
  copies on click, toast says "Copied".

## Files

| File | Responsibility |
| --- | --- |
| `network.ts` | Wire type + validation, `loadNetworkStatus`, the display vocabulary (`standingSpec`, `anchorSpec`, `replicaSegments`, `moderationCountLine`), plain-language errors. |
| `network-page.tsx` | The page component: fact cards (node, log head, anchor, replication), moderation table, loading/empty/error states, client retry. |
| `network-page.css` | Card, chip, meter and table styles; every value is a design token. |
| `index.ts` | Public surface for route files and cross-feature links. |
| `network.test.ts` | Payload validation, display vocabulary and the API request shape. |
| `network-page.test.tsx` | Sections, chips, meter, clause links, empty/loading/error and retry behaviour. |
| `network-route.test.tsx` | The server render: the first HTML contains the whole document. |
| `network-page.css.test.ts` | Token-only colours, chip contrast rules, meter and responsive contracts. |
| `app/(network-page)/layout.tsx` | Global nav + page shell (`np-shell`). |
| `app/(network-page)/network/page.tsx` | `/network` route: metadata, server fetch, error capture. |
