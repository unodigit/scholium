/**
 * The panel vote: a drawn member's outcome and reasons for one appeal.
 *
 * Three members are drawn for each appeal (tier 3 or 4, never the deciding
 * moderator or an author). Each votes with `POST /v1/appeals/{cid}/votes`,
 * authenticated by their access token — the voter is the token's DID, never
 * anything in the body — and once two of the three back the same outcome the
 * node signs and appends the `appeal.decision`
 * (`apps/api/src/app/modules/appeals/votes.py`).
 *
 * What this module owns:
 *
 * - the four outcomes the form offers, each one the API accepts;
 * - the required-field rules and the exact body ({@link buildVoteBody});
 * - reading the `200` answer ({@link parseVoteAccepted});
 * - one plain sentence, and a kind, for every way a vote can fail
 *   ({@link describeVoteError}).
 *
 * **Who holds a seat is the API's call.** No endpoint says which members were
 * drawn, so the console cannot hide the form from the other readers; it
 * offers it and lets the API answer. A `403` is then "you are not on this
 * panel" — a plain outcome for most visitors, not a fault.
 *
 * Pure data and functions apart from {@link castPanelVote}.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { isRecord, readCount, readText } from "./wire";

/** Seats on a panel. */
export const PANEL_SIZE = 3;

/** Matching votes that decide an appeal. */
export const DECIDING_VOTES = 2;

/**
 * What the form says about publication, beside the form and again once a vote
 * is recorded. The panel's `appeal.decision` carries every vote and the
 * reasons given with it, so a member should know that before they vote.
 */
export const PANEL_RECORD_NOTICE =
  "The panel's decision is a public signed record. It includes each member's vote and reasons.";

/** The vote endpoint for one appeal, relative to `/v1`. */
export function voteEndpoint(appealCid: string): string {
  return `/appeals/${encodeURIComponent(appealCid)}/votes`;
}

/**
 * The outcomes the form offers, in form order.
 *
 * Each is one of the `appeal.decision` outcomes the API accepts as a vote
 * (`schemas/appeal.decision.json`); the rest of that vocabulary (`granted`,
 * `denied`, …) are synonyms the form does not need to offer.
 */
export const VOTE_CHOICES = [
  {
    value: "upheld",
    label: "Uphold the decision",
    hint: "The moderators were right and the decision stands.",
  },
  {
    value: "overturned",
    label: "Overturn the decision",
    hint: "The decision was wrong and should be reversed.",
  },
  {
    value: "modified",
    label: "Modify the decision",
    hint: "The decision should change in part. Say how in your reasons.",
  },
  {
    value: "remanded",
    label: "Send it back to the moderators",
    hint: "The moderators should decide again, taking your reasons into account.",
  },
] as const;

/** One outcome a member may back. */
export type VoteOutcome = (typeof VOTE_CHOICES)[number]["value"];

/** True when `value` is an outcome the form offers. */
export function isVoteOutcome(value: unknown): value is VoteOutcome {
  return VOTE_CHOICES.some((choice) => choice.value === value);
}

/** What the member has filled in so far. */
export interface VoteDraft {
  /** The chosen outcome, or `""` before one is chosen. */
  readonly outcome: VoteOutcome | "";
  /** The reasons, published with the panel's decision. */
  readonly reasons: string;
}

/** A blank draft. */
export const EMPTY_VOTE_DRAFT: VoteDraft = { outcome: "", reasons: "" };

/** A field of the form that can fail validation. */
export type VoteField = "outcome" | "reasons";

/** Field-level messages; empty when the draft is complete. */
export type VoteValidation = Partial<Record<VoteField, string>>;

/**
 * The rules the form enforces before it sends anything.
 *
 * The API needs only an outcome; the form also requires reasons, because the
 * panel's decision is a public record that publishes them, and a bare
 * "overturned" gives the author and the moderators nothing to answer.
 */
export function validateVoteDraft(draft: VoteDraft): VoteValidation {
  const errors: VoteValidation = {};
  if (!isVoteOutcome(draft.outcome)) {
    errors.outcome = "Choose the outcome you back.";
  }
  if (draft.reasons.trim() === "") {
    errors.reasons = "Give your reasons. They are published with the decision.";
  }
  return errors;
}

/** The body of `POST /v1/appeals/{cid}/votes`. */
export interface VoteBody {
  outcome: VoteOutcome;
  reasons: string;
}

/** Raised when an incomplete draft is turned into a request. */
export class VoteDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoteDraftError";
  }
}

/** Turn a complete draft into the request body; trimmed, never half-filled. */
export function buildVoteBody(draft: VoteDraft): VoteBody {
  if (!isVoteOutcome(draft.outcome)) {
    throw new VoteDraftError("Choose the outcome you back before voting.");
  }
  const reasons = draft.reasons.trim();
  if (reasons === "") {
    throw new VoteDraftError("Give your reasons before voting.");
  }
  return { outcome: draft.outcome, reasons };
}

