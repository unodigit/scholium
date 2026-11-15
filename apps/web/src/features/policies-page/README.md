# Policies page (`/policies`)

The public list of moderation policy clauses from
`GET /v1/moderation/policies` (`apps/api/src/app/modules/moderation/`). The
API is the source of truth: each clause is `{ id, title, text }`, in file
order, and every moderation decision must cite one by id.

`docs/design.md` §4 puts Policies beside Docs and Verify a file; §5.7 makes a
policy clause a required part of a moderation decision; §7 gives the decision
banner a link to that clause.

## The anchor contract

**The anchor is the clause id.** `/policies` renders each clause as
`<li id="MOD-02">`, so a decision banner links to it with:

```tsx
import { policyHref } from "@/features/policies-page";

<a href={policyHref(decision.clause)}>Policy {decision.clause}</a>;
```

`policyHref("MOD-02")` is `/policies#MOD-02`. Never hand-build the fragment:
`policyAnchorId` trims and slugifies an id the same way the page does, and an
empty id falls back to `policy` (a page never emits `id=""`). The offset for
the sticky global nav is `scroll-margin-top: calc(64px + 8px)` on the clause,
and `.pp-clause:target` highlights the cited clause on arrival.

## Rendering

The route is server-rendered and dynamic:

1. `app/(policies-page)/policies/page.tsx` calls `loadPolicies()` — an
   unauthenticated, `no-store` request — and passes the result to the
   component. The first HTML response therefore contains the whole list, and
   the browser makes no cross-origin API request.
2. `PoliciesPage` renders those clauses immediately. If the server fetch
   failed it retries once in the browser, so a page served while the API was
   down can still recover; a failure is a retryable notice, never a crash.
3. A malformed API body is rejected by `parsePolicyClauses` (missing fields,
   non-strings, duplicate ids) instead of rendering empty cards.

The page needs no account. Policies are public by design — a decision banner
must be readable by anyone checking the cited rule.

## Files

| File | Responsibility |
| --- | --- |
| `policies.ts` | Wire type + validation, `loadPolicies`, the anchor helpers (`policyAnchorId`, `policyHref`), plain-language errors. |
| `policies-page.tsx` | The page component: header, clause list, anchor permalinks, loading/empty/error states, client retry. |
| `policies-page.css` | Clause and notice styles; every value is a design token. |
| `index.ts` | Public surface for route files and decision banners. |
| `policies.test.ts` | Pure helpers, payload validation and the API request shape. |
| `policies-page.test.tsx` | Anchors, order, empty/loading/error and retry behaviour. |
| `policies-page.css.test.ts` | Token-only colours, anchor offset and `:target` contract. |
| `app/(policies-page)/layout.tsx` | Global nav + page shell (`pp-shell`). |
| `app/(policies-page)/policies/page.tsx` | `/policies` route: metadata, server fetch, error capture. |
