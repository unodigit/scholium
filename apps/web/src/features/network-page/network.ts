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
 *   "moderation": { "total": 3, "by_clause": { "MOD-01": 2, "MOD-04": 1 } },
 *   "operator": "NextGenius",
 *   "software_version": "0.1.0",
 *   "probes": { "window_hours": 24, "runs": 0, "passed": 0, "pass_rate": null },
 *   "incidents": [],
 *   "replication_policy": { "replicas": 5, "operators": 3, "jurisdictions": 2 },
 *   "papers_by_replica_health": { "meets_policy": 0, "below_policy": 0, "single_copy": 12 }
 * }
 * ```
 *
 * Beyond the node's identity, log head, anchor, replication and moderation
 * counts (docs/design.md §5.8), the document names the **operator** and
 * **software version**, the availability-**probe** pass rate over the last 24 h
 * (`pass_rate` is `null` — never `0` — when no probe has run), the public
 * **incident log** (an empty list is a normal answer), the replication
 * **policy target** and how many listed papers sit at each **replica health**.
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

import {
  ApiError,
  NetworkError,
  api,
  resolveApiBaseUrl,
  type ApiClient,
} from "../../lib/api";

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

/** Availability-probe results over the last `window_hours` hours. */
export interface ProbeStatistics {
  /** Hours the figures cover (24). */
  readonly window_hours: number;
  /** Probes run in the window. */
  readonly runs: number;
  /** Probes that passed. */
  readonly passed: number;
  /** `passed / runs` in [0, 1]; `null` — not `0` — when no probe has run. */
  readonly pass_rate: number | null;
}

/** One entry of the public incident log. */
export interface IncidentEntry {
  /** When the incident began, RFC 3339 UTC. */
  readonly occurred_at: string;
  /** One-line description. */
  readonly title: string;
  /** What happened and what was done. */
  readonly detail: string;
}

/** The replication target a listed paper is held to (PRD NET-3). */
export interface ReplicationPolicy {
  readonly replicas: number;
  readonly operators: number;
  readonly jurisdictions: number;
}

/** The replica healths a paper can be in, in the order the page lists them. */
export const REPLICA_HEALTHS = [
  "meets_policy",
  "below_policy",
  "single_copy",
] as const;

/** A paper's replica health, judged against the policy target. */
export type ReplicaHealth = (typeof REPLICA_HEALTHS)[number];

/** Listed papers per replica health; every health is always present. */
export type ReplicaHealthCounts = Readonly<Record<ReplicaHealth, number>>;

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
  /** Name of the organisation operating this node. */
  readonly operator: string;
  /** Version of the software this node runs. */
  readonly software_version: string;
  /** Availability-probe results for the last 24 hours. */
  readonly probes: ProbeStatistics;
  /** Public incident log, newest first (empty when nothing is recorded). */
  readonly incidents: readonly IncidentEntry[];
  /** Replication target a listed paper is held to. */
  readonly replication_policy: ReplicationPolicy;
  /** Listed papers per replica health. */
  readonly papers_by_replica_health: ReplicaHealthCounts;
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

/** Read a whole number of at least one, or say which part is broken. */
function requiredPositiveCount(
  container: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = requiredCount(container, field, what);
  if (value < 1) {
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

  const operator = requiredString(payload, "operator", "The network status");
  const software_version = requiredString(
    payload,
    "software_version",
    "The network status",
  );

  return {
    node_did,
    standing,
    log_head,
    last_anchor,
    replicas,
    moderation,
    operator,
    software_version,
    probes: parseProbes(requiredRecord(payload, "probes", "The network status")),
    incidents: parseIncidents(payload.incidents),
    replication_policy: parsePolicy(
      requiredRecord(payload, "replication_policy", "The network status"),
    ),
    papers_by_replica_health: parseHealthCounts(
      requiredRecord(payload, "papers_by_replica_health", "The network status"),
    ),
  };
}

/** The probe statistics; a missing `pass_rate` is broken, a `null` one is "none yet". */
function parseProbes(probes: Record<string, unknown>): ProbeStatistics {
  const what = "The probe statistics";
  const window_hours = requiredPositiveCount(probes, "window_hours", what);
  const runs = requiredCount(probes, "runs", what);
  const passed = requiredCount(probes, "passed", what);
  if (passed > runs) {
    throw new NetworkStatusError(`${what} has no usable passed (more passes than runs).`);
  }
  const rate = probes.pass_rate;
  if (
    rate !== null &&
    (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1)
  ) {
    throw new NetworkStatusError(`${what} has no usable pass_rate.`);
  }
  return { window_hours, runs, passed, pass_rate: rate };
}

/** The incident log: a list (possibly empty) of complete entries, in the API's order. */
function parseIncidents(value: unknown): readonly IncidentEntry[] {
  if (!Array.isArray(value)) {
    throw new NetworkStatusError("The network status has no usable incidents.");
  }
  return value.map((entry: unknown, index) => {
    const what = `Incident ${index + 1}`;
    if (!isRecord(entry)) {
      throw new NetworkStatusError(`${what} is not an incident entry.`);
    }
    return {
      occurred_at: requiredString(entry, "occurred_at", what),
      title: requiredString(entry, "title", what),
      detail: requiredString(entry, "detail", what),
    };
  });
}

/** The replication target: three positive whole numbers. */
function parsePolicy(policy: Record<string, unknown>): ReplicationPolicy {
  const what = "The replication policy";
  return {
    replicas: requiredPositiveCount(policy, "replicas", what),
    operators: requiredPositiveCount(policy, "operators", what),
    jurisdictions: requiredPositiveCount(policy, "jurisdictions", what),
  };
}

/** Counts for every replica health; a missing health is broken, a zero is a fact. */
function parseHealthCounts(counts: Record<string, unknown>): ReplicaHealthCounts {
  const what = "The replica health counts";
  return {
    meets_policy: requiredCount(counts, "meets_policy", what),
    below_policy: requiredCount(counts, "below_policy", what),
    single_copy: requiredCount(counts, "single_copy", what),
  };
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
      "Anchoring is not enabled on this node yet. Records are signed now; the public timestamp will be added when anchoring is enabled.",
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

/** The replication target as the one sentence the page shows. */
export function policyTargetSentence(policy: ReplicationPolicy): string {
  return `Policy target: ${policy.replicas} replicas, ${policy.operators} operators, ${policy.jurisdictions} jurisdictions.`;
}

/** The words for a replica health, and the sentence that says what it means. */
export interface ReplicaHealthSpec {
  /** The word shown beside the count (status is never colour alone). */
  readonly label: string;
  /** One plain sentence: what a paper in this health risks. */
  readonly meaning: string;
}

const REPLICA_HEALTH_SPECS: Readonly<Record<ReplicaHealth, ReplicaHealthSpec>> = {
  meets_policy: {
    label: "Meets policy",
    meaning: "Held at the full target.",
  },
  below_policy: {
    label: "Below policy",
    meaning: "More than one copy, but short of the target.",
  },
  single_copy: {
    label: "Single copy",
    meaning: "Only one copy exists, so a single failure would lose the paper.",
  },
};

/** The words for a replica health. */
export function replicaHealthSpec(health: ReplicaHealth): ReplicaHealthSpec {
  return REPLICA_HEALTH_SPECS[health];
}

/** One filled stretch of the health meter. */
export interface HealthSegment {
  readonly health: ReplicaHealth;
  readonly count: number;
}

/**
 * The stretches of the health meter: every health that has papers, in policy
 * order. A health with no papers has no width, so it draws nothing.
 */
export function replicaHealthSegments(
  counts: ReplicaHealthCounts,
): readonly HealthSegment[] {
  return REPLICA_HEALTHS.filter((health) => counts[health] > 0).map((health) => ({
    health,
    count: counts[health],
  }));
}

/** How many papers the health counts cover, in the page's voice. */
export function listedPapersLine(counts: ReplicaHealthCounts): string {
  const total = REPLICA_HEALTHS.reduce((sum, health) => sum + counts[health], 0);
  if (total === 0) {
    return "No papers are listed yet.";
  }
  return `${total} listed paper${total === 1 ? "" : "s"}, by replica health.`;
}

/** The headline and the sentence behind it for the probe pass rate. */
export interface ProbeSummary {
  /** `"No probes run yet"` or a whole percentage such as `"75%"`. */
  readonly figure: string;
  /** The counts behind the figure, or why there are none. */
  readonly detail: string;
}

/**
 * Words for the probe statistics. "No probes run yet" is not "0%": the first
 * says nothing was checked, the second says everything checked failed. The
 * percentage is rounded but never past the truth — a rate with a failure in it
 * is not shown as 100%, and one with a pass in it is not shown as 0%.
 */
export function probeSummary(probes: ProbeStatistics): ProbeSummary {
  if (probes.pass_rate === null) {
    return {
      figure: "No probes run yet",
      detail:
        "Availability probes check copies held by other operators. This server holds the only copy, so none have run.",
    };
  }
  let percent = Math.round(probes.pass_rate * 100);
  if (probes.passed < probes.runs) {
    percent = Math.min(percent, 99);
  }
  if (probes.passed > 0) {
    percent = Math.max(percent, 1);
  }
  return {
    figure: `${percent}%`,
    detail: `${probes.passed} of ${probes.runs} probes passed in the last ${probes.window_hours} hours.`,
  };
}

/** An incident's date as the site writes dates (`4 May 2027`), in UTC; unreadable ones stay as sent. */
export function incidentDate(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return occurredAt;
  }
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The whole public archive (`GET /v1/export/archive.car`), relative to the API's origin. */
export const EXPORT_ARCHIVE_PATH = "/v1/export/archive.car";

/** Checks every block and record of the downloaded archive; exits 1 on any mismatch. */
export const EXPORT_VERIFY_COMMAND = "scholium verify archive.car";

/** Replays the archive's log into a fresh database; exits 1 (and writes nothing) on any mismatch. */
export const EXPORT_REBUILD_COMMAND =
  "scholium rebuild archive.car --db rebuilt.db";

/**
 * The archive's download link. It names the API's origin: the web app does not
 * serve `/v1`, so a bare path would 404 wherever the two run on different origins.
 */
export function archiveExportHref(baseUrl?: string): string {
  return `${resolveApiBaseUrl(baseUrl)}${EXPORT_ARCHIVE_PATH}`;
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
