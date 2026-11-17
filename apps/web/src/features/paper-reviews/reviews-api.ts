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
import { loadVersions } from "../paper-meta";

import { parseReviews, type ReviewsData } from "./review";

/** Anything shaped like the shared client's `get`. */
export type ReviewsClient = Pick<ApiClient, "get">;

/** The reviews loader; replaceable in tests. */
export type LoadReviews = (paperId: string, signal?: AbortSignal) => Promise<ReviewsData>;

/**
 * The path of a paper's reviews, for an id the endpoint can resolve in one
 * path segment.
 *
 * The endpoint resolves a listed paper, a paper genesis cid, or a *version
 * cid*; a `sch:…/vN` spelling cannot ride in one segment because the server
 * decodes `%2F` into a path separator. {@link loadReviews} therefore resolves
 * a version number to its cid first (see {@link splitTarget}).
 */
export function reviewsPath(paperId: string): string {
  return `/papers/${encodeURIComponent(paperId.trim())}/reviews`;
}

/** A paper spelling and the version it names, if it names one. */
export interface ReviewsTarget {
  /** The paper, without a `/vN` suffix. */
  readonly paper: string;
  /** The version number the id names; `null` for "the newest listed". */
  readonly version: number | null;
}

/** Split `sch:…/v2` into the paper id and version 2. */
export function splitTarget(paperId: string): ReviewsTarget {
  const text = paperId.trim();
  const match = /^(.+?)\/v([1-9][0-9]*)$/i.exec(text);
  return match === null
    ? { paper: text, version: null }
    : { paper: match[1], version: Number(match[2]) };
}

/** The cid of `version` in `paper`'s timeline, or a readable error. */
async function versionCidOf(
  paper: string,
  version: number,
  signal: AbortSignal | undefined,
  client: ReviewsClient,
): Promise<string> {
  const timeline = await loadVersions(paper, signal, client);
  const entry = timeline.versions.find((known) => known.n === version);
  if (entry === undefined) {
    throw new Error(`There is no listed version ${version} of this paper.`);
  }
  return entry.cid;
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
  const target = splitTarget(paperId);
  const requestSignal = signal ?? options?.signal ?? undefined;
  // A `/vN` URL names one version, and the endpoint's one-segment id cannot
  // carry it. Resolve it to the version's cid so /reviews/{id}/vN shows that
  // version's reviews rather than the newest one's.
  const resolved =
    target.version === null
      ? target.paper
      : await versionCidOf(target.paper, target.version, requestSignal, client);

  const payload = await client.get<unknown>(reviewsPath(resolved), {
    // Reading the page is anonymous; a stale session token must not be able
    // to hide public reviews behind a 401.
    auth: false,
    cache: "no-store",
    signal,
    ...options,
  });
  return parseReviews(payload);
}
