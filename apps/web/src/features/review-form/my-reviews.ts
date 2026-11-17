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
  /** Revealed, so its rubric and recommendation are public. */
  readonly revealed: boolean;
  /** The version the review was committed against, when named. */
  readonly version: number | null;
  /** The revealed recommendation, when there is one. */
  readonly recommendation: string | null;
  /** The revealed confidence, as served (a word or a number). */
  readonly confidence: number | string | null;
  /** The revealed rubric, as the dashboard serves it. */
  readonly scores: unknown;
  /** When the review was revealed, when it has been. */
  readonly revealedAt: string | null;
}

/** Reads the signed-in reviewer's reviews; {@link loadMyReviews} by default. */
export type LoadMyReviews = (signal?: AbortSignal) => Promise<readonly MyReview[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function readConfidence(value: unknown): number | string | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return readText(value);
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
    const revealed = row.revealed === true || state === "revealed";
    const sealed =
      !revealed && (row.sealed === true || state === "sealed");
    reviews.push({
      reviewCid: readText(row.review_cid) ?? readText(row.reviewCid),
      paper: readText(row.shortId) ?? readText(row.paper),
      versionCid: readText(row.version_cid) ?? readText(row.versionCid),
      sealed,
      revealed,
      version: readNumber(row.version ?? row.n),
      recommendation: readText(row.recommendation),
      confidence: readConfidence(row.confidence),
      scores: isRecord(row.scores) || Array.isArray(row.scores) ? row.scores : null,
      revealedAt: readText(row.revealedAt) ?? readText(row.revealed_at),
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

/**
 * The signed-in reviewer's review of `paperId` among `reviews`, sealed or
 * revealed, or `null`.
 *
 * A reviewer has at most one review of a paper (REV-3), so a revealed one is
 * just as final as a sealed one: the form must show it rather than a blank
 * Commit form the API would refuse.
 */
export function ownReviewOf(
  reviews: readonly MyReview[],
  paperId: string,
): MyReview | null {
  const wanted = paperKey(paperId);
  if (wanted === "") return null;
  return (
    reviews.find(
      (review) =>
        (review.sealed || review.revealed) &&
        review.paper !== null &&
        paperKey(review.paper) === wanted,
    ) ?? null
  );
}

/** The reviewer's own review as the public listing now serves it. */
export interface OwnReviewListing {
  /** cid of the `review.commit` the listing names (`review_cid`). */
  readonly reviewCid: string | null;
  /** cid of the newest `review.formal` — what an update's `prev` names. */
  readonly formalCid: string | null;
  /** The newest version the review is of (an update moves it forward). */
  readonly version: number | null;
  readonly recommendation: string | null;
  readonly confidence: unknown;
  readonly scores: unknown;
  readonly report: string | null;
  readonly revealedAt: string | null;
  /** Whether the listing serves reports for this version. */
  readonly gateOpen: boolean;
}

/** Reads the public listing for the reviewer's own review. */
export type LoadOwnReview = (
  paperId: string,
  reviewCid: string | null,
  signal?: AbortSignal,
) => Promise<OwnReviewListing | null>;

/** What the loader needs of the API client. */
export interface OwnReviewClient {
  get(
    path: string,
    options?: { auth?: boolean; cache?: RequestCache; signal?: AbortSignal },
  ): Promise<unknown>;
}

function reportText(value: unknown): string | null {
  const direct = readText(value);
  if (direct !== null) return direct;
  if (!isRecord(value)) return null;
  return readText(value.text) ?? readText(value.body) ?? readText(value.content);
}

/**
 * The reviewer's own review as `GET /v1/papers/{id}/reviews` serves it.
 *
 * The dashboard says which review is the caller's and whether it is revealed;
 * it does not carry the written report or the `review.formal` cid an update
 * needs. The public listing does, so it is read here and matched to the
 * caller's commit cid — the caller already knows which review is theirs, so
 * nothing about another reviewer's identity is disclosed.
 *
 * Resolves `null` when the listing does not carry the review (or when it was
 * never revealed); callers fall back to what the dashboard served.
 */
export async function loadOwnReviewListing(
  paperId: string,
  reviewCid: string | null,
  signal?: AbortSignal,
  client: OwnReviewClient = api,
): Promise<OwnReviewListing | null> {
  const wanted = readText(reviewCid);
  const id = paperId.trim();
  if (wanted === null || id === "") return null;

  const body = await client.get(
    `/papers/${encodeURIComponent(id)}/reviews`,
    { auth: false, cache: "no-store", signal },
  );
  const root = isRecord(body) ? body : {};
  const rows = Array.isArray(root.reviews) ? root.reviews : [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const served = readText(row.review_cid) ?? readText(row.reviewCid);
    if (served !== wanted) continue;
    return {
      reviewCid: served,
      formalCid:
        readText(row.formal_cid) ??
        readText(row.formalCid) ??
        readText(row.reveal_cid) ??
        readText(row.revealCid) ??
        readText(row.id),
      version: readNumber(row.version ?? row.n),
      recommendation: readText(row.recommendation) ?? readText(row.verdict),
      confidence: row.confidence ?? null,
      scores: row.scores ?? row.rubric ?? null,
      report: reportText(row.report),
      revealedAt: readText(row.revealed_at) ?? readText(row.revealedAt),
      gateOpen: root.gate_open === true || root.gateOpen === true,
    };
  }
  return null;
}
