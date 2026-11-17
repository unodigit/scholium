/**
 * Revealing a sealed review (spec features 109 and 166, docs/design.md §5.5).
 *
 * A review is written in two steps. `POST /v1/reviews/commit` seals it as a
 * `review.commit` carrying a commitment; `POST /v1/reviews/reveal` opens it as
 * a signed `review.formal` whose content hashes to that commitment. Both are
 * signed by the reviewer's pseudonymous per-paper review key, so the record
 * says nothing about who wrote it.
 *
 * The API refuses a first reveal until the reveal gate is open: two
 * independent reviews committed on the version, or 21 days after the first.
 * The page therefore reads the public `GET /v1/papers/{id}/reviews` only to
 * choose whether to offer the action now; **the API is still the gate**, and a
 * refusal is shown in its own words.
 *
 * ```ts
 * const sealed = sealedReviewFromCommit(commitResult, paperId);
 * const { revealCid, reviewCid } = await revealReview({ sealed });
 * ```
 *
 * The per-paper key is derived again at reveal time (one passkey prompt); its
 * seed is never kept. Pure functions plus injectable seams, so the card and
 * vitest can drive the whole flow without a network or a passkey.
 */

import { ApiError, api } from "../../lib/api";
import {
  signRecord,
  type SignedRecord,
  type SignRecordOptions,
} from "../web-auth/sign-record";
import {
  describeActionError,
  NOT_SENT,
  type ActionFailure,
  type ActionWords,
} from "./action-errors";
import { describeCommitError, reviewRecordSigner, type CommitFailure } from "./commit";
import { deriveReviewKey, nullifierForReviewKey, type DeriveReviewKey } from "./review-key";
import type { SealedReview } from "./sealed-review";
import { toReviewBody, type ReviewDraft } from "./rubric";

/** The record type a reveal signs. */
export const REVIEW_FORMAL_TYPE = "review.formal";

/** The endpoint a reveal is posted to. */
export const REVEAL_ENDPOINT = "/reviews/reveal";

/** The button that opens the sealed review (docs/design.md §5.5). */
export const REVEAL_LABEL = "Reveal review";

/** Said when the reveal gate is still shut, so nothing was signed. */
export const REVEAL_GATE_CLOSED_NOTE =
  "The report gate is still closed for this version: a review can be revealed once a second review is committed on it.";

/** The heading once the reveal has been accepted. */
export const REVEALED_HEADLINE = "Your review is revealed";

/** What revealing publishes, in the design's words. */
export const REVEALED_TEXT =
  "The rubric and the report are now public, and the review appears on the paper’s Reviews tab.";

/** Said beside the button so the reviewer knows what signing does (design.md §8). */
export const REVEAL_SIGNING_NOTE =
  "You’re signing with your passkey. Scholium never sees your key.";

/** The body `POST /v1/reviews/reveal` accepts. */
export interface ReviewFormalBody {
  /** The commit's commitment; the revealed content hashes to it. */
  readonly commitment: string;
  /**
   * The sealed content: `target`, scores, confidence, recommendation and the
   * optional `signed` flag. It is copied from the commit unchanged.
   */
  readonly [key: string]: unknown;
}

/** The sealed review cannot be built: nothing was signed and nothing was sent. */
export class ReviewRevealInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRevealInputError";
  }
}

/** The signed record is not the reveal this page asked for. */
export class WrongRevealRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongRevealRecordError";
  }
}

/**
 * The body a reveal signs: the content the commit sealed, plus the commitment
 * it opened. The commitment is not part of its own digest, so nothing else
 * changes.
 *
 * @throws {ReviewRevealInputError} the sealed review carries no commitment, or
 *   no content — there is nothing to reveal.
 */
export function buildRevealBody(sealed: SealedReview): ReviewFormalBody {
  const commitment = sealed.commitment.trim();
  if (commitment === "") {
    throw new ReviewRevealInputError(
      "This review has no commitment to open. Reload the page and commit it again.",
    );
  }
  if (
    typeof sealed.revealBody !== "object" ||
    sealed.revealBody === null ||
    Array.isArray(sealed.revealBody)
  ) {
    throw new ReviewRevealInputError(
      "This review has no saved content to reveal. Reload the page and commit it again.",
    );
  }
  return { ...sealed.revealBody, commitment };
}

/** Signs a `review.formal`; `web-auth`'s `signRecord` by default. */
export type SignRevealRecord = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
  options?: SignRecordOptions,
) => Promise<SignedRecord>;

/** What `POST /v1/reviews/reveal` answered; later fields are accepted. */
export interface RevealAccepted {
  readonly [key: string]: unknown;
}

/** Sends the signed reveal; `POST /v1/reviews/reveal` by default. */
export type SubmitRevealRecord = (record: SignedRecord) => Promise<RevealAccepted>;

