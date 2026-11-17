/**
 * What the node preserves, as its own public status tells it.
 *
 * `GET /v1/network` (apps/api network/summary.py) answers a `replicas` summary:
 * how many copies of the records the node holds (`have`), out of how many it is
 * configured to hold (`of`), and whether those copies all live on this one
 * server (`local`). On this single-node phase-1 deployment that is
 * `1 of 1 local`: honest, and the reason the paper page says so rather than
 * implying a multi-operator archive exists (PRD NET-3 is phase 2).
 *
 * The line this module words appears in two places (bug_spec_verify4 bug 4):
 * the paper header's facts row and the Proof tab's checklist, both linking to
 * `/network` — the transparency page that shows the same summary in full.
 *
 * Pure data and functions (plus one best-effort loader that never throws), no
 * React; the header island that renders it lives in `preservation-fact.tsx`.
 */

import { api, type ApiClient } from "../../lib/api";

/** The path of the public network status under `/v1`; the API client adds the prefix. */
export const NETWORK_PATH = "/network";

/** Where the paper page's preservation lines go: the transparency page. */
export const NETWORK_PAGE_HREF = "/network";

/** The node's replication summary, reduced to what a reader needs. */
export interface PreservationInfo {
  /** Copies of the records the node holds. */
  readonly have: number;
  /** Copies the node is configured to hold. */
  readonly of: number;
  /** All held copies live on this one server (no multi-operator replication). */
  readonly local: boolean;
}

/** What this deployment reports: one copy, held locally (phase 1, PRD NET-3). */
export const LOCAL_PRESERVATION: PreservationInfo = { have: 1, of: 1, local: true };

/** How the preservation line reads. */
export interface PreservationCopy {
  /** "Preserved: 1 of 1 local copy" — the state, in words. */
  readonly label: string;
  /** The honest qualifier when the only copy is local, else `null`. */
  readonly note: string | null;
  /** True when the node is short of its target (or its target is only itself). */
  readonly pending: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read the `replicas` summary of a network status document.
 *
 * A body that does not say — wrong shape, fractional counts, a target of zero
 * replicas — is `null`, never a guess: "we don't know" must not read as either
 * "fully preserved" or "losing data".
 */
export function parsePreservation(body: unknown): PreservationInfo | null {
  if (!isRecord(body) || !isRecord(body.replicas)) return null;
  const { have, of, local } = body.replicas;
  // A node holds at least one replica, so a target of 0 says nothing usable.
  if (!isCount(have) || !isCount(of) || of < 1 || typeof local !== "boolean") {
    return null;
  }
  return { have, of, local };
}

/** How the preservation state reads: the count in words, and why it is what it is. */
export function preservationCopy(info: PreservationInfo): PreservationCopy {
  const pending = info.local || info.have < info.of;
  if (info.local) {
    const copies = info.of === 1 ? "local copy" : "local copies";
    return {
      label: `Preserved: ${info.have} of ${info.of} ${copies}`,
      note: "Multi-operator replication is not enabled yet.",
      pending,
    };
  }
  const replicas = info.of === 1 ? "replica" : "replicas";
  return {
    label: `Preserved: ${info.have} of ${info.of} ${replicas}`,
    note: null,
    pending,
  };
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type PreservationClient = Pick<ApiClient, "get">;

/**
 * Read the node's replication summary. Public read, best effort: a node that
 * cannot be read answers `null`, because a missing status line must never
 * make the paper itself look unchecked.
 */
export async function loadPreservation(
  signal?: AbortSignal,
  client: PreservationClient = api,
): Promise<PreservationInfo | null> {
  try {
    const body = await client.get<unknown>(NETWORK_PATH, {
      auth: false,
      cache: "no-store",
      signal,
    });
    return parsePreservation(body);
  } catch {
    return null;
  }
}
