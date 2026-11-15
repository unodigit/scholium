/**
 * The public network status behind `/network` (feature 176).
 *
 * `GET /v1/network` (feature 127, `apps/api/src/app/modules/network/`) is the
 * transparency document a reader can open without an account: what this node
 * says about itself right now — its DID and federation standing, the head of
 * its append-only record log, the status of its last public-timestamp anchor,
 * its replication summary, and its accepted moderation decisions counted by
 * the policy clause each one cites:
 *
 * ```json
 * {
 *   "node_did": "did:key:z6MkfZrSg…",
 *   "standing": "local",
 *   "log_head": { "seq": 41, "entry_hash": "9f86d081…" },
 *   "last_anchor": { "status": "pending" },
 *   "replicas": { "have": 1, "of": 1, "local": true, "summary": "1 of 1 local" },
 *   "moderation": { "total": 3, "by_clause": { "MOD-01": 2, "MOD-04": 1 } }
 * }
 * ```
 *
 * The API is the source of truth; this module only validates the wire shape,
 * loads it, and holds the display vocabulary (the words a chip shows for a
 * standing or an anchor status, and the sentences that keep "pending" a calm
 * state rather than an error — docs/design.md §1 "Calm under failure").
 * Clause ids link to the policies page through `policyHref`
 * (`features/policies-page`), the same anchor a decision banner uses.
 *
 * Pure data and functions, no React, so the server route and the client
 * component share them (and vitest can test them without a JSX transform).
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** The `/network` route (docs/design.md §4: Network · nodes, replication, status). */
export const NETWORK_PATH = "/network";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const NETWORK_ENDPOINT = "/network";

/** Human-facing label for the page and its links. */
export const NETWORK_TITLE = "Network";

/**
 * The only anchor status this build produces (app_spec.xml scope: "anchor
 * status is always reported as pending"). Kept as a named value so the page
 * and its tests never disagree with the word the API sends.
 */
export const ANCHOR_STATUS_PENDING = "pending";

/**
 * The standing of a node that serves its own records and takes part in no
 * federation — the only standing `GET /v1/network` produces today.
 */
export const LOCAL_STANDING = "local";

/** The log's current head: its last `seq` and that entry's hash. */
export interface LogHeadStatus {
  /** Sequence number of the log's last entry (0 for an empty log). */
  readonly seq: number;
  /** That entry's hash in lowercase hex (all zeros when the log is empty). */
  readonly entry_hash: string;
}

/** Public-timestamp status of the node's most recent anchor. */
export interface LastAnchorStatus {
  /** Always `"pending"` for this node: anchoring is not enabled yet. */
  readonly status: string;
}

/** How many replicas the node holds, out of how many it should hold. */
export interface ReplicaSummary {
  /** Replicas the node holds. */
  readonly have: number;
  /** Replicas the node is configured to hold. */
  readonly of: number;
  /** Whether the held replica lives on this node. */
  readonly local: boolean;
  /** Human-readable form of the pair, e.g. `"1 of 1 local"`. */
  readonly summary: string;
}

/** Accepted moderation decisions, grouped by the clause they cite. */
export interface ModerationStatistics {
  /** Number of accepted decisions in total. */
  readonly total: number;
  /** Decisions per cited clause id, in the API's (sorted) order. */
  readonly by_clause: Readonly<Record<string, number>>;
}

/** The document `GET /v1/network` serves. */
export interface NetworkStatus {
  /** DID this node records as the origin of its log entries. */
  readonly node_did: string;
  /** Federation standing; `"local"` for this single, unfederated node. */
  readonly standing: string;
  /** Current head of the record log. */
  readonly log_head: LogHeadStatus;
  /** Status of the node's most recent public-timestamp anchor. */
  readonly last_anchor: LastAnchorStatus;
  /** Replication summary. */
  readonly replicas: ReplicaSummary;
  /** Moderation decision counts by cited policy clause. */
  readonly moderation: ModerationStatistics;
}

