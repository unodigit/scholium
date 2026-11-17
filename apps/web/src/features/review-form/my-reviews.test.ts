import { describe, expect, it, vi } from "vitest";

import {
  loadMyReviews,
  loadOwnReviewListing,
  ownReviewOf,
  paperKey,
  parseMyReviews,
  sealedReviewOf,
  type MyReview,
  type MyReviewsClient,
} from "./my-reviews";

/**
 * The signed-in reviewer's own reviews, from `GET /v1/me/dashboard`: the only
 * place that says which reviews are theirs (the listing labels them
 * anonymously, and the node keeps no plaintext link from a person to a review).
 */

const ROW = {
  reviewCid: "bafycommit",
  review_cid: "bafycommit",
  state: "sealed",
  sealed: true,
  revealed: false,
  paper: "sch:6sel-2dio-orm6",
  shortId: "sch:6sel-2dio-orm6",
  version: 1,
  versionCid: "bafyv1",
  version_cid: "bafyv1",
  link: "/review/sch:6sel-2dio-orm6",
};

describe("parseMyReviews", () => {
  it("reads the dashboard's my_reviews", () => {
    expect(parseMyReviews({ my_reviews: [ROW] })).toEqual([
      {
        reviewCid: "bafycommit",
        paper: "sch:6sel-2dio-orm6",
        versionCid: "bafyv1",
        sealed: true,
        revealed: false,
        version: 1,
        recommendation: null,
        confidence: null,
        scores: null,
        revealedAt: null,
      },
    ]);
  });

  it("reads a revealed review's content, so the form can show it read-only", () => {
    const [review] = parseMyReviews({
      my_reviews: [
        {
          ...ROW,
          state: "revealed",
          sealed: false,
          revealed: true,
          recommendation: "minor_revisions",
          confidence: 3,
          scores: { soundness: { score: 4, justification: "Sound." } },
          revealedAt: "2027-03-02T05:00:00",
        },
      ],
    });

    expect(review).toMatchObject({
      sealed: false,
      revealed: true,
      version: 1,
      recommendation: "minor_revisions",
      confidence: 3,
      scores: { soundness: { score: 4, justification: "Sound." } },
      revealedAt: "2027-03-02T05:00:00",
    });
  });

  it("tells a revealed review from a sealed one", () => {
    const [sealed, revealed, stateOnly] = parseMyReviews({
      my_reviews: [
        ROW,
        { ...ROW, state: "revealed", sealed: false, revealed: true },
        { shortId: "sch:x", state: "sealed" },
      ],
    });

    expect(sealed.sealed).toBe(true);
    expect(revealed.sealed).toBe(false);
    expect(stateOnly.sealed).toBe(true);
  });

  it("does not call a review sealed that says it is revealed", () => {
    const [review] = parseMyReviews({
      my_reviews: [{ ...ROW, sealed: true, revealed: true }],
    });

    expect(review.sealed).toBe(false);
  });

  it("reads the camelCase spelling of the list too", () => {
    expect(parseMyReviews({ myReviews: [ROW] })).toHaveLength(1);
  });

  it.each([null, undefined, "text", 42, [], {}, { my_reviews: "none" }, { my_reviews: [null, 3] }])(
    "reads %j as no reviews, without throwing",
    (raw) => {
      expect(parseMyReviews(raw)).toEqual([]);
    },
  );
});