/** Replacement seams, for tests or another source. */
export interface RevealSeams {
  /** Derives the per-paper key; defaults to a passkey-backed derivation. */
  deriveKey?: DeriveReviewKey;
  /** Signs the record; defaults to `signRecord`. */
  sign?: SignRevealRecord;
  /** Sends the record; defaults to `api.post`. */
  submit?: SubmitRevealRecord;
  /** Clock for the record's `created`, injectable for tests. */
  now?: () => number;
}

/** What a reveal produced. */
export interface ReviewRevealResult {
  /** cid of the accepted `review.formal` record. */
  readonly revealCid: string;
  /** cid of the `review.commit` it opened. */
  readonly reviewCid: string;
  /** The body that was signed. */
  readonly body: ReviewFormalBody;
  /** The signed record, for callers that need it. */
  readonly record: SignedRecord;
}

/** What the card hands to {@link revealReview}. */
export interface ReviewRevealInput {
  readonly sealed: SealedReview;
}

/** Replace the whole flow (derive, sign and send), for tests or a host. */
export type RevealReview = (
  input: ReviewRevealInput,
  seams?: RevealSeams,
) => Promise<ReviewRevealResult>;

const defaultSubmit: SubmitRevealRecord = (record) =>
  api.post<RevealAccepted>(REVEAL_ENDPOINT, record);

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Sign the sealed review as a `review.formal` and send it.
 *
 * Order: build and check the body, derive the per-paper key (one passkey
 * prompt), sign the record, then send it. Nothing is sent until the record is
 * signed, and the same key that sealed the review signs the reveal.
 *
 * @throws {ReviewRevealInputError} there is no commitment or content.
 * @throws {WrongRevealRecordError} the signer produced another record type.
 * @throws {DeviceKeyError} no key, a cancelled prompt or a failed signature.
 * @throws {ApiError | NetworkError} the API refused or could not be reached.
 */
export const revealReview: RevealReview = async (input, seams = {}) => {
  const body = buildRevealBody(input.sealed);

  const deriveKey = seams.deriveKey ?? deriveReviewKey;
  const sign = seams.sign ?? signRecord;
  const submit = seams.submit ?? defaultSubmit;

  const key = await deriveKey(input.sealed.paperId.trim());
  const record = await sign(REVIEW_FORMAL_TYPE, body, null, {
    signer: reviewRecordSigner(key),
    now: seams.now,
  });
  if (record.type !== REVIEW_FORMAL_TYPE) {
    throw new WrongRevealRecordError(
      `The signer produced a ${record.type} record, not a ${REVIEW_FORMAL_TYPE} record.`,
    );
  }

  const accepted = (await submit(record)) ?? {};
  const revealCid =
    readText(accepted.id) ??
    readText(accepted.reveal_cid) ??
    readText(accepted.revealCid) ??
    record.id;
  const reviewCid =
    readText(accepted.review) ??
    readText(accepted.review_cid) ??
    readText(accepted.reviewCid) ??
    input.sealed.reviewCid;

  return { revealCid, reviewCid, body, record };
};

const REVEAL_WORDS: ActionWords = {
  noun: "reveal",
  forbidden: "Only the reviewer who sealed this review may reveal it.",
  conflict: "This review has already been revealed.",
};

/** One plain-language sentence for whatever a reveal threw. */
export function describeRevealError(error: unknown): ActionFailure {
  if (error instanceof ReviewRevealInputError || error instanceof WrongRevealRecordError) {
    return { message: `${error.message} ${NOT_SENT}`, signIn: false };
  }
  return describeActionError(error, REVEAL_WORDS);
}

