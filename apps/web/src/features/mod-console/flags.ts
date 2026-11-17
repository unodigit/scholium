/**
 * Flags: reports of a paper, post or review that a moderator has to look at.
 *
 * A member files a flag with `POST /v1/flags`; it is saved as `pending` until
 * a moderation decision resolves it (`apps/api/src/app/modules/flags`). A
 * moderator (tier 4) reads one with `GET /v1/flags/{id}`, which answers the
 * flag's status and the cid of the decision that settled it.
 *
 * Two reads feed the console:
 *
 * - **the list**, `GET /v1/flags` — one flag per entry, in the same shape the
 *   single read uses; tier 4 only, and the open flags unless a `state` is asked
 *   for. A server without the route answers `404`/`405`, which is its own
 *   failure kind, `unsupported`, which the console words honestly instead of
 *   showing an empty queue that would say "no flags" when the truth is "cannot
 *   tell";
 * - **the lookup**, `GET /v1/flags/{id}` — for a moderator who has a flag's id,
 *   open or decided.
 *
 * This module only validates those shapes and words them. Who may read a flag
 * is the API's call (it answers a lower tier with `404` for a single flag and
 * `403` otherwise). Pure data and functions, no React.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { MODERATOR_TIER, modDetailHref, type Signal } from "./queue";
import { isRecord, readText } from "./wire";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const FLAGS_ENDPOINT = "/flags";

/** Anything that can fetch flags; tests pass a narrow object with `get`. */
export type FlagsClient = Pick<ApiClient, "get">;

/** One flag as the moderator reads it. */
export interface FlagEntry {
  /** The flag's id (`GET /v1/flags/{id}`). */
  readonly id: string;
  /** The flagged paper, version, post or review. */
  readonly targetCid: string;
  /** The reporter's DID, when the API sent it (it is moderator-only). */
  readonly reporterDid: string | null;
  /** The reason category the reporter chose, as sent (`spam`, …). */
  readonly reason: string;
  /** `pending` until decided; any other value means a decision settled it. */
  readonly status: string;
  /** The deciding record's cid, once there is one. */
  readonly decisionCid: string | null;
}

/** Raised when the API answers with something that is not a flag. */
export class FlagReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagReadError";
  }
}

function readFlag(item: unknown, where: string): FlagEntry {
  if (!isRecord(item)) {
    throw new FlagReadError(`${where} is not an object.`);
  }
  const id =
    readText(item.id) ?? readText(item.flag_id) ?? readText(item.flagId);
  if (id === null) {
    throw new FlagReadError(`${where} has no id.`);
  }
  const targetCid =
    readText(item.target_cid) ??
    readText(item.targetCid) ??
    readText(item.target);
  if (targetCid === null) {
    throw new FlagReadError(`${where} does not say what was flagged.`);
  }
  return {
    id,
    targetCid,
    reporterDid:
      readText(item.reporter_did) ??
      readText(item.reporterDid) ??
      readText(item.reporter),
    reason:
      readText(item.reason) ??
      readText(item.category) ??
      readText(item.reasonCategory) ??
      "",
    status: readText(item.status) ?? "pending",
    decisionCid: readText(item.decision_cid) ?? readText(item.decisionCid),
  };
}

/** Validate the body of `GET /v1/flags/{id}` into a {@link FlagEntry}. */
export function parseFlag(payload: unknown): FlagEntry {
  return readFlag(payload, "The flag");
}

/** True while no moderation decision has settled the flag. */
export function isFlagOpen(flag: FlagEntry): boolean {
  return flag.status.toLowerCase() === "pending";
}

/**
 * Validate the body of `GET /v1/flags` into flags, open ones first.
 *
 * A body that is not a list is rejected rather than shown as "no flags": an
 * empty list would tell a moderator nothing is waiting when the truth is "we
 * do not know". A flag listed twice is shown once; the API's order is kept
 * within the open and the settled groups.
 */
export function parseFlags(payload: unknown): FlagEntry[] {
  if (!Array.isArray(payload)) {
    throw new FlagReadError("The API did not return a list of flags.");
  }
  const flags: FlagEntry[] = [];
  const seen = new Set<string>();
  payload.forEach((item, index) => {
    const flag = readFlag(item, `Flag ${index + 1}`);
    if (!seen.has(flag.id)) {
      seen.add(flag.id);
      flags.push(flag);
    }
  });
  return [
    ...flags.filter((flag) => isFlagOpen(flag)),
    ...flags.filter((flag) => !isFlagOpen(flag)),
  ];
}

