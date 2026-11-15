/**
 * A tier-3 member's quality rating of a revealed review (spec feature 168,
 * docs/design.md §5.2; the API side is feature 113).
 *
 * `POST /v1/reviews/{cid}/rating` takes `{"rating": 1–5}` with the member's
 * access token. The API decides who may rate: a tier-3 member who is neither
 * the review's own reviewer nor an author of the paper (`403` otherwise). The
 * rating is about the review's quality, not its verdict, and affects the
 * reviewer's reputation only (PRD REV-6).
 *
 * The API keeps one rating per member per review (its primary key is the
 * review and the rater), so a rating is a single decision: the control does
 * not offer to change one, and a repeat is explained rather than retried.
 *
 * Pure functions plus an injectable submission seam.
 */

import { api } from "../../lib/api";
import {
  describeActionError,
  NOT_SENT,
  type ActionFailure,
  type ActionWords,
} from "./action-errors";
import { SCORES, SCORE_MAX, type Score } from "./rubric";

/** The legend of the control. */
export const RATING_LABEL = "Rate this review’s quality";

/** What the scale and the rating mean, so a rater knows what they are doing. */
export const RATING_HINT =
  "1 is a review that does not help, 5 is one that sharpens the paper. You rate the review, not the paper; it affects the reviewer’s reputation only.";

/** The button that sends the rating. */
export const RATING_SUBMIT_LABEL = "Send rating";

/** The ratings, in the order the radios appear (the rubric's own 1–5). */
export const RATING_VALUES: readonly Score[] = SCORES;

/** The text equivalent of a rating: `4 of 5`. */
export function ratingText(rating: number): string {
  return `${rating} of ${SCORE_MAX}`;
}

/** The rating is not an integer from 1 to 5: nothing is sent. */
export class InvalidRatingError extends Error {
  constructor() {
    super(`Choose a rating from 1 to ${SCORE_MAX}.`);
    this.name = "InvalidRatingError";
  }
}

/** The rating cannot be sent: the review it rates is not named. */
export class RatingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatingInputError";
  }
}

/** True for an integer from 1 to 5. */
export function isRating(value: unknown): value is Score {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= SCORE_MAX
  );
}

/** What the control hands to {@link rateReview}. */
export interface RatingInput {
  /** The review being rated (`review_cid` from the reviews listing). */
  readonly reviewCid: string;
  readonly rating: number;
}

/** What the rating produced, for the card to show. */
export interface RatingResult {
  /** The review that was rated. */
  readonly reviewCid: string;
  /** The rating the API recorded. */
  readonly rating: Score;
}

/** What `POST /v1/reviews/{cid}/rating` answered; later fields are accepted. */
export interface RatingAccepted {
  readonly [key: string]: unknown;
}

/** Sends the rating for the review it rates. */
export type SubmitRating = (
  reviewCid: string,
  rating: Score,
) => Promise<RatingAccepted>;

/** Replacement seams, for tests or another source. */
export interface RatingSeams {
  /** Sends the rating; defaults to `api.post`. */
  submit?: SubmitRating;
}

/** Replace the whole flow, for tests or a host. */
export type RateReview = (
  input: RatingInput,
  seams?: RatingSeams,
) => Promise<RatingResult>;

/** The path a rating is sent to. */
export function ratingPath(reviewCid: string): string {
  return `/reviews/${encodeURIComponent(reviewCid)}/rating`;
}

const defaultSubmit: SubmitRating = (reviewCid, rating) =>
  api.post<RatingAccepted>(ratingPath(reviewCid), { rating });

/**
 * Send the member's rating of a review.
 *
 * @throws {RatingInputError} the review is not named.
 * @throws {InvalidRatingError} the rating is not an integer from 1 to 5.
 * @throws {ApiError | NetworkError} the API refused or could not be reached.
 */
export const rateReview: RateReview = async (input, seams = {}) => {
  const reviewCid = input.reviewCid.trim();
  if (reviewCid === "") {
    throw new RatingInputError(
      "This review has no id to rate. Reload the page and try again.",
    );
  }
  if (!isRating(input.rating)) throw new InvalidRatingError();

  const accepted = (await (seams.submit ?? defaultSubmit)(
    reviewCid,
    input.rating,
  )) ?? {};

  // The API echoes what it recorded; trust that over what was asked.
  const recorded = isRating(accepted.rating) ? accepted.rating : input.rating;
  return { reviewCid, rating: recorded };
};

const RATING_WORDS: ActionWords = {
  noun: "rating",
  forbidden:
    "Only tier-3 members who did not write this review and are not authors of the paper may rate it.",
  conflict: "You have already rated this review. Your first rating stands.",
  // The API keeps one rating per member per review and a repeat surfaces as a
  // server failure, so "try again" would be the wrong advice.
  serverError:
    "Scholium could not save the rating. If you have already rated this review, your first rating stands. Otherwise try again in a moment.",
};

/** One plain-language sentence for whatever a rating threw. */
export function describeRatingError(error: unknown): ActionFailure {
  if (error instanceof InvalidRatingError || error instanceof RatingInputError) {
    return { message: `${error.message} ${NOT_SENT}`, signIn: false };
  }
  return describeActionError(error, RATING_WORDS);
}
