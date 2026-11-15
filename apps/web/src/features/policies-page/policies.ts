/**
 * The public moderation policy clauses and their stable anchors.
 *
 * `GET /v1/moderation/policies` returns the clause list every moderation
 * decision must cite (`[{ id, title, text }, …]`, file order). The API
 * (`apps/api/src/app/modules/moderation/policies.py`) is the source of truth;
 * this module only validates the wire shape and turns a clause id into the
 * same link a decision banner uses:
 *
 * ```ts
 * import { policyHref } from "@/features/policies-page";
 *
 * <a href={policyHref(decision.clause)}>Policy {decision.clause}</a>
 * ```
 *
 * `policyHref("MOD-02")` is `/policies#MOD-02`, and the `/policies` page
 * renders that clause with `id="MOD-02"`. Keeping the anchor equal to the
 * clause id means a banner needs no knowledge of the page's markup.
 *
 * Pure data and functions, no React, so both the server route and the client
 * component can share them (and vitest can test them without a JSX transform).
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** The `/policies` route (docs/design.md §4: Docs · Policies · Verify a file). */
export const POLICIES_PATH = "/policies";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const POLICIES_ENDPOINT = "/moderation/policies";

/** Human-facing label for the page and its links. */
export const POLICIES_TITLE = "Moderation policies";

/** One moderation policy clause, citable by its stable `id`. */
export interface PolicyClause {
  /** Stable clause id, e.g. `MOD-02`; a decision's `clause` field uses it. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/**
 * Anything that can fetch a policy list. The real implementation is the
 * shared API client; tests pass a narrow object with a single `get`.
 */
export type PoliciesClient = Pick<ApiClient, "get">;

/** Raised when the API answers with something that is not a clause list. */
export class PolicyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyListError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalise an API payload into {@link PolicyClause}s.
 *
 * The endpoint is public and read-only, so this is deliberately forgiving
 * about extra fields and leading/trailing whitespace, and strict about the
 * three fields the page actually needs. A malformed response raises
 * {@link PolicyListError} instead of rendering empty cards; duplicate ids (or
 * two ids that slugify to the same anchor) are rejected because one linked
 * clause cannot mean two rules.
 */
export function parsePolicyClauses(payload: unknown): PolicyClause[] {
  if (!Array.isArray(payload)) {
    throw new PolicyListError("The API did not return a policy clause list.");
  }

  const clauses: PolicyClause[] = [];
  const seen = new Set<string>();
  const seenAnchors = new Set<string>();
  payload.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new PolicyListError(`Policy clause ${index + 1} is not an object.`);
    }
    const fields = ["id", "title", "text"] as const;
    const values: Record<(typeof fields)[number], string> = {
      id: "",
      title: "",
      text: "",
    };
    for (const field of fields) {
      const value = item[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new PolicyListError(
          `Policy clause ${index + 1} has no usable ${field}.`,
        );
      }
      values[field] = value.trim();
    }
    if (seen.has(values.id)) {
      throw new PolicyListError(`Policy clause id ${values.id} appears twice.`);
    }
    seen.add(values.id);

    const anchor = policyAnchorId(values.id);
    if (seenAnchors.has(anchor)) {
      throw new PolicyListError(
        `Policy clause id ${values.id} shares the anchor #${anchor} with another clause.`,
      );
    }
    seenAnchors.add(anchor);

    clauses.push({ id: values.id, title: values.title, text: values.text });
  });

  return clauses;
}

/**
 * Turn a clause id into an HTML id (and URL fragment).
 *
 * Clause ids in `policies.yaml` are already fragment-safe (`MOD-01`), so they
 * pass through unchanged — which is what decision banners rely on. A future
 * id with spaces or punctuation is slugified rather than dropped, and an
 * empty id falls back to `policy` so the page never emits `id=""`.
 */
export function policyAnchorId(clauseId: string): string {
  const trimmed = clauseId.trim();
  const slug = trimmed
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "policy";
}

/** The shareable link for one clause: `/policies#MOD-02`. */
export function policyHref(clauseId: string): string {
  return `${POLICIES_PATH}#${encodeURIComponent(policyAnchorId(clauseId))}`;
}

/**
 * Load the public policy clauses from `GET /v1/moderation/policies`.
 *
 * The endpoint needs no account, so the request is unauthenticated and never
 * cached: policies are the rules moderators cite, and a stale browser cache
 * would let a decision banner point at a clause the page no longer shows.
 */
export async function loadPolicies(
  client: PoliciesClient = api,
): Promise<PolicyClause[]> {
  const payload = await client.get<unknown>(POLICIES_ENDPOINT, {
    auth: false,
    cache: "no-store",
  });
  return parsePolicyClauses(payload);
}

/**
 * One plain-language sentence for the page's error state.
 *
 * Transport and HTTP failures are the common cases (the API is down while the
 * web app stays up); `PolicyListError` means the API answered but not with a
 * clause list. Raw messages are only shown for unexpected errors, where there
 * is nothing more specific to say.
 */
export function describePoliciesError(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return the policies.";
  }
  if (error instanceof PolicyListError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The policy list could not be loaded.";
}