/** Whether the reveal gate is open, and the version it was read for. */
export interface RevealGate {
  /** Two independent reviews are committed (or 21 days have passed). */
  readonly open: boolean;
  /** The cid of the version the answer is about, when the API names it. */
  readonly versionCid: string | null;
  /**
   * How many reviews are committed on that version, when the listing says.
   * `null` when the answer does not carry a list to count.
   */
  readonly committed?: number | null;
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export interface GateClient {
  get(path: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** Reads whether the reveal gate is open; {@link loadRevealGate} by default. */
export type LoadRevealGate = (
  paperId: string,
  signal?: AbortSignal,
) => Promise<RevealGate>;

/** Splits a `/vN` suffix off a version id: the endpoint wants the paper's id. */
function paperOf(paperId: string): string {
  const match = /^(.+?)\/v\d+$/.exec(paperId.trim());
  return match?.[1] ?? paperId.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The gate a reviews listing reports. A missing `gate_open` reads as shut. */
export function parseRevealGate(raw: unknown): RevealGate {
  const root = isRecord(raw) ? raw : {};
  const served = root.gate_open ?? root.gateOpen;
  const versionCid = readText(root.versionCid) ?? readText(root.version_cid);

  let committed: number | null = null;
  if (Array.isArray(root.reviews)) {
    const reviews = root.reviews.filter(isRecord);
    committed = reviews.filter((review) => {
      const version =
        readText(review.version_cid) ?? readText(review.versionCid);
      // A review carried from an older version is not a commit on this one.
      return version === null || versionCid === null || version === versionCid;
    }).length;
  } else if (typeof root.count === "number" && Number.isFinite(root.count)) {
    committed = root.count;
  }

  return {
    open: served === true,
    versionCid,
    committed,
  };
}

/**
 * Whether a sealed review on `paperId`'s resolved version may be revealed yet.
 *
 * The read is public and uncached: the gate changes with every commit. It only
 * chooses whether to offer the action — `POST /v1/reviews/reveal` decides.
 */
export async function loadRevealGate(
  paperId: string,
  signal?: AbortSignal,
  client: GateClient = api,
): Promise<RevealGate> {
  const body = await client.get(
    `/papers/${encodeURIComponent(paperOf(paperId))}/reviews`,
    { auth: false, cache: "no-store", signal },
  );
  return parseRevealGate(body);
}

// --------------------------------------------------------------------------- //
// Updating a revealed review against a newer version (REV-5)                    //
// --------------------------------------------------------------------------- //

/** What the form hands to {@link updateReview}. */
export interface UpdateReviewInput {
  /** The paper's id, in any spelling the API accepts. */
  readonly paperId: string;
  /** The newest listed version's cid, from `GET /v1/papers/{id}`. */
  readonly versionCid?: string | null;
  /** The cid of the earlier `review.formal` this one revises. */
  readonly prev: string;
  readonly draft: ReviewDraft;
}

/** What an update produced. */
export interface UpdateReviewResult {
  readonly revealCid: string;
  readonly reviewCid: string;
  readonly body: Record<string, unknown>;
  readonly record: SignedRecord;
}

/** Signs and sends an updated review; replaceable in tests. */
export type UpdateReview = (
  input: UpdateReviewInput,
  seams?: RevealSeams,
) => Promise<UpdateReviewResult>;

/**
 * Sign the revised review as a `review.formal` whose `prev` names the earlier
 * one, and post it to `POST /v1/reviews/reveal`.
 *
 * An update carries no commitment: the review it revises is already open.
 * It is signed by the same per-paper review key, so the chain stays one
 * reviewer's.
 */
export const updateReview: UpdateReview = async (input, seams = {}) => {
  const versionCid = input.versionCid?.trim() ?? "";
  if (versionCid === "") {
    throw new ReviewRevealInputError(
      "This page did not say which version of the paper to review. Reload the page and try again.",
    );
  }
  const prev = input.prev?.trim() ?? "";
  if (prev === "") {
    throw new ReviewRevealInputError(
      "This review has no earlier review to update. Reload the page and try again.",
    );
  }

  const review = toReviewBody(input.draft);

  const deriveKey = seams.deriveKey ?? deriveReviewKey;
  const sign = seams.sign ?? signRecord;
  const submit = seams.submit ?? defaultSubmit;
  const now = seams.now;

  const key = await deriveKey(input.paperId);
  const report = review.report.trim();
  const body: Record<string, unknown> = {
    target: versionCid,
    scores: review.scores,
    confidence: review.confidence,
    recommendation: review.recommendation,
    aiAssisted: review.aiAssisted,
    reviewKey: key.did,
    nullifier: nullifierForReviewKey(key, input.paperId),
    ...(report !== "" ? { report } : {}),
    ...(review.signed ? { signed: true } : {}),
  };

  const record = await sign(REVIEW_FORMAL_TYPE, body, prev, {
    signer: reviewRecordSigner(key),
    now,
  });
  if (record.type !== REVIEW_FORMAL_TYPE) {
    throw new WrongRevealRecordError(
      `The signer produced a ${record.type} record, not a ${REVIEW_FORMAL_TYPE} record.`,
    );
  }

  const accepted = (await submit(record)) ?? {};
  const revealCid =
    readText(accepted.id) ??
    readText(accepted.reveal_cid) ??
    readText(accepted.revealCid) ??
    record.id;
  const reviewCid =
    readText(accepted.review) ??
    readText(accepted.review_cid) ??
    readText(accepted.reviewCid) ??
    input.prev;

  return { revealCid, reviewCid, body, record };
};


/**
 * One plain-language sentence for a failed update.
 *
 * An update's `409` is the stale-page case: the reviewer already revised the
 * review, so `prev` no longer names the newest one. The API's detail is about
 * the `prev` field and means nothing to a reader, so it is replaced with what
 * happened and what to do.
 */
export function describeUpdateError(error: unknown): CommitFailure {
  if (error instanceof ApiError && error.status === 409) {
    return {
      message:
        "This review has already been updated since you opened this page. Reload the page to see the newest review. Nothing was sent.",
      signIn: false,
    };
  }
  return describeCommitError(error);
}

/** Alias for {@link updateReview}, for callers that name it otherwise. */
export const reviseReview = updateReview;
/** Alias for {@link updateReview}, for callers that name it otherwise. */
export const updateFormalReview = updateReview;
/** Alias for {@link updateReview}, for callers that name it otherwise. */
export const reviewUpdate = updateReview;
