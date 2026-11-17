/**
 * The conflict-of-interest checks shown above the review form
 * (docs/design.md §5.5, spec feature 166).
 *
 * `GET /v1/papers/{id}/coi-check` answers one question for the signed-in
 * reviewer: *may I review this paper without a conflict?* It returns three
 * checks — not an author, no recent co-authorship, a different institution —
 * each with a `status` of `pass`, `fail` or `unknown` and a sentence written
 * for the reviewer. The endpoint names no one else, so the page can show all
 * of it.
 *
 * The check is advisory: a conflict never refuses the commit by itself. The
 * commit endpoint decides who may review (an author gets `403`), and the
 * conflict is declared with the review. {@link describeConflictSummary} says
 * that plainly rather than pretending a red row is a locked door.
 *
 * Pure data and functions, no React: the component, the page and vitest share
 * this module.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** The three statuses the API reports. */
export type ConflictStatus = "pass" | "fail" | "unknown";

/** Every status, in the order the table below names them. */
export const CONFLICT_STATUSES: readonly ConflictStatus[] = [
  "pass",
  "fail",
  "unknown",
];

/** One check: its stable id, the design's label, and how it came out. */
export interface ConflictCheck {
  /** `not_author`, `no_recent_coauthorship` or `different_institution`. */
  readonly id: string;
  /** The design's words for the check ("Not an author of this paper"). */
  readonly label: string;
  readonly status: ConflictStatus;
  /** True only for `pass`; the API sends the same answer. */
  readonly passed: boolean;
  /** One sentence for the reviewer; it names no other person. */
  readonly detail: string;
}

/** The three checks for one reviewer on one paper. */
export interface ConflictReport {
  /** The paper the checks are about (`sch:…`). */
  readonly paper: string;
  /** True only when all three checks passed. */
  readonly clear: boolean;
  readonly checks: readonly ConflictCheck[];
  /** When the node ran the checks (ISO 8601, UTC), or `null` if not stamped. */
  readonly checkedAt: string | null;
}

/** Thrown when a body is not a conflict report. */
export class ConflictReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictReportError";
  }
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type ConflictClient = Pick<ApiClient, "get">;

/** How `ConflictCheck` reads the report; replaceable in tests. */
export type LoadConflictCheck = (paperId: string) => Promise<ConflictReport>;

/** The heading above the three checks (docs/design.md §5.5). */
export const CONFLICT_CHECK_TITLE = "Conflict check";

/** What one status says, in words, beside its icon. */
export interface ConflictStatusSpec {
  readonly label: string;
  readonly icon: "check" | "cross" | "question";
  /** The same thing for a screen reader; `label` already carries the meaning. */
  readonly description: string;
}

/**
 * Status words. The icon differs by state as well as the colour, so the
 * outcome never rests on colour alone (docs/design.md §9).
 */
export const CONFLICT_STATUS_SPECS: Readonly<
  Record<ConflictStatus, ConflictStatusSpec>
> = {
  pass: { label: "Passed", icon: "check", description: "This check passed." },
  fail: { label: "Conflict", icon: "cross", description: "This check found a conflict." },
  unknown: {
    label: "Couldn’t check",
    icon: "question",
    description: "This check could not be completed.",
  },
};

/** `GET /v1/papers/{id}/coi-check` for one paper. */
export function conflictEndpoint(paperId: string): string {
  return `/papers/${encodeURIComponent(paperId)}/coi-check`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readStatus(value: unknown, passed: unknown): ConflictStatus {
  if (value === "pass" || value === "fail" || value === "unknown") {
    return value;
  }
  // A body that only carries `passed` still says something useful.
  if (passed === true) return "pass";
  if (passed === false) return "fail";
  return "unknown";
}

function parseCheck(value: unknown): ConflictCheck | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const label = readText(value.label);
  if (id === null || label === null) return null;
  const status = readStatus(value.status, value.passed);
  return {
    id,
    label,
    status,
    passed: value.passed === true || status === "pass",
    detail: readText(value.detail) ?? "",
  };
}

/**
 * Read the body of `GET /v1/papers/{id}/coi-check`.
 *
 * A body with no checks is an error rather than an empty, falsely reassuring
 * panel: a conflict check that shows nothing must not read as "no conflicts".
 *
 * @throws {ConflictReportError} when the body is not a conflict report.
 */
export function parseConflictReport(payload: unknown): ConflictReport {
  if (!isRecord(payload) || !Array.isArray(payload.checks)) {
    throw new ConflictReportError("The API did not return a conflict check.");
  }

  const checks = payload.checks.flatMap((entry) => {
    const parsed = parseCheck(entry);
    return parsed === null ? [] : [parsed];
  });
  if (checks.length === 0) {
    throw new ConflictReportError("The conflict check came back empty.");
  }

  const clear =
    typeof payload.clear === "boolean"
      ? payload.clear
      : checks.every((check) => check.passed);

  return {
    paper: readText(payload.paper) ?? "",
    clear,
    checks,
    checkedAt: readText(payload.checked_at) ?? readText(payload.checkedAt),
  };
}

/**
 * Load the conflict checks for one paper.
 *
 * The answer depends on who asks, so the request carries the access token and
 * the API marks it `private, no-store`. A signed-out caller never reaches
 * here: {@link ConflictCheck} asks them to sign in instead.
 *
 * @throws {ApiError | NetworkError | ConflictReportError} if it cannot be read.
 */
export async function loadConflictCheck(
  paperId: string,
  client: ConflictClient = api,
): Promise<ConflictReport> {
  return parseConflictReport(
    await client.get<unknown>(conflictEndpoint(paperId), { cache: "no-store" }),
  );
}

/**
 * One sentence summarising the three checks, for the panel's lede.
 *
 * @param reviewed The reviewer already has a review of this paper (sealed or
 *   revealed). The clear result must not invite another one, since the API
 *   takes one review from each reviewer (REV-3).
 */
export function describeConflictSummary(
  report: ConflictReport,
  reviewed = false,
): string {
  const conflicts = report.checks.filter((check) => check.status === "fail");
  const unknown = report.checks.filter((check) => check.status === "unknown");

  if (conflicts.length > 0) {
    return conflicts.length === 1
      ? "One check found a conflict. A conflict is declared with the review; the node decides whether it can be committed."
      : `${conflicts.length} checks found a conflict. A conflict is declared with the review; the node decides whether it can be committed.`;
  }
  if (unknown.length > 0) {
    return unknown.length === 1
      ? "One check could not be completed. Add the missing profile detail, then check again."
      : `${unknown.length} checks could not be completed. Add the missing profile details, then check again.`;
  }
  return reviewed
    ? "No conflicts found. You already reviewed this paper."
    : "No conflicts found. You can review this paper.";
}

/** Why the checks could not be loaded, in one sentence for the reviewer. */
export function describeConflictError(error: unknown): string {
  if (error instanceof ConflictReportError) {
    return error.message;
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has ended. Sign in again to check for conflicts.";
    }
    if (error.status === 404) {
      return "This node has no listed paper with that id, so conflicts cannot be checked.";
    }
    return error.detail || error.title || "The conflict check could not be run.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "The conflict check could not be run.";
}
