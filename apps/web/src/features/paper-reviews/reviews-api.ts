/**
 * The reviews endpoint, called through the shared API client.
 *
 * * `GET /v1/papers/{id}/reviews` — a paper's formal reviews and their
 *   rubric scores, with report bodies sealed until the reveal gate opens
 *   (feature 110). Reading is anonymous, like reading a record, so the load
 *   does not attach a session and a stale token cannot hide a public page
 *   behind a `401`.
 *
 * The tab never decides who may read a review: the endpoint is public and
 * serves exactly what it means to serve. A `404` is the calm "no reviews yet"
 * state, not an error (docs/design.md §1); anything else worth retrying is
 * said in the API's own plain words.
 */

import {
  ApiError,
  NetworkError,
  api,
  type ApiClient,
  type ApiRequestOptions,
} from "../../lib/api";

import { parseReviews, type ReviewsData } from "./review";

/** Anything shaped like the shared client's `get`. */
export type ReviewsClient = Pick<ApiClient, "get">;

/** The reviews loader; replaceable in tests. */
export type LoadReviews = (paperId: string, signal?: AbortSignal) => Promise<ReviewsData>;

/**
 * The path of a paper's reviews.
 *
 * The endpoint resolves a listed paper or version id itself, but its
 * `{paper_id}` is one path segment and a version id's `/vN` is a second one.
 * The panel shows the paper's resolved listed version, whose number and cid
 * come back in the payload, so the canonical `/vN` suffix is split off and
 * the paper's own id is sent.
 */
export function reviewsPath(paperId: string): string {
  const id = paperId.trim();
  const versionMatch = /^(.+?)\/v\d+$/.exec(id);
  const paper = versionMatch !== null ? versionMatch[1] : id;
  return `/papers/${encodeURIComponent(paper)}/reviews`;
}

/** Why the reviews cannot be shown. */
export type ReviewsFailure =
  /** The paper is readable but has no reviews (yet, or on this node). */
  | { readonly kind: "missing"; readonly message: string }
  /** The reviews could not be fetched; worth trying again. */
  | { readonly kind: "error"; readonly message: string };

/** The calm state for a paper with no reviews: a state, not an error (§1). */
export const NO_REVIEWS_YET: ReviewsFailure = {
  kind: "missing",
  message: "No reviews have been committed on this paper yet.",
};

/** Sort a failed load into what the tab should say. */
export function classifyReviewsError(error: unknown): ReviewsFailure {
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      // "No such paper here" and "no reviews yet" lead the reader to the same
      // place: the calm empty state, with the invitation to review.
      return NO_REVIEWS_YET;
    }
    if (error.status === 429) {
      return {
        kind: "error",
        message: "Too many requests just now. Wait a moment and try again.",
      };
    }
    return {
      kind: "error",
      message: error.detail || error.title || "The reviews could not be read.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message: "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "The reviews could not be read." };
}

/** A reader-facing sentence for why the reviews could not be loaded. */
export function describeLoadError(error: unknown): string {
  return classifyReviewsError(error).message;
}

/** Options for {@link loadReviews}. */
export interface LoadReviewsOptions {
  /** The client to call through; defaults to the shared one. */
  client?: ReviewsClient;
  /** Extra request options (tests pin a `signal`). */
  options?: ApiRequestOptions;
}

/**
 * Fetch and parse a paper's formal reviews.
 *
 * Resolves for any payload shape (see `parseReviews`) and rejects only for
 * transport and HTTP failures, already sorted by
 * {@link classifyReviewsError}.
 */
export async function loadReviews(
  paperId: string,
  signal?: AbortSignal,
  { client = api, options }: LoadReviewsOptions = {},
): Promise<ReviewsData> {
  const payload = await client.get<unknown>(reviewsPath(paperId), {
    // Reading the page is anonymous; a stale session token must not be able
    // to hide public reviews behind a 401.
    auth: false,
    cache: "no-store",
    signal,
    ...options,
  });
  return parseReviews(payload);
}
