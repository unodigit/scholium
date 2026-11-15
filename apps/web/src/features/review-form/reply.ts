/**
 * An author's point-by-point reply to a revealed review (spec feature 168,
 * docs/design.md §5.2; the API side is feature 114).
 *
 * A reply is a signed `review.response`: one reply per rubric dimension in
 * `items`, naming the review it answers in `review`. Like every write it is
 * signed on the device with the author's **own** key (not the reviewer's
 * pseudonymous key), behind one passkey prompt, then sent to
 * `POST /v1/reviews/{cid}/response` with the author's access token. Only
 * someone on the paper's byline may answer (`403` otherwise); the API decides.
 *
 * ```json
 * {"type": "review.response",
 *  "body": {"review": "<review cid>",
 *           "items": [{"dimension": "soundness", "reply": "…"}]}}
 * ```
 *
 * The API needs **at least one** non-blank reply and does not require every
 * dimension to be answered, so neither does the form: an author answers the
 * points that need an answer. `general` is the schema's slot for a reply to
 * the review as a whole.
 *
 * Pure functions plus injectable signing and submission seams, so the form
 * and vitest can drive the whole flow without a network or a passkey.
 */

import { api } from "../../lib/api";
import {
  signRecord,
  type SignedRecord,
  type SignRecordOptions,
} from "../web-auth/sign-record";
import {
  describeActionError,
  type ActionFailure,
  type ActionWords,
} from "./action-errors";
import { RUBRIC_DIMENSIONS, type DimensionId } from "./rubric";

/** The record type a reply signs. */
export const REVIEW_RESPONSE_TYPE = "review.response";

/** The schema's slot for a reply that answers the review as a whole. */
export const GENERAL_REPLY_ID = "general";

/** The heading of the form and of the button that opens it. */
export const REPLY_LABEL = "Reply point by point";

/** The button that signs and sends the reply (docs/design.md §8). */
export const REPLY_SUBMIT_LABEL = "Sign and submit";

/** Said beside the button so the author knows what signing does (design.md §8). */
export const REPLY_SIGNING_NOTE =
  "You’re signing with your passkey. Scholium never sees your key.";

/** A reply is keyed by a rubric dimension, or `general` for the whole review. */
export type ReplyPointId = DimensionId | typeof GENERAL_REPLY_ID;

/** One box in the reply form. */
export interface ReplyPoint {
  readonly id: ReplyPointId;
  /** The label shown to the author. */
  readonly label: string;
}

/**
 * The labels the review card shows beside each score. The reply form sits
 * inside that card, so it names a point the way the card does ("Soundness",
 * not the review form's "Soundness of method").
 */
const POINT_LABELS: Readonly<Record<DimensionId, string>> = {
  soundness: "Soundness",
  evidence: "Evidence",
  reproducibility: "Reproducibility",
  novelty: "Novelty",
  clarity: "Clarity",
  limitations: "Limitations & ethics",
};

/** The six rubric dimensions, in the rubric's order, then the general reply. */
export const REPLY_POINTS: readonly ReplyPoint[] = [
  ...RUBRIC_DIMENSIONS.map(
    ({ id }): ReplyPoint => ({ id, label: POINT_LABELS[id] }),
  ),
  { id: GENERAL_REPLY_ID, label: "General reply" },
];

/** What the author has typed, per point. A blank string is "not answered". */
export type ReplyDraft = Readonly<Record<ReplyPointId, string>>;

/** A draft with every box empty. */
export function emptyReplyDraft(): ReplyDraft {
  return Object.fromEntries(
    REPLY_POINTS.map(({ id }) => [id, ""]),
  ) as Record<ReplyPointId, string>;
}

/** `draft` with one box changed. */
export function withReply(
  draft: ReplyDraft,
  id: ReplyPointId,
  text: string,
): ReplyDraft {
  return { ...draft, [id]: text };
}

/** The points the author has answered, in form order. */
export function answeredPoints(draft: ReplyDraft): readonly ReplyPoint[] {
  return REPLY_POINTS.filter(({ id }) => (draft[id] ?? "").trim() !== "");
}

/** A reply can be sent once at least one point has words in it. */
export function isReplyComplete(draft: ReplyDraft): boolean {
  return answeredPoints(draft).length > 0;
}

/** The sentence under the form, e.g. `2 of 7 points answered`. */
export function describeReplyProgress(draft: ReplyDraft): string {
  const answered = answeredPoints(draft).length;
  if (answered === 0) {
    return "Answer at least one point to send a reply. Points you leave blank are not sent.";
  }
  return `${answered} of ${REPLY_POINTS.length} points answered. Points you leave blank are not sent.`;
}

/** There is nothing to send: every box is blank. */
export class EmptyReplyError extends Error {
  constructor() {
    super("Write a reply to at least one point before sending.");
    this.name = "EmptyReplyError";
  }
}

/** The reply cannot be built: the review it answers is not named. */
export class ReplyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyInputError";
  }
}

/** The signed record is not the response this card asked for. */
export class WrongReplyRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongReplyRecordError";
  }
}

/** One item of the body: the reply to one dimension. */
export interface ReplyItem {
  readonly dimension: ReplyPointId;
  readonly reply: string;
}

