/**
 * Appeals: moderation decisions an author has contested, and the panel that
 * decides each one.
 *
 * An appeal is a signed `appeal` record (`target` = the `moderation.decision`
 * being appealed, `grounds` = why). Once two of the three panel members agree,
 * the node signs an `appeal.decision` whose `target` is the appeal
 * (`apps/api/src/app/modules/appeals`). Every one of those records is in the
 * public log.
 *
 * The API has no endpoint that lists appeals, so the console reads them where
 * they are public: it replays `GET /v1/sync/range` — the same unauthenticated
 * log a mirror reads — and joins four record types in memory:
 *
 * | Record | Gives the console |
 * | --- | --- |
 * | `appeal` | the grounds, the appellant, when it was filed |
 * | `appeal.decision` | the panel's outcome and reasons (the appeal is then closed) |
 * | `moderation.decision` | what was decided, citing which clause and why |
 * | `paper.version` | the paper's title and `sch:` id |
 *
 * An appeal with no `appeal.decision` is **open**: the panel has not decided.
 * Only the log is read, so what the log cannot say is not guessed — which
 * members hold the seats, and how many have voted, are not in it (the vote
 * endpoint is the only thing that knows).
 *
 * Pure data and functions apart from {@link loadAppealCases}, no React.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { DECISION_ACTION_LABELS, isDecisionAction, parseVersionRecord } from "./decision";
import { isRecord, readReasons, readText } from "./wire";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const SYNC_RANGE_ENDPOINT = "/sync/range";

/** Entries asked for per page: the most `GET /v1/sync/range` returns. */
export const LOG_PAGE_SIZE = 1000;

/**
 * Pages read before the console stops and says so: 200 000 entries. A log that
 * long is past what a browser should replay on a page load, and stopping
 * silently would hide appeals, so the load reports `truncated` instead.
 */
export const MAX_LOG_PAGES = 200;

/** The record types the join needs; every other log entry is dropped as it streams in. */
export const LOG_RECORD_TYPES: ReadonlySet<string> = new Set([
  "appeal",
  "appeal.decision",
  "moderation.decision",
  "paper.version",
]);

/** Anything that can fetch the log; tests pass a narrow object with `get`. */
export type AppealsClient = Pick<ApiClient, "get">;

/** One log entry, reduced to what the join reads. */
export interface LogEntry {
  readonly seq: number;
  readonly cid: string;
  readonly type: string;
  readonly authorDid: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** When the node appended the record (ISO 8601), if the entry said. */
  readonly receivedAt: string | null;
}

/** The moderation decision that was appealed, as the public log records it. */
export interface AppealedDecision {
  /** `list`, `hold`, `reject`, … as signed. */
  readonly action: string;
  /** The policy clause cited, e.g. `MOD-01`. */
  readonly clause: string | null;
  /** The reason the moderator gave the author. */
  readonly reason: string | null;
  /** The moderator who signed it. */
  readonly moderatorDid: string;
  /** The version the decision was about, when the record names one. */
  readonly versionCid: string | null;
}

/** The paper behind an appealed decision. */
export interface AppealPaper {
  readonly title: string;
  /** `sch:xxxx-xxxx-xxxx/vN`, when known. */
  readonly versionId: string | null;
  readonly versionCid: string;
}

/** One member's vote as the panel's decision records it. */
export interface PanelVoteRecord {
  readonly did: string | null;
  readonly outcome: string | null;
  readonly reasons: readonly string[];
}

/** The panel's `appeal.decision`. */
export interface AppealVerdict {
  /** The `appeal.decision` record's cid. */
  readonly cid: string;
  readonly outcome: string;
  /** The agreeing members' reasons, as published. */
  readonly reasons: readonly string[];
  readonly votes: readonly PanelVoteRecord[];
  readonly decidedAt: string | null;
}

/** One appeal with everything the log says about it. */
export interface AppealCase {
  /** The `appeal` record's cid — the id a vote is cast on. */
  readonly appealCid: string;
  /** The `moderation.decision` being appealed. */
  readonly decisionCid: string;
  readonly appellantDid: string;
  readonly grounds: string;
  readonly filedAt: string | null;
  /** The appealed decision, or `null` when this server's log lacks it. */
  readonly original: AppealedDecision | null;
  /** The paper, or `null` when its version record is not in this log. */
  readonly paper: AppealPaper | null;
  /** The panel's decision, or `null` while the appeal is open. */
  readonly verdict: AppealVerdict | null;
}

