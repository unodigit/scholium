/**
 * The moderation queue: wire shape, validation, and how each signal reads.
 *
 * `GET /v1/moderation/queue` (tier 4 only) returns the versions waiting in
 * `moderation` state. Each entry carries the automated signals a moderator
 * decides with — similarity %, unresolved references, the file scan result
 * and whether the submitting account is new — beside the paper's title,
 * category and age (`apps/api/src/app/modules/moderation/router.py`).
 *
 * This module only validates that shape and turns every signal into the words
 * and icon the table shows. It never decides anything: the API is the source
 * of truth for who may read the queue (a lower tier gets a 403) and for every
 * value in it. Pure data and functions, no React, so the route, the component
 * and vitest can all share it.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import type { IconName } from "../ui-kit/icons";

/** The `/mod` route (docs/design.md §4: Moderation (tier 4)). */
export const MOD_PATH = "/mod";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const QUEUE_ENDPOINT = "/moderation/queue";

/** Human-facing label for the page. */
export const MOD_TITLE = "Moderation console";

/** Sign-in, returning to the console afterwards (`?next=` is read by /signin). */
export const SIGNIN_HREF = `/signin?next=${encodeURIComponent(MOD_PATH)}`;

/** The trust tier the API requires to read the queue. */
export const MODERATOR_TIER = 4;

/** What the file scan said about a version's files. */
export type ScanResult = "passed" | "failed" | "pending" | "unknown";

/** One version waiting for a moderation decision. */
export interface QueueEntry {
  /** The version's record id; unique within the queue. */
  readonly versionCid: string;
  /** The paper's record id, when the API sent it. */
  readonly paperCid: string | null;
  /** The paper's short id (`sch:xxxx-xxxx-xxxx`), when the API sent it. */
  readonly shortId: string | null;
  readonly title: string;
  /** Every category on the paper, primary first. Empty when it has none. */
  readonly categories: readonly string[];
  /** Hours since the version was received; `null` when unknown. */
  readonly ageHours: number | null;
  /** Overlap with listed papers, 0–100; `null` before the check has run. */
  readonly similarityPct: number | null;
  /** References the checks could not resolve; `null` before the check has run. */
  readonly referencesUnresolved: number | null;
  readonly scan: ScanResult;
  /** Whether the submitting account is new; `null` when the API did not say. */
  readonly newAccount: boolean | null;
}

/**
 * Anything that can fetch the queue. The real implementation is the shared
 * API client; tests pass a narrow object with a single `get`.
 */
export type QueueClient = Pick<ApiClient, "get">;

/** Raised when the API answers with something that is not a queue. */
export class QueueListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueListError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCount(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && number >= 0 && Number.isInteger(number)
    ? number
    : null;
}

function readFlag(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

/**
 * Reduce the API's scan field to one of four verdicts.
 *
 * The API reports a verdict string (`passed` or `failed` today); a pending or
 * not-yet-scanned version and an object carrying `result`/`status` are read
 * the same way. Anything that is not clearly a pass is never shown as one: an
 * unrecognised value is `unknown`, which the table renders as a question
 * mark, not a tick.
 */
export function parseScanResult(value: unknown): ScanResult {
  if (isRecord(value)) {
    return parseScanResult(value.result ?? value.status);
  }
  const verdict = readText(value)?.toLowerCase();
  switch (verdict) {
    case "passed":
    case "pass":
    case "clean":
      return "passed";
    case "failed":
    case "fail":
    case "blocked":
    case "rejected":
    case "infected":
      return "failed";
    case "pending":
    case "scanning":
    case "unscanned":
      return "pending";
    default:
      return "unknown";
  }
}

function readCategories(item: Record<string, unknown>): string[] {
  const listed = Array.isArray(item.categories)
    ? item.categories
        .map(readText)
        .filter((category): category is string => category !== null)
    : [];
  if (listed.length > 0) {
    return listed;
  }
  const primary = readText(item.category);
  return primary === null ? [] : [primary];
}

/**
 * Validate and normalise an API payload into {@link QueueEntry}s, oldest first.
 *
 * Only an entry's identity is required (`version_cid`, or `cid`): without it
 * a row cannot be keyed or opened. Everything else degrades to "unknown"
 * rather than hiding a paper from a moderator — a missing title becomes
 * "Untitled", a missing signal reads "Not checked". A version listed twice is
 * shown once. A payload that is not a list is rejected with
 * {@link QueueListError} instead of rendering an empty queue, because an empty
 * table would say "nothing is waiting" when the truth is "we don't know".
 *
 * The oldest version comes first (a queue is worked in arrival order);
 * entries with no known age go last.
 */
export function parseQueue(payload: unknown): QueueEntry[] {
  if (!Array.isArray(payload)) {
    throw new QueueListError("The API did not return a moderation queue.");
  }

  const entries: QueueEntry[] = [];
  const seen = new Set<string>();
  payload.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new QueueListError(`Queue entry ${index + 1} is not an object.`);
    }
    const versionCid = readText(item.version_cid) ?? readText(item.cid);
    if (versionCid === null) {
      throw new QueueListError(`Queue entry ${index + 1} has no version id.`);
    }
    if (seen.has(versionCid)) {
      return;
    }
    seen.add(versionCid);

    const age = readNumber(item.age_hours);
    entries.push({
      versionCid,
      paperCid: readText(item.paper_cid),
      shortId: readText(item.short_id),
      title: readText(item.title) ?? "Untitled",
      categories: readCategories(item),
      ageHours: age === null ? null : Math.max(0, age),
      similarityPct: readNumber(item.similarity_pct),
      referencesUnresolved: readCount(item.references_unresolved),
      scan: parseScanResult(item.scan_result ?? item.scan_status ?? item.scan),
      newAccount: readFlag(item.new_account, item.is_new_account),
    });
  });

  return entries
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => {
      const left = a.entry.ageHours;
      const right = b.entry.ageHours;
      if (left === right) {
        return a.position - b.position;
      }
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return right - left;
    })
    .map(({ entry }) => entry);
}

