/**
 * Committing a review: seal it as a signed `review.commit` and read back the
 * date it will be revealed (spec feature 166, docs/design.md §5.5).
 *
 * A commit is the first half of a two-step commit–reveal. It carries:
 *
 * - `target` — the `paper.version` under review;
 * - `commitment` — SHA-256 over the canonical JSON of the `review.formal`
 *   body that will be revealed later, so the reveal is provably the review
 *   that was sealed;
 * - `nullifier` — a stable value for one reviewer and one paper, which the API
 *   uses to refuse a second review;
 * - `reviewKey` — the pseudonymous per-paper `did:key` the record is signed
 *   with (see `review-key.ts`).
 *
 * The records are signed on the device with the derived review key. Nothing
 * about the reviewer's device DID appears in the commit.
 *
 * The reveal date the page shows is the design's promise: a review is revealed
 * with the others when a second review is committed, or {@link
 * REVEAL_WINDOW_DAYS} days after the first commit. The client knows its own
 * commit's `created`; an API that reports an earlier reveal date wins.
 *
 * Pure functions plus injectable signing and submission seams, so the form and
 * vitest can drive the whole flow without a network or a passkey.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { ApiError, NetworkError, api } from "../../lib/api";
import {
  formatDayMonth as formatReaderDayMonth,
  toDate,
} from "../ui-kit/format-date";
import { isDeviceKeyError, isPasskeyCancellation, isRecordSigningError } from "../web-auth/errors";
import {
  signRecord,
  type RecordSigner,
  type SignedRecord,
  type SignRecordOptions,
} from "../web-auth/sign-record";
import { toUint8Array } from "../web-auth/encoding";
import {
  IncompleteReviewError,
  toReviewBody,
  type ReviewBody,
  type ReviewDraft,
} from "./rubric";
import {
  deriveReviewKey,
  nullifierForReviewKey,
  signWithReviewKey,
  type DeriveReviewKey,
  type ReviewKeyMaterial,
} from "./review-key";

/** The record type a commit signs. */
export const REVIEW_COMMIT_TYPE = "review.commit";

/** Days until a sealed review is revealed if no second review arrives. */
export const REVEAL_WINDOW_DAYS = 21;

/** The problem type the API uses for a second review by the same person. */
export const REVIEW_ALREADY_COMMITTED_TYPE =
  "urn:scholium:problem:review-already-committed";

/** What the form says when the API refuses a second review by the reviewer. */
export const ALREADY_REVIEWED_TEXT = "You already reviewed this paper.";

/** The heading after a successful commit (docs/design.md §5.5). */
export const SEALED_HEADLINE = "Your review is sealed";

/** The body `POST /v1/reviews/commit` accepts. */
export interface ReviewCommitBody {
  /** cid of the `paper.version` under review. */
  readonly target: string;
  /** SHA-256 over the canonical JSON of the review that will be revealed. */
  readonly commitment: string;
  /** `H(secret || paperId)`, lowercase hex. */
  readonly nullifier: string;
  /** The pseudonymous per-paper `did:key` that signed the commit. */
  readonly reviewKey: string;
  /** Envelope bodies are open objects; later features may add fields. */
  readonly [key: string]: unknown;
}

/** What the commit produced, for the form to show. */
export interface ReviewCommitResult {
  /** cid of the accepted `review.commit` record. */
  readonly reviewCid: string;
  /** When the review will be revealed (ISO 8601, UTC). */
  readonly revealAt: string;
  /**
   * The `review.formal` content the commitment seals. The reveal signs this
   * body with the commitment added (`reviewRevealBody`), so keep it: the form
   * keeps it on the device until the reviewer reveals the review.
   */
  readonly revealBody: Record<string, unknown>;
  /** The signed record, for callers that need it. */
  readonly record: SignedRecord;
  /** The body that was signed. */
  readonly body: ReviewCommitBody;
  /** The per-paper review key used to sign, when the flow returns it. */
  readonly key?: ReviewKeyMaterial;
}

/** What the form hands to {@link commitReview}. */
export interface ReviewCommitInput {
  /** The paper's id, in any spelling the API accepts. */
  readonly paperId: string;
  /** The newest listed version's cid, from `GET /v1/papers/{id}`. */
  readonly versionCid?: string | null;
  readonly draft: ReviewDraft;
}

/** Signs a `review.commit`; `web-auth`'s `signRecord` by default. */
export type SignCommitRecord = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
  options?: SignRecordOptions,
) => Promise<SignedRecord>;

/** What `POST /v1/reviews/commit` answered; later fields are accepted. */
export interface CommitAccepted {
  readonly [key: string]: unknown;
}

/** Sends the signed commit; `POST /v1/reviews/commit` by default. */
export type SubmitCommitRecord = (record: SignedRecord) => Promise<CommitAccepted>;

