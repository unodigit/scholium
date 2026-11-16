/**
 * Which reviews are the signed-in reviewer's own.
 *
 * A reviewer's identity is escrowed: the reviews listing labels them "Reviewer
 * A" and never says who wrote what, and the node does not keep a plaintext
 * link from a person to a review. The one place that does answer "which of
 * these is mine" is the caller's own dashboard (`GET /v1/me/dashboard`), which
 * recomputes the escrow's uniqueness token for the signed-in account and
 * returns the reviews it matches, each `sealed` (committed, not revealed) or
 * `revealed`. The review form and the reviews tab ask it two things:
 *
 * - **Is there a sealed review of this paper by me?** When there is, and this
 *   browser holds nothing to reveal it with, the form cannot commit again (the
 *   API refuses a second review, `409`); it says so and offers to import the
 *   review key instead.
 * - **Is this listed review mine?** Only its reviewer is offered *Update for
 *   v{latest}*; everyone else would be sent to a form the API refuses.
 *
 * Both only choose which control to show. The API is the gate.
 */

import { api } from "../../lib/api";

/** One of the signed-in reviewer's reviews, as the dashboard lists it. */
export interface MyReview {
  /** cid of the `review.commit`; the id the reviews listing calls `review_cid`. */
  readonly reviewCid: string | null;
  /** The paper's short id, as served. */
  readonly paper: string | null;
  /** The version the review was committed against. */
  readonly versionCid: string | null;
  /** Committed, and not yet revealed. */
  readonly sealed: boolean;
}

/** Reads the signed-in reviewer's reviews; {@link loadMyReviews} by default. */
export type LoadMyReviews = (signal?: AbortSignal) => Promise<readonly MyReview[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The reviews in a dashboard payload. Never throws; anything odd reads as none. */
export function parseMyReviews(raw: unknown): MyReview[] {
  const root = isRecord(raw) ? raw : {};
  const rows = root.my_reviews ?? root.myReviews;
  if (!Array.isArray(rows)) return [];
  const reviews: MyReview[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const state = readText(row.state);
    const sealed =
      row.revealed === true
        ? false
        : row.sealed === true || state === "sealed";
    reviews.push({
      reviewCid: readText(row.review_cid) ?? readText(row.reviewCid),
      paper: readText(row.shortId) ?? readText(row.paper),
      versionCid: readText(row.version_cid) ?? readText(row.versionCid),
      sealed,
    });
  }
  return reviews;
}

/** What the loader needs of the API client. */
export interface MyReviewsClient {
  get<T = unknown>(
    path: string,
    options?: { cache?: RequestCache; signal?: AbortSignal },
  ): Promise<T>;
}

/**
 * The signed-in reviewer's reviews, from their dashboard. Needs a session; the
 * answer changes with every commit and reveal, so it is never cached.
 */
export async function loadMyReviews(
  signal?: AbortSignal,
  client: MyReviewsClient = api,
): Promise<MyReview[]> {
  const body = await client.get("/me/dashboard", { cache: "no-store", signal });
  return parseMyReviews(body);
}

/**
 * A paper's identity in any of its spellings: `sch:k3f9-q2xz-7mwd`, the bare
 * `k3f9-q2xz-7mwd`, or a version id `sch:k3f9-q2xz-7mwd/v2`.
 */
export function paperKey(paperId: string): string {
  return paperId
    .trim()
    .replace(/\/v\d+$/i, "")
    .replace(/^sch:/i, "")
    .toLowerCase();
}

/** The sealed review of `paperId` among `reviews`, or `null`. */
export function sealedReviewOf(
  reviews: readonly MyReview[],
  paperId: string,
): MyReview | null {
  const wanted = paperKey(paperId);
  if (wanted === "") return null;
  return (
    reviews.find(
      (review) =>
        review.sealed && review.paper !== null && paperKey(review.paper) === wanted,
    ) ?? null
  );
}