/**
 * Anything that can fetch the status document. The real implementation is the
 * shared API client; tests pass a narrow object with a single `get`.
 */
export type NetworkClient = Pick<ApiClient, "get">;

/** Raised when the API answers with something that is not a network status. */
export class NetworkStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkStatusError";
  }
}

/* -------------------------------------------------------------------------- */
/* Payload validation                                                         */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read a non-blank string field, or say which part of the document is broken. */
function requiredString(
  container: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const value = container[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new NetworkStatusError(`${what} has no usable ${field}.`);
  }
  return value.trim();
}

/** Read a non-negative whole-number field, or say which part is broken. */
function requiredCount(
  container: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = container[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new NetworkStatusError(`${what} has no usable ${field}.`);
  }
  return value;
}

/** Read a nested object field, or say which part of the document is broken. */
function requiredRecord(
  container: Record<string, unknown>,
  field: string,
  what: string,
): Record<string, unknown> {
  const value = container[field];
  if (!isRecord(value)) {
    throw new NetworkStatusError(`${what} has no usable ${field}.`);
  }
  return value;
}

/**
 * Validate and normalise an API payload into a {@link NetworkStatus}.
 *
 * Like the policies loader, this is forgiving about extra fields (the endpoint
 * may grow) and strict about the parts the page renders: a missing or blank
 * field raises {@link NetworkStatusError} rather than rendering a half-empty
 * transparency page. Clause counts keep the API's order (the endpoint sorts by
 * clause id); two ids that only differ in whitespace are rejected because one
 * clause id cannot count two rules.
 */
export function parseNetworkStatus(payload: unknown): NetworkStatus {
  if (!isRecord(payload)) {
    throw new NetworkStatusError(
      "The API did not return a network status document.",
    );
  }

  const node_did = requiredString(payload, "node_did", "The network status");
  const standing = requiredString(payload, "standing", "The network status");

  const head = requiredRecord(payload, "log_head", "The network status");
  const log_head: LogHeadStatus = {
    seq: requiredCount(head, "seq", "The log head"),
    entry_hash: requiredString(head, "entry_hash", "The log head"),
  };

  const anchor = requiredRecord(payload, "last_anchor", "The network status");
  const last_anchor: LastAnchorStatus = {
    status: requiredString(anchor, "status", "The last anchor"),
  };

  const replicasPayload = requiredRecord(
    payload,
    "replicas",
    "The network status",
  );
  const of = requiredCount(replicasPayload, "of", "The replica summary");
  if (of < 1) {
    // A node configured to hold no replicas at all has no summary to show.
    throw new NetworkStatusError(
      "The replica summary has no usable of (a node holds at least one replica).",
    );
  }
  const local = replicasPayload.local;
  if (typeof local !== "boolean") {
    throw new NetworkStatusError(
      "The replica summary has no usable local flag.",
    );
  }
  const replicas: ReplicaSummary = {
    have: requiredCount(replicasPayload, "have", "The replica summary"),
    of,
    local,
    summary: requiredString(replicasPayload, "summary", "The replica summary"),
  };

  const moderationPayload = requiredRecord(
    payload,
    "moderation",
    "The network status",
  );
  const byClausePayload = requiredRecord(
    moderationPayload,
    "by_clause",
    "The moderation statistics",
  );
  const by_clause: Record<string, number> = {};
  for (const [rawClause, rawCount] of Object.entries(byClausePayload)) {
    const clause = rawClause.trim();
    if (clause === "") {
      throw new NetworkStatusError(
        "The moderation statistics cite a clause with a blank id.",
      );
    }
    if (clause in by_clause) {
      throw new NetworkStatusError(
        `Policy clause id ${clause} appears twice in the moderation statistics.`,
      );
    }
    if (
      typeof rawCount !== "number" ||
      !Number.isInteger(rawCount) ||
      rawCount < 0
    ) {
      throw new NetworkStatusError(
        `The moderation count for clause ${clause} is not a whole number.`,
      );
    }
    by_clause[clause] = rawCount;
  }
  const moderation: ModerationStatistics = {
    total: requiredCount(moderationPayload, "total", "The moderation statistics"),
    by_clause,
  };

  return { node_did, standing, log_head, last_anchor, replicas, moderation };
}