/** `spam` → `Spam`, `bad_faith` → `Bad faith`; blank reads as no reason. */
export function formatFlagReason(reason: string): string {
  const words = reason.replace(/[_-]+/g, " ").trim();
  if (words === "") {
    return "No reason given";
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a flag stands, as an icon plus words (never colour alone). */
export function flagSignal(flag: FlagEntry): Signal {
  return isFlagOpen(flag)
    ? { tone: "warn", icon: "pending", text: "Waiting for a moderator" }
    : { tone: "ok", icon: "check", text: "Decided" };
}

/**
 * The decision view for what was flagged: `/mod/{target}`.
 *
 * The target may be a paper version, a discussion post, an annotation or a
 * review; the detail view reads the target's signed record and shows the
 * decision that fits it.
 */
export function flagDecisionHref(flag: FlagEntry): string {
  return modDetailHref(flag.targetCid);
}

/** Load every flag from `GET /v1/flags`; never cached, it is live work. */
export async function loadFlags(
  client: FlagsClient = api,
): Promise<FlagEntry[]> {
  const payload = await client.get<unknown>(FLAGS_ENDPOINT, {
    cache: "no-store",
  });
  return parseFlags(payload);
}

/** Load one flag from `GET /v1/flags/{id}`. */
export async function loadFlag(
  id: string,
  client: FlagsClient = api,
): Promise<FlagEntry> {
  const payload = await client.get<unknown>(
    `${FLAGS_ENDPOINT}/${encodeURIComponent(id.trim())}`,
    { cache: "no-store" },
  );
  return parseFlag(payload);
}

/**
 * Load every flag filed against one target, open and already decided.
 *
 * `GET /v1/flags?target={cid}&state=all` lists the flags on a version, a post,
 * a review or an annotation, so the decision view can show what the moderator
 * is deciding and how earlier flags on the same record ended. Tier 4 only,
 * like the list.
 */
export async function loadFlagsForTarget(
  target: string,
  client: FlagsClient = api,
): Promise<FlagEntry[]> {
  const query = `?target=${encodeURIComponent(target)}&state=all`;
  const payload = await client.get<unknown>(`${FLAGS_ENDPOINT}${query}`, {
    cache: "no-store",
  });
  return parseFlags(payload);
}

/** Reads the flags against one target; replaceable in tests. */
export type LoadTargetFlags = (
  target: string,
) => Promise<readonly FlagEntry[]>;

/** Why flags cannot be shown. */
export type FlagsFailure =
  | { readonly kind: "signed-out"; readonly message: string }
  | {
      readonly kind: "forbidden";
      readonly message: string;
      readonly callerTier: number | null;
    }
  /** The API has no flag list to read (`404`/`405` on `GET /v1/flags`). */
  | { readonly kind: "unsupported"; readonly message: string }
  /** The looked-up id is not a flag this account can read. */
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Sort a failed read into what the console should say.
 *
 * - `401` — the session is gone (the client already tried to refresh it).
 * - `403` — signed in but below tier 4; the API names the caller's tier.
 * - `404`/`405` on the **list** — this server serves flags by id only.
 * - `404` on a **lookup** — no such flag (the API answers a flag the caller
 *   may not read the same way, so ids cannot be probed).
 * - anything else — transport and server failures, said in one sentence.
 */
export function classifyFlagsError(
  error: unknown,
  mode: "list" | "lookup" = "list",
): FlagsFailure {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        kind: "signed-out",
        message: "Your session has ended. Sign in again to read flags.",
      };
    }
    if (error.isForbidden) {
      const tier = error.problem.caller_tier;
      return {
        kind: "forbidden",
        message: `Flags are for moderators (trust tier ${MODERATOR_TIER}).`,
        callerTier:
          typeof tier === "number" && Number.isInteger(tier) ? tier : null,
      };
    }
    if (mode === "list" && (error.status === 404 || error.status === 405)) {
      return {
        kind: "unsupported",
        message:
          "This server does not list flags yet, so they are not queued here. If you have a flag's id, open it below.",
      };
    }
    if (mode === "lookup" && error.status === 404) {
      return {
        kind: "not-found",
        message: "No flag with that id is on this server.",
      };
    }
    return {
      kind: "error",
      message: error.detail || error.title || "The API could not return the flags.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message:
        "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  if (error instanceof Error && error.message) {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "The flags could not be loaded." };
}
