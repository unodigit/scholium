import type { Metadata } from "next";

import { PoliciesPage } from "../../../features/policies-page/policies-page";
import {
  describePoliciesError,
  loadPolicies,
  type PolicyClause,
} from "../../../features/policies-page/policies";

export const metadata: Metadata = {
  title: "Moderation policies",
  description:
    "The public moderation policy clauses every Scholium moderation decision cites.",
};

/**
 * The page is fetched fresh on every request: a stale policy list would let a
 * decision banner link to a clause the page no longer shows. `force-dynamic`
 * also keeps `next build` from trying to bake an error state when the API is
 * not running at build time.
 */
export const dynamic = "force-dynamic";

/**
 * `/policies` — every moderation policy clause, from
 * `GET /v1/moderation/policies`.
 *
 * Fetching on the server puts the whole list in the first HTML response (and
 * avoids a cross-origin request from the browser). The policy clauses are a
 * public read, so no account is needed. A failure is rendered as a retryable
 * notice rather than thrown, so the page shell and navigation still work; the
 * client component retries in the browser.
 */
export default async function PoliciesRoutePage() {
  let initialClauses: PolicyClause[] | undefined;
  let initialError: string | undefined;

  try {
    initialClauses = await loadPolicies();
  } catch (error) {
    initialError = describePoliciesError(error);
  }

  return (
    <PoliciesPage
      initialClauses={initialClauses}
      initialError={initialError}
    />
  );
}