/** What one load of the console's appeals found. */
export interface AppealsLoad {
  /** Open appeals first (oldest first), then decided ones (newest first). */
  readonly cases: readonly AppealCase[];
  /** The log was longer than {@link MAX_LOG_PAGES} pages; later entries are unread. */
  readonly truncated: boolean;
}

/** Raised when the log answers with something that is not a log page. */
export class AppealsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppealsLoadError";
  }
}

/** True while the panel has not decided the appeal. */
export function isAppealOpen(appeal: AppealCase): boolean {
  return appeal.verdict === null;
}

/**
 * Read one entry of `GET /v1/sync/range`; `null` for anything that is not a
 * complete entry (no `seq`, no cid, no type, or no object body), so one bad
 * entry cannot hide the appeals around it.
 */
export function readLogEntry(item: unknown): LogEntry | null {
  if (!isRecord(item)) {
    return null;
  }
  const seq = item.seq;
  const cid = readText(item.record_cid);
  const type = readText(item.record_type);
  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    cid === null ||
    type === null ||
    !isRecord(item.body)
  ) {
    return null;
  }
  return {
    seq,
    cid,
    type,
    authorDid: readText(item.author_did) ?? "",
    body: item.body,
    receivedAt: readText(item.received_at),
  };
}

function readAppealedDecision(entry: LogEntry): AppealedDecision {
  return {
    action: readText(entry.body.action) ?? "unknown",
    clause: readText(entry.body.clause),
    reason: readText(entry.body.reason),
    moderatorDid: entry.authorDid,
    versionCid: readText(entry.body.target),
  };
}

function readPaper(entry: LogEntry | undefined): AppealPaper | null {
  if (entry === undefined) {
    return null;
  }
  try {
    const paper = parseVersionRecord(
      { type: entry.type, id: entry.cid, body: entry.body },
      entry.cid,
    );
    return {
      title: paper.title,
      versionId: paper.versionId,
      versionCid: paper.versionCid,
    };
  } catch {
    // A version record the console cannot read is not a reason to hide the
    // appeal; it is shown by its decision instead of by a title.
    return null;
  }
}

function readVerdict(entry: LogEntry): AppealVerdict {
  const votes = Array.isArray(entry.body.votes)
    ? entry.body.votes.filter(isRecord).map((vote) => ({
        did: readText(vote.did),
        outcome: readText(vote.outcome),
        reasons: readReasons(vote.reasons ?? vote.reason),
      }))
    : [];
  return {
    cid: entry.cid,
    outcome: readText(entry.body.outcome) ?? "unknown",
    reasons: readReasons(entry.body.reasons ?? entry.body.reason),
    votes,
    decidedAt: entry.receivedAt,
  };
}

/**
 * Join log entries into appeals.
 *
 * Entries are taken in `seq` order, so "the first `appeal.decision` that
 * targets an appeal is its decision" holds here as it does in the API (a
 * panel decides once). An appeal with no readable `target` cannot be acted on
 * and is dropped; one whose decision or paper is missing from this log is
 * still shown, with the parts the log lacks left `null`.
 *
 * Open appeals come first, oldest first (a panel works them in the order they
 * were filed); decided ones follow, most recently decided first.
 */
