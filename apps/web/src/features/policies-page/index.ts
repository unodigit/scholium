/**
 * `policies-page` — the public moderation policy clause list (`/policies`).
 *
 * The feature owns the route group `app/(policies-page)/` and this module.
 * A decision banner links to a clause through {@link policyHref}, which is the
 * same anchor the page renders:
 *
 * ```tsx
 * import { policyHref } from "@/features/policies-page";
 *
 * <a href={policyHref(decision.clause)}>Policy {decision.clause}</a>
 * ```
 *
 * The page is server-rendered from `GET /v1/moderation/policies`; the client
 * fallback exists only so a failed server fetch can retry in the browser.
 */

export {
  POLICIES_ENDPOINT,
  POLICIES_PATH,
  POLICIES_TITLE,
  PolicyListError,
  describePoliciesError,
  loadPolicies,
  parsePolicyClauses,
  policyAnchorId,
  policyHref,
  type PolicyClause,
  type PoliciesClient,
} from "./policies";

export {
  PoliciesPage,
  type LoadPolicies,
  type PoliciesPageProps,
} from "./policies-page";