/** Replacement seams, for tests or another source. */
export interface ReviewCommitSeams {
  /** Derives the per-paper key; defaults to a passkey-backed derivation. */
  deriveKey?: DeriveReviewKey;
  /** Signs the record; defaults to `signRecord`. */
  sign?: SignCommitRecord;
  /** Sends the record; defaults to `api.post`. */
  submit?: SubmitCommitRecord;
  /** Clock for the record's `created`, injectable for tests. */
  now?: () => number;
}

/** The commit cannot be built: nothing was signed and nothing was sent. */
export class ReviewCommitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCommitInputError";
  }
}

/** The signed record is not the commit this page asked for. */
export class WrongCommitRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongCommitRecordError";
  }
}

const defaultSubmit: SubmitCommitRecord = (record) =>
  api.post<CommitAccepted>("/reviews/commit", record);

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Canonical JSON, matching Python's
 * `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 *
 * This is the byte string the commitment hashes, and `POST /v1/reviews/reveal`
 * recomputes it in Python. Keys are sorted at every level and there is no
 * insignificant whitespace. Only JSON values are accepted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!isFiniteNumber(value)) {
      throw new ReviewCommitInputError("A review cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    const members = entries.map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`,
    );
    return `{${members.join(",")}}`;
  }
  throw new ReviewCommitInputError(
    `A review cannot contain a ${typeof value} value.`,
  );
}

/**
 * The `review.formal` body a commit seals.
 *
 * The reveal later adds its `commitment` to this body and signs it; this is
 * the content the commitment must cover, so both halves build it here.
 *
 * `signed: true` is in the body only when the reviewer chose "Sign with my
 * name instead". The reveal API covers `signed` with the commitment of a first
 * reveal (a review revealed with a different `signed` than it sealed is
 * refused), and reads a missing flag as anonymous, so an anonymous review's
 * body — and its commitment — is the same as before the option existed.
 */
export function reviewRevealBody(
  review: ReviewBody,
  versionCid: string,
): Record<string, unknown> {
  const report = (review.report ?? "").trim();
  return {
    target: versionCid,
    scores: review.scores,
    confidence: review.confidence,
    recommendation: review.recommendation,
    aiAssisted: review.aiAssisted,
    // The written report is optional: a review without one seals exactly the
    // body it did before the option existed.
    ...(report !== "" ? { report } : {}),
    ...(review.signed ? { signed: true } : {}),
  };
}

/**
 * SHA-256 over the canonical JSON of `body`, with any `commitment` member
 * removed (a commitment cannot contain its own hash). Returns lowercase hex.
 */
export function commitmentDigest(body: Record<string, unknown>): string {
  const sealed = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "commitment"),
  );
  return bytesToHex(sha256(utf8(canonicalJson(sealed))));
}

/** The commitment for a finished review on a version. */
export function reviewCommitment(
  review: ReviewBody,
  versionCid: string,
): string {
  return commitmentDigest(reviewRevealBody(review, versionCid));
}

/**
 * Build the commit body for a finished draft.
 *
 * @throws {IncompleteReviewError} if the draft is not a complete review.
 * @throws {ReviewCommitInputError} if the page did not say which version.
 */
export function buildReviewCommit(
  draft: ReviewDraft,
  versionCid: string,
  key: ReviewKeyMaterial,
  paperId: string,
): { body: ReviewCommitBody; revealBody: Record<string, unknown> } {
  const target = versionCid.trim();
  if (target === "") {
    throw new ReviewCommitInputError(
      "This page did not say which version of the paper to review. Reload the page and try again.",
    );
  }

  const review = toReviewBody(draft);
  const revealBody = reviewRevealBody(review, target);
  return {
    revealBody,
    body: {
      target,
      commitment: commitmentDigest(revealBody),
      nullifier: nullifierForReviewKey(key, paperId),
      reviewKey: key.did,
    },
  };
}

/** A signer backed by the derived review key; no second passkey prompt. */
export function reviewRecordSigner(key: ReviewKeyMaterial): RecordSigner {
  return {
    didKey: async () => key.did,
    signWithPasskey: async (data) => signWithReviewKey(key, toUint8Array(data)),
  };
}

/** The day a review committed at `committedAt` is revealed, as ISO 8601. */
export function revealDateFor(
  committedAt: string,
  days: number = REVEAL_WINDOW_DAYS,
): string {
  // The shared `toDate` names the zone the API means for a timestamp without
  // a designator, so the window is added to the instant, never to a local
  // reading of it.
  const moment = toDate(committedAt);
  if (moment === null) {
    throw new ReviewCommitInputError(
      `The commit's date (${committedAt}) is not an instant.`,
    );
  }
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString();
}

/**
 * The design's short date: `"14 Dec"`.
 *
 * Written in the reader's own time zone through the shared `ui-kit` helper,
 * so the reveal day the reviewer is shown is the day the reviews page names
 * for the same instant (bug_spec_verify12 bug 2). A value that is not a date
 * is returned as sent.
 */