export function buildAppealCases(entries: readonly LogEntry[]): AppealCase[] {
  const decisions = new Map<string, LogEntry>();
  const versions = new Map<string, LogEntry>();
  const verdicts = new Map<string, LogEntry>();
  const appeals: LogEntry[] = [];

  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    switch (entry.type) {
      case "moderation.decision":
        decisions.set(entry.cid, entry);
        break;
      case "paper.version":
        versions.set(entry.cid, entry);
        break;
      case "appeal.decision": {
        const appealCid =
          readText(entry.body.target) ?? readText(entry.body.appeal);
        if (appealCid !== null && !verdicts.has(appealCid)) {
          verdicts.set(appealCid, entry);
        }
        break;
      }
      case "appeal":
        appeals.push(entry);
        break;
    }
  }

  const seen = new Set<string>();
  const open: AppealCase[] = [];
  const decided: { appeal: AppealCase; seq: number }[] = [];

  for (const entry of appeals) {
    const decisionCid =
      readText(entry.body.target) ?? readText(entry.body.decision);
    if (decisionCid === null || seen.has(entry.cid)) {
      continue;
    }
    seen.add(entry.cid);

    const decisionEntry = decisions.get(decisionCid);
    const original =
      decisionEntry === undefined ? null : readAppealedDecision(decisionEntry);
    const verdictEntry = verdicts.get(entry.cid);
    const appeal: AppealCase = {
      appealCid: entry.cid,
      decisionCid,
      appellantDid: entry.authorDid,
      grounds: readText(entry.body.grounds) ?? "",
      filedAt: entry.receivedAt,
      original,
      paper:
        original?.versionCid == null
          ? null
          : readPaper(versions.get(original.versionCid)),
      verdict: verdictEntry === undefined ? null : readVerdict(verdictEntry),
    };

    if (verdictEntry === undefined) {
      open.push(appeal);
    } else {
      decided.push({ appeal, seq: verdictEntry.seq });
    }
  }

  decided.sort((a, b) => b.seq - a.seq);
  return [...open, ...decided.map(({ appeal }) => appeal)];
}

/**
 * Replay the public log and join it into appeals.
 *
 * Pages of {@link LOG_PAGE_SIZE} are read until a short page (the head) or
 * {@link MAX_LOG_PAGES}. The endpoint is public, so no bearer token is sent,
 * and nothing is cached: a panel decides on the log as it is now. Only the
 * four record types the join needs are kept as pages arrive.
 *
 * A full page whose entries do not advance `seq` would loop for ever, so it
 * is reported as a malformed log rather than retried.
 */
export async function loadAppealCases(
  client: AppealsClient = api,
): Promise<AppealsLoad> {
  const kept: LogEntry[] = [];
  let after = 0;
  let truncated = false;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_LOG_PAGES) {
      truncated = true;
      break;
    }
    const payload = await client.get<unknown>(SYNC_RANGE_ENDPOINT, {
      auth: false,
      cache: "no-store",
      query: { from: after, limit: LOG_PAGE_SIZE },
    });
    if (!Array.isArray(payload)) {
      throw new AppealsLoadError("The API did not return a page of the log.");
    }

    let lastSeq = after;
    for (const item of payload) {
      const entry = readLogEntry(item);
      if (entry === null) {
        continue;
      }
      lastSeq = Math.max(lastSeq, entry.seq);
      if (LOG_RECORD_TYPES.has(entry.type)) {
        kept.push(entry);
      }
    }

    if (payload.length < LOG_PAGE_SIZE) {
      break;
    }
    if (lastSeq <= after) {
      throw new AppealsLoadError(
        "The log did not advance between pages, so it cannot be read to its end.",
      );
    }
    after = lastSeq;
  }

  return { cases: buildAppealCases(kept), truncated };
}

/** What the panel's outcome means, in the words a moderator reads. */
const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  upheld: "Decision upheld",
  overturned: "Decision overturned",
  modified: "Decision modified",
  remanded: "Sent back to the moderators",
  granted: "Appeal granted",
  grant: "Appeal granted",
  denied: "Appeal denied",
  deny: "Appeal denied",
  allowed: "Appeal allowed",
  dismissed: "Appeal dismissed",
};

/** A panel outcome as words; an outcome this console does not know is shown as sent. */
export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

/** A moderation action as words (`reject` → "Reject the paper"); unknown actions as sent. */
export function actionLabel(action: string): string {
  return isDecisionAction(action) ? DECISION_ACTION_LABELS[action] : action;
}

/** One plain sentence for a log that could not be read. */
export function describeAppealsError(error: unknown): string {
  if (error instanceof ApiError) {
    return (
      error.detail || error.title || "The API could not return the appeals."
    );
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The appeals could not be loaded.";
}