/** The `200` body of the vote endpoint, in the form's terms. */
export interface VoteAccepted {
  readonly appealCid: string;
  /** The outcome this member now backs. */
  readonly outcome: string;
  /** Seats that now carry a vote, when the API said. */
  readonly votes: number | null;
  /** The `appeal.decision`'s cid once two seats agree, else `null`. */
  readonly decisionCid: string | null;
  /** The outcome the panel agreed on, once it has decided. */
  readonly decidedOutcome: string | null;
  /** When this vote was recorded (ISO 8601), when the API said. */
  readonly votedAt?: string | null;
}

/**
 * Read the API's answer.
 *
 * A `200` means the vote was recorded even if the body is unexpected, so a
 * missing field falls back to what was sent rather than turning a recorded
 * vote into an apparent failure.
 */
export function parseVoteAccepted(
  payload: unknown,
  fallback: { readonly appealCid: string; readonly outcome: string },
): VoteAccepted {
  const item = isRecord(payload) ? payload : {};
  return {
    appealCid: readText(item.appeal) ?? fallback.appealCid,
    outcome: readText(item.vote) ?? fallback.outcome,
    votes: readCount(item.votes),
    decisionCid: readText(item.decision),
    decidedOutcome: readText(item.outcome),
    votedAt: readText(item.votedAt) ?? readText(item.voted_at) ?? readText(item.created),
  };
}

/** Anything that can POST; the shared API client by default. */
export type VoteClient = Pick<ApiClient, "post">;

/** Casts a vote; replaceable in tests. */
export type VoteCaster = (
  appealCid: string,
  draft: VoteDraft,
) => Promise<VoteAccepted>;

/** Cast the member's vote on `POST /v1/appeals/{cid}/votes`. */
export async function castPanelVote(
  appealCid: string,
  draft: VoteDraft,
  client: VoteClient = api,
): Promise<VoteAccepted> {
  const body = buildVoteBody(draft);
  const payload = await client.post<unknown>(voteEndpoint(appealCid), body);
  return parseVoteAccepted(payload, { appealCid, outcome: body.outcome });
}

/** The fallback-decision endpoint for an appeal whose panel could not form. */
export function decideWithoutPanelEndpoint(appealCid: string): string {
  return `/appeals/${encodeURIComponent(appealCid)}/decide`;
}

/** Decides a panel-less appeal after its deadline; replaceable in tests. */
export type FallbackDecider = (
  appealCid: string,
  draft: VoteDraft,
) => Promise<VoteAccepted>;

/** Decide a panel-less appeal as a tier-4 moderator, without a panel. */
export async function decideAppealWithoutPanel(
  appealCid: string,
  draft: VoteDraft,
  client: VoteClient = api,
): Promise<VoteAccepted> {
  const body = buildVoteBody(draft);
  const payload = await client.post<unknown>(decideWithoutPanelEndpoint(appealCid), body);
  return parseVoteAccepted(payload, { appealCid, outcome: body.outcome });
}


/** Why a vote was not recorded, and what the form should do about it. */
export type VoteFailure =
  /** The session ended; the member must sign in again. */
  | { readonly kind: "signed-out"; readonly message: string }
  /** The account holds no seat on this panel; there is nothing to vote on. */
  | { readonly kind: "not-seated"; readonly message: string }
  /** Anything else; the form stays up so the member can try again. */
  | { readonly kind: "error"; readonly message: string };

/**
 * Sort a failed vote into a kind and one plain sentence.
 *
 * - `401` — the session is gone.
 * - `403` — the caller holds no seat on this appeal's panel.
 * - `404` — no such appeal is filed here.
 * - `409` — no panel is seated yet (too few eligible members).
 * - `422` — the API refused the outcome or reasons; its sentence is shown.
 * - `503` — a majority agreed but the server has no signing key; the votes
 *   already cast are kept and the decision is made on the next vote.
 */
export function describeVoteError(error: unknown): VoteFailure {
  if (error instanceof VoteDraftError) {
    return { kind: "error", message: error.message };
  }
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        kind: "signed-out",
        message: "Your session has ended. Sign in again to vote.",
      };
    }
    if (error.isForbidden) {
      return {
        kind: "not-seated",
        message:
          "You do not hold a seat on this appeal's panel, so you cannot vote on it. Only the three members drawn for it can.",
      };
    }
    if (error.status === 404) {
      return {
        kind: "error",
        message: "This appeal is not filed on this server.",
      };
    }
    if (error.status === 409) {
      return {
        kind: "error",
        message:
          "No panel has been seated for this appeal yet: there are not enough eligible members. Try again later.",
      };
    }
    if (error.status === 503) {
      return {
        kind: "error",
        message:
          "Two members agree, but this server has no signing key to publish the decision. Your vote is saved; vote again once the server operator has fixed that.",
      };
    }
    return {
      kind: "error",
      message:
        error.detail || error.title || "The API refused the vote. Nothing was recorded.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message:
        "Scholium could not reach the API, so the vote was not recorded. Try again.",
    };
  }
  if (error instanceof Error && error.message) {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "The vote could not be recorded." };
}