/**
 * How long a version has waited, in the units a moderator reasons in.
 *
 * The decision target is 48 hours (docs/design.md §5.4), so ages stay in hours
 * up to two days and then read as days and hours: `<1 h`, `5 h`, `47 h`,
 * `2 d`, `3 d 4 h`. An unknown age is an em dash.
 */
export function formatAge(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) {
    return "—";
  }
  if (hours < 1) {
    return "<1 h";
  }
  const whole = Math.floor(hours);
  if (whole < 48) {
    return `${whole} h`;
  }
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

/** A similarity percentage to at most one decimal: `12%`, `42.5%`. */
export function formatSimilarity(pct: number): string {
  return `${Number(pct.toFixed(1))}%`;
}

/**
 * How one signal is drawn.
 *
 * `tone` carries the colour, `icon` the shape and `text` the words; a signal
 * is never colour alone (docs/design.md §9), so every tone but `none` has an
 * icon and every signal has text.
 */
export interface Signal {
  /** `ok` verified, `warn` pending, `bad` critical, `unknown` muted, `none` plain. */
  readonly tone: "ok" | "warn" | "bad" | "unknown" | "none";
  readonly icon: IconName | null;
  readonly text: string;
}

const NOT_CHECKED: Signal = { tone: "unknown", icon: "question", text: "Not checked" };

/**
 * Similarity to listed papers. The number stands alone: the spec sets no
 * threshold for "too similar", so the table does not invent one.
 */
export function similaritySignal(pct: number | null): Signal {
  return pct === null
    ? NOT_CHECKED
    : { tone: "none", icon: null, text: formatSimilarity(pct) };
}

/** References the checks could not resolve; any unresolved one is worth a look. */
export function referencesSignal(unresolved: number | null): Signal {
  if (unresolved === null) {
    return NOT_CHECKED;
  }
  return unresolved === 0
    ? { tone: "ok", icon: "check", text: "None unresolved" }
    : { tone: "warn", icon: "alert", text: `${unresolved} unresolved` };
}

/** The file scan verdict; only a clear pass is drawn as one. */
export function scanSignal(scan: ScanResult): Signal {
  switch (scan) {
    case "passed":
      return { tone: "ok", icon: "check", text: "Passed" };
    case "failed":
      return { tone: "bad", icon: "cross", text: "Failed" };
    case "pending":
      return { tone: "unknown", icon: "pending", text: "Pending" };
    default:
      return { tone: "unknown", icon: "question", text: "Unknown" };
  }
}

/** The new-account flag: a new account is flagged, an established one is plain. */
export function accountSignal(newAccount: boolean | null): Signal {
  if (newAccount === null) {
    return { tone: "unknown", icon: "question", text: "Unknown" };
  }
  return newAccount
    ? { tone: "warn", icon: "alert", text: "New account" }
    : { tone: "none", icon: null, text: "Established" };
}

/** The category column: every category, or an em dash when there is none. */
export function formatCategories(categories: readonly string[]): string {
  return categories.length === 0 ? "—" : categories.join(", ");
}

/**
 * Load the moderation queue from `GET /v1/moderation/queue`.
 *
 * The request carries the signed-in account's bearer token and is never
 * cached: the queue is live work, and a stale copy would show a paper another
 * moderator has already decided.
 */
export async function loadQueue(
  client: QueueClient = api,
): Promise<QueueEntry[]> {
  const payload = await client.get<unknown>(QUEUE_ENDPOINT, {
    cache: "no-store",
  });
  return parseQueue(payload);
}

/** Why the console cannot show a queue. */
export type QueueFailure =
  | { readonly kind: "signed-out"; readonly message: string }
  | {
      readonly kind: "forbidden";
      readonly message: string;
      /** The caller's trust tier, when the API said what it was. */
      readonly callerTier: number | null;
    }
  | { readonly kind: "error"; readonly message: string };

/** The failure for a visitor with no session; no request is made for them. */
export const SIGNED_OUT_FAILURE: QueueFailure = {
  kind: "signed-out",
  message: "Sign in with a moderator account to see the queue.",
};

/**
 * Sort a failed load into what the page should say.
 *
 * - `401` — the session is gone (the client already tried to refresh it).
 * - `403` — the account is signed in but below tier 4; the API names the
 *   caller's tier as `caller_tier`, which the page repeats.
 * - anything else — transport and server failures are retryable, so the
 *   message says what happened in one plain sentence.
 */
export function classifyQueueError(error: unknown): QueueFailure {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        kind: "signed-out",
        message: "Your session has ended. Sign in again to see the queue.",
      };
    }
    if (error.isForbidden) {
      const tier = error.problem.caller_tier;
      return {
        kind: "forbidden",
        message: `The moderation console is for moderators (trust tier ${MODERATOR_TIER}).`,
        callerTier:
          typeof tier === "number" && Number.isInteger(tier) ? tier : null,
      };
    }
    return {
      kind: "error",
      message:
        error.detail || error.title || "The API could not return the queue.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message:
        "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  if (error instanceof QueueListError) {
    return { kind: "error", message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "The moderation queue could not be loaded." };
}