/** The body `POST /v1/reviews/{cid}/response` accepts. */
export interface ReviewResponseBody {
  /** The cid of the review being answered. */
  readonly review: string;
  /** One reply per answered point, in form order. */
  readonly items: readonly ReplyItem[];
  readonly [key: string]: unknown;
}

/**
 * Build the response body for a draft: only the answered points, in form
 * order, with the surrounding blank space trimmed.
 *
 * @throws {ReplyInputError} no review cid.
 * @throws {EmptyReplyError} every box is blank.
 */
export function buildReplyBody(
  reviewCid: string,
  draft: ReplyDraft,
): ReviewResponseBody {
  const review = reviewCid.trim();
  if (review === "") {
    throw new ReplyInputError(
      "This review has no id to answer. Reload the page and try again.",
    );
  }
  const items = answeredPoints(draft).map(
    ({ id }): ReplyItem => ({ dimension: id, reply: (draft[id] ?? "").trim() }),
  );
  if (items.length === 0) throw new EmptyReplyError();
  return { review, items };
}

/** What the reply produced, for the card to show. */
export interface ReplyResult {
  /** cid of the accepted `review.response` record. */
  readonly responseCid: string;
  /** The body that was signed. */
  readonly body: ReviewResponseBody;
  /** The signed record, for callers that need it. */
  readonly record: SignedRecord;
}

/** What the form hands to {@link respondToReview}. */
export interface ReplyInput {
  /** The review being answered (`review_cid` from the reviews listing). */
  readonly reviewCid: string;
  readonly draft: ReplyDraft;
}

/** Signs a `review.response`; `web-auth`'s `signRecord` by default. */
export type SignReplyRecord = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
  options?: SignRecordOptions,
) => Promise<SignedRecord>;

/** What `POST /v1/reviews/{cid}/response` answered; later fields are accepted. */
export interface ReplyAccepted {
  readonly [key: string]: unknown;
}

/** Sends the signed reply to the review it answers. */
export type SubmitReplyRecord = (
  reviewCid: string,
  record: SignedRecord,
) => Promise<ReplyAccepted>;

/** Replacement seams, for tests or another source. */
export interface ReplySeams {
  /** Signs the record; defaults to `signRecord`. */
  sign?: SignReplyRecord;
  /** Sends the record; defaults to `api.post`. */
  submit?: SubmitReplyRecord;
  /** Clock for the record's `created`, injectable for tests. */
  now?: () => number;
}

/** Replace the whole flow (sign and send), for tests or a host. */
export type RespondToReview = (
  input: ReplyInput,
  seams?: ReplySeams,
) => Promise<ReplyResult>;

/** The path a reply is sent to. */
export function responsePath(reviewCid: string): string {
  return `/reviews/${encodeURIComponent(reviewCid)}/response`;
}

const defaultSubmit: SubmitReplyRecord = (reviewCid, record) =>
  api.post<ReplyAccepted>(responsePath(reviewCid), record);

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Sign the author's reply and send it.
 *
 * Order: validate the draft (nothing is signed for an empty reply), sign the
 * `review.response` with the author's device key (one passkey prompt), then
 * send it. Nothing is sent until the record is signed.
 *
 * @throws {ReplyInputError} the review is not named.
 * @throws {EmptyReplyError} every box is blank.
 * @throws {WrongReplyRecordError} the signer produced another record.
 * @throws {DeviceKeyError} no key, a cancelled prompt or a failed signature.
 * @throws {ApiError | NetworkError} the API refused or could not be reached.
 */
export const respondToReview: RespondToReview = async (input, seams = {}) => {
  const sign = seams.sign ?? signRecord;
  const submit = seams.submit ?? defaultSubmit;

  // Validates before anything is signed; an empty reply never reaches the
  // passkey prompt.
  const body = buildReplyBody(input.reviewCid, input.draft);

  const record = await sign(REVIEW_RESPONSE_TYPE, body, null, {
    now: seams.now,
  });
  if (record.type !== REVIEW_RESPONSE_TYPE) {
    throw new WrongReplyRecordError(
      `The signer produced a ${record.type} record, not a ${REVIEW_RESPONSE_TYPE} record.`,
    );
  }

  const accepted = (await submit(body.review, record)) ?? {};
  const responseCid =
    readText(accepted.response_cid) ??
    readText(accepted.responseCid) ??
    readText(accepted.id) ??
    record.id;

  return { responseCid, body, record };
};

const REPLY_WORDS: ActionWords = {
  noun: "reply",
  forbidden:
    "Only a paper’s authors may reply to its reviews, and this account is not on the byline.",
  conflict: "This reply was already sent.",
};

/** One plain-language sentence for whatever a reply threw. */
export function describeReplyError(error: unknown): ActionFailure {
  if (error instanceof EmptyReplyError) {
    return { message: `${error.message} Nothing was sent.`, signIn: false };
  }
  if (error instanceof ReplyInputError) {
    return { message: `${error.message} Nothing was sent.`, signIn: false };
  }
  if (error instanceof WrongReplyRecordError) {
    return { message: `${error.message} Nothing was sent.`, signIn: false };
  }
  return describeActionError(error, REPLY_WORDS);
}