export function formatRevealDate(iso: string): string {
  return formatReaderDayMonth(iso) ?? iso;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Seal the review and send the signed commit.
 *
 * Order: validate the draft and the target, derive the per-paper key (one
 * passkey prompt), build and sign the record, then send it. Nothing is sent
 * until the record is signed.
 *
 * @throws {IncompleteReviewError} the draft is not a complete review.
 * @throws {ReviewCommitInputError} there is no version to target.
 * @throws {WrongCommitRecordError} the signer produced another record type.
 * @throws {DeviceKeyError} no key, a cancelled prompt or a failed signature.
 * @throws {ApiError | NetworkError} the API refused or could not be reached.
 */
export async function commitReview(
  input: ReviewCommitInput,
  seams: ReviewCommitSeams = {},
): Promise<ReviewCommitResult> {
  const versionCid = input.versionCid?.trim() ?? "";
  if (versionCid === "") {
    throw new ReviewCommitInputError(
      "This page did not say which version of the paper to review. Reload the page and try again.",
    );
  }

  const deriveKey = seams.deriveKey ?? deriveReviewKey;
  const sign = seams.sign ?? signRecord;
  const submit = seams.submit ?? defaultSubmit;
  const now = seams.now ?? (() => Date.now());

  // Validates the rubric before anything is signed; an incomplete review never
  // reaches the passkey prompt.
  toReviewBody(input.draft);

  const key = await deriveKey(input.paperId);
  const { body, revealBody } = buildReviewCommit(
    input.draft,
    versionCid,
    key,
    input.paperId,
  );

  const record = await sign(REVIEW_COMMIT_TYPE, body, null, {
    signer: reviewRecordSigner(key),
    now,
  });
  if (record.type !== REVIEW_COMMIT_TYPE) {
    throw new WrongCommitRecordError(
      `The signer produced a ${record.type} record, not a ${REVIEW_COMMIT_TYPE} record.`,
    );
  }
  if (record.prev !== null) {
    throw new WrongCommitRecordError(
      "The signer produced a commit chained to another record.",
    );
  }

  const accepted = (await submit(record)) ?? {};
  const reviewCid =
    readText(accepted.id) ??
    readText(accepted.review_cid) ??
    readText(accepted.reviewCid) ??
    record.id;
  const revealAt =
    readText(accepted.reveal_at) ??
    readText(accepted.revealAt) ??
    revealDateFor(record.created);

  return { reviewCid, revealAt, revealBody, record, body, key };
}

/** What the form shows when a commit fails: a sentence and an optional sign-in. */
export interface CommitFailure {
  readonly message: string;
  readonly signIn: boolean;
}

function failure(message: string, signIn = false): CommitFailure {
  return { message, signIn };
}

/** One plain-language sentence for whatever the commit threw. */
export function describeCommitError(error: unknown): CommitFailure {
  const sent = "Nothing was sent.";
  const cancelled = `Signing was cancelled, so your review was not committed. ${sent} Sign again when you are ready.`;

  if (isPasskeyCancellation(error)) {
    return failure(cancelled);
  }
  if (error instanceof ReviewCommitInputError) {
    return failure(error.message);
  }
  if (error instanceof IncompleteReviewError) {
    return failure(`Some parts of the review are still missing. ${sent}`);
  }
  if (error instanceof WrongCommitRecordError) {
    return failure(`${error.message} ${sent}`);
  }
  if (isDeviceKeyError(error)) {
    if (error.code === "passkey-cancelled") {
      return failure(cancelled);
    }
    return failure(
      error.code === "not-found"
        ? `This device has no signing key, so it cannot sign your review. ${sent}`
        : error.code === "passkey-failed"
          ? `The passkey could not be confirmed. ${sent} Try again.`
          : `Could not sign with this device’s key. ${sent}`,
    );
  }
  if (isRecordSigningError(error)) {
    return failure(`Could not prepare the commit record. ${sent}`);
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return failure(`Your session has ended. ${sent}`, true);
    }
    if (error.status === 403) {
      return failure(
        error.detail
          ? `${error.detail} ${sent}`
          : `Your account cannot review this paper. ${sent} Only tier-3 members who are not authors may commit a review.`,
      );
    }
    if (error.status === 409) {
      // The problem type is the reliable signal; the API's sentence is read as
      // well, so a node that predates the type still gets plain words.
      if (
        error.type === REVIEW_ALREADY_COMMITTED_TYPE ||
        /one review per paper/i.test(error.detail)
      ) {
        // The API's detail names the target record; a reviewer needs neither
        // the cid nor a second telling of the rule.
        return failure(`${ALREADY_REVIEWED_TEXT} ${sent}`);
      }
      return failure(
        error.detail
          ? `${error.detail} ${sent}`
          : `You have already reviewed this paper. ${sent}`,
      );
    }
    const detail = error.detail || error.title;
    return failure(
      detail ? `${detail} ${sent}` : `The API refused the review. ${sent}`,
    );
  }
  if (error instanceof NetworkError) {
    return failure(
      `Scholium could not reach the API. ${sent} Check your connection and try again.`,
    );
  }
  return failure(
    error instanceof Error && error.message
      ? error.message
      : `The review could not be committed. ${sent}`,
  );
}