/* -------------------------------------------------------------------------- */
/* Display vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/** Colour family of a chip; the icon and the word carry the state, not colour. */
export type StatusTone = "neutral" | "pending";

/** The words a chip shows for a standing, and the sentence beside them. */
export interface StandingSpec {
  /** The chip's word (docs/design.md §3: a status is icon + word, never colour). */
  readonly label: string;
  /** One calm sentence explaining what the standing means. */
  readonly meaning: string;
  /** Chip colour family. */
  readonly tone: StatusTone;
}

/** The standings this build produces. Unknown values fall back to their word. */
export const STANDING_SPECS: Readonly<Record<string, StandingSpec>> = {
  local: {
    label: "Local",
    meaning:
      "This node serves its own records and takes part in no federation yet.",
    tone: "neutral",
  },
};

/** The chip spec for a standing: a known one, or the raw word kept honest. */
export function standingSpec(standing: string): StandingSpec {
  const known = STANDING_SPECS[standing];
  if (known) {
    return known;
  }
  return {
    label: standing.trim() || "Unknown",
    meaning: "This node reports a standing this page does not recognise.",
    tone: "neutral",
  };
}

/** The words a chip shows for an anchor status, and the sentence beside them. */
export interface AnchorSpec {
  /** The chip's word. */
  readonly label: string;
  /** One calm sentence: pending is a state, not an error (design.md §1). */
  readonly meaning: string;
  /** Chip colour family. */
  readonly tone: StatusTone;
}

/** The anchor statuses this build produces. */
export const ANCHOR_SPECS: Readonly<Record<string, AnchorSpec>> = {
  pending: {
    label: "Anchor pending",
    meaning:
      "Signed. The public timestamp will be added when anchoring is enabled.",
    tone: "pending",
  },
};

/** The chip spec for an anchor status: a known one, or the raw word kept honest. */
export function anchorSpec(status: string): AnchorSpec {
  const known = ANCHOR_SPECS[status];
  if (known) {
    return known;
  }
  return {
    label: `Anchor ${status.trim() || "unknown"}`,
    meaning: "This node reports an anchor status this page does not recognise.",
    tone: "neutral",
  };
}

/**
 * Which segments of the replica meter are filled: `have` of `of`, clamped so a
 * misreported document can never draw more filled segments than there are.
 */
export function replicaSegments(replicas: ReplicaSummary): readonly boolean[] {
  const width = Math.max(0, replicas.of);
  const filled = Math.min(Math.max(0, replicas.have), width);
  return Array.from({ length: width }, (_, index) => index < filled);
}

/** The moderation count line, singular or plural, in the page's voice. */
export function moderationCountLine(total: number): string {
  return total === 1
    ? "1 accepted decision, counted by the policy clause it cites."
    : `${total} accepted decisions, counted by the policy clause each cites.`;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Load the public network status from `GET /v1/network`.
 *
 * The endpoint needs no account, so the request is unauthenticated. It is
 * never cached either: the log head moves with every record a node accepts,
 * and a stale cache would present an old head as the current one on the very
 * page whose job is to say what the node holds *right now*.
 */
export async function loadNetworkStatus(
  client: NetworkClient = api,
): Promise<NetworkStatus> {
  const payload = await client.get<unknown>(NETWORK_ENDPOINT, {
    auth: false,
    cache: "no-store",
  });
  return parseNetworkStatus(payload);
}

/**
 * One plain-language sentence for the page's error state.
 *
 * Transport and HTTP failures are the common cases (the API is down while the
 * web app stays up); `NetworkStatusError` means the API answered but not with
 * a network status. Raw messages are only shown for unexpected errors, where
 * there is nothing more specific to say.
 */
export function describeNetworkError(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return the network status.";
  }
  if (error instanceof NetworkStatusError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The network status could not be loaded.";
}
