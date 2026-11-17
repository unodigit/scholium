# Network page (`/network`)

The public node transparency page. It renders what `GET /v1/network`
(`apps/api/src/app/modules/network/`, feature 127) says about this node right
now:

- the **operator** and **software version**, its DID and federation
  **standing**;
- the **head of its record log** (sequence and entry hash);
- the state of its **last anchor** (always pending in this build, with the
  sentence "Anchoring is not enabled on this node yet" — a state, not an error);
- the **probe pass rate** over the last 24 hours, or "No probes run yet"
  (`pass_rate` is `null`, never `0`, when nothing ran);
- the **replication summary** (`1 of 1 local`), the **policy target** (5
  replicas, 3 operators, 2 jurisdictions) and how many **listed papers sit at
  each replica health** (`meets_policy`, `below_policy`, `single_copy`) as
  words, counts and a segmented bar. A paper with only this node's copy is a
  *single copy*, never "healthy";
- its **moderation statistics by policy clause**, each clause linking to the
  rule it cites on `/policies`;
- the **incident log** ("No incidents recorded." when empty);
- the **public export**: a link to `/v1/export/archive.car` (on the API's
  origin — the web app does not serve `/v1`) and the two commands that verify
  and rebuild it, `scholium verify archive.car` and
  `scholium rebuild archive.car --db rebuilt.db` (PRD NET-2).

`docs/design.md` §4 puts Network beside Moderation and Governance; §5.8 makes
it the public transparency page ("nodes with standing, last anchor, probe pass
rate; replication summary; recent moderation statistics by clause; incident
log"); §1 keeps it calm — "anchor pending", "1 of 1 replicas" and "No probes
run yet" are states, not errors.

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
   non-numbers, duplicate clause ids, a pass rate outside 0–1, an incident
   without a title) instead of rendering a half-empty transparency page. The
   operator, version, probes, incidents, policy and health counts are all
   required: the page never substitutes a default for a value the API did not
   send.

The page needs no account. Everything on it is public by design.

## The display vocabulary

The words the page shows for machine values live in `network.ts`, not in the
markup:

- `standingSpec("local")` → the chip word **Local** and its calm sentence. An
  unknown standing keeps its raw word and a neutral chip — honest, never
  guessed.
- `anchorSpec("pending")` → **Anchor pending** (amber `--pending` family, the
  ◔ glyph) and "Anchoring is not enabled on this node yet. Records are signed
  now; the public timestamp will be added when anchoring is enabled."
- `replicaSegments` → which meter segments are filled (`have` of `of`,
  clamped). The meter is `aria-hidden`: the visible "1 of 1 local" line is the
  state; the bar only pictures it. Status is never colour alone.
- `probeSummary` → "No probes run yet", or a whole percentage that is never
  rounded past the truth (a rate with a failure in it is not shown as 100%, one
  with a pass in it is not shown as 0%).
- `replicaHealthSpec` / `replicaHealthSegments` / `listedPapersLine` /
  `policyTargetSentence` → the words, the bar's segments (only healths that have
  papers, sized by count) and the policy sentence. The health bar is
  `aria-hidden`; the rows beside it carry each word and count.
- `incidentDate` → `4 May 2027`, in UTC; an unreadable date stays as sent.
- `archiveExportHref`, `EXPORT_VERIFY_COMMAND`, `EXPORT_REBUILD_COMMAND` → the
  export section's link and commands.
- Clause ids link through `policyHref` (`features/policies-page`), the same
  `/policies#MOD-02` anchor a decision banner uses. Never hand-build the
  fragment.
- The node DID renders in the shared `IdPill` (`features/ui-kit`): monospace,
  copies on click, toast says "Copied".

## Files

| File | Responsibility |
| --- | --- |
| `network.ts` | Wire type + validation, `loadNetworkStatus`, the display vocabulary (`standingSpec`, `anchorSpec`, `replicaSegments`, `replicaHealthSegments`, `probeSummary`, `policyTargetSentence`, `moderationCountLine`, …), the export link and commands, plain-language errors. |
| `network-page.tsx` | The page component: fact cards (node, log head, anchor, probes, replication), moderation table, incident log, public export, loading/empty/error states, client retry. |
| `network-page.css` | Card, chip, meter, health bar, table, incident and command styles; every value is a design token. |
| `index.ts` | Public surface for route files and cross-feature links. |
| `network.test.ts` | Payload validation, display vocabulary and the API request shape. |
| `network-page.test.tsx` | Sections, chips, meter, clause links, empty/loading/error and retry behaviour. |
| `network-route.test.tsx` | The server render: the first HTML contains the whole document. |
| `network-page.css.test.ts` | Token-only colours, chip contrast rules, meter and responsive contracts. |
| `app/(network-page)/layout.tsx` | Global nav + page shell (`np-shell`). |
| `app/(network-page)/network/page.tsx` | `/network` route: metadata, server fetch, error capture. |