describe("loadMyReviews", () => {
  it("reads the dashboard fresh, with the session", async () => {
    const get = vi.fn(async () => ({ my_reviews: [ROW] }));
    const controller = new AbortController();

    const reviews = await loadMyReviews(controller.signal, {
      get: get as unknown as MyReviewsClient["get"],
    });

    expect(reviews).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/me/dashboard", {
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("lets a failure through, for the caller to treat as 'unknown'", async () => {
    const get = vi.fn(async () => {
      throw new Error("401");
    });

    await expect(loadMyReviews(undefined, { get })).rejects.toThrow("401");
  });
});

describe("paperKey", () => {
  it.each([
    "sch:k3f9-q2xz-7mwd",
    "k3f9-q2xz-7mwd",
    "SCH:K3F9-Q2XZ-7MWD",
    "sch:k3f9-q2xz-7mwd/v2",
    "  k3f9-q2xz-7mwd  ",
  ])("is one identity for the spelling %j", (spelling) => {
    expect(paperKey(spelling)).toBe("k3f9-q2xz-7mwd");
  });
});

describe("sealedReviewOf", () => {
  const sealed: MyReview = {
    reviewCid: "a",
    paper: "sch:k3f9-q2xz-7mwd",
    versionCid: "v1",
    sealed: true,
    revealed: false,
    version: 1,
    recommendation: null,
    confidence: null,
    scores: null,
    revealedAt: null,
  };
  const revealed: MyReview = { ...sealed, reviewCid: "b", sealed: false, revealed: true };
  const other: MyReview = { ...sealed, reviewCid: "c", paper: "sch:6sel-2dio-orm6" };

  it("finds the sealed review of the paper, however either is spelled", () => {
    expect(sealedReviewOf([other, sealed], "k3f9-q2xz-7mwd")).toBe(sealed);
    expect(sealedReviewOf([sealed], "sch:k3f9-q2xz-7mwd/v3")).toBe(sealed);
  });

  it("does not find a revealed review, or another paper's", () => {
    expect(sealedReviewOf([revealed], "sch:k3f9-q2xz-7mwd")).toBeNull();
    expect(sealedReviewOf([other], "sch:k3f9-q2xz-7mwd")).toBeNull();
  });

  it("finds nothing for a blank paper id, or a review that names no paper", () => {
    expect(sealedReviewOf([sealed], "  ")).toBeNull();
    expect(sealedReviewOf([{ ...sealed, paper: null }], "sch:k3f9-q2xz-7mwd")).toBeNull();
  });
});

describe("ownReviewOf", () => {
  const base: MyReview = {
    reviewCid: "a",
    paper: "sch:k3f9-q2xz-7mwd",
    versionCid: "v1",
    sealed: false,
    revealed: true,
    version: 1,
    recommendation: "sound_as_is",
    confidence: "high",
    scores: null,
    revealedAt: "2027-03-02T05:00:00",
  };

  it("finds a revealed review of the paper, so the form never shows a blank Commit form", () => {
    expect(ownReviewOf([base], "k3f9-q2xz-7mwd")).toBe(base);
    expect(ownReviewOf([base], "sch:k3f9-q2xz-7mwd/v3")).toBe(base);
  });

  it("returns the sealed one too, and ignores another paper's review", () => {
    const sealed = { ...base, reviewCid: "b", sealed: true, revealed: false };
    expect(ownReviewOf([sealed], "sch:k3f9-q2xz-7mwd")).toBe(sealed);
    expect(ownReviewOf([{ ...base, paper: "sch:6sel-2dio-orm6" }], "k3f9-q2xz-7mwd")).toBeNull();
  });
});

describe("loadOwnReviewListing", () => {
  it("reads the reviewer's latest review from the public listing", async () => {
    const get = vi.fn(async () => ({
      version: 2,
      gate_open: true,
      reviews: [
        {
          review_cid: "bafycommit",
          reveal_cid: "bafyformal2",
          version: 2,
          recommendation: "minor_revisions",
          confidence: "high",
          scores: { soundness: { score: 4, justification: "Still sound." } },
          report: "The revised report.",
          revealed_at: "2027-04-01T00:00:00",
        },
      ],
    }));

    const detail = await loadOwnReviewListing(
      "sch:6sel-2dio-orm6",
      "bafycommit",
      undefined,
      { get },
    );

    expect(get).toHaveBeenCalledWith("/papers/sch%3A6sel-2dio-orm6/reviews", {
      auth: false,
      cache: "no-store",
      signal: undefined,
    });
    expect(detail).toMatchObject({
      reviewCid: "bafycommit",
      formalCid: "bafyformal2",
      version: 2,
      recommendation: "minor_revisions",
      scores: { soundness: { score: 4, justification: "Still sound." } },
      report: "The revised report.",
      gateOpen: true,
    });
  });

  it("answers null when the listing does not carry the review", async () => {
    const get = vi.fn(async () => ({ reviews: [{ review_cid: "someone-else" }] }));

    await expect(
      loadOwnReviewListing("sch:6sel-2dio-orm6", "bafycommit", undefined, { get }),
    ).resolves.toBeNull();
  });
});
