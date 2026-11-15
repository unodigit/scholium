import { describe, expect, it } from "vitest";

import { NetworkError, apiErrorFrom } from "../../lib/api";

import {
  NO_REVIEWS_YET,
  classifyReviewsError,
  describeLoadError,
  loadReviews,
  reviewsPath,
  type ReviewsClient,
} from "./reviews-api";

/**
 * The one endpoint this feature calls, and what the tab says when it cannot
 * be read. The path is pinned against `apps/api/.../reviews/router.py`; the
 * messages against the calm-under-failure rule (docs/design.md §1) and the
 * API's own plain-language details.
 */

/** A client that answers from a script, recording `(path, options)`. */
function clientOf(payload: unknown | Error): ReviewsClient & {
  calls: Array<{ path: string; options: unknown }>;
} {
  const calls: Array<{ path: string; options: unknown }> = [];
  return {
    get: ((path: string, options?: unknown) => {
      calls.push({ path, options });
      return payload instanceof Error
        ? Promise.reject(payload)
        : Promise.resolve(payload);
    }) as ReviewsClient["get"],
    calls,
  };
}

const PAYLOAD = {
  paper: "sch:k3f9-q2xz-7mwd",
  version: 2,
  gate_open: false,
  reviews: [
    {
      review_cid: "bafyrei-a",
      label: "Reviewer A",
      recommendation: "minor_revisions",
      scores: { soundness: { score: 4 } },
    },
  ],
};

describe("reviewsPath", () => {
  it("reads a paper by any spelling the catalog accepts", () => {
    expect(reviewsPath("sch:k3f9-q2xz-7mwd")).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd/reviews",
    );
    expect(reviewsPath("k3f9-q2xz-7mwd")).toBe("/papers/k3f9-q2xz-7mwd/reviews");
  });

  it("splits off a version suffix: the endpoint's id is one segment", () => {
    expect(reviewsPath("sch:k3f9-q2xz-7mwd/v2")).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd/reviews",
    );
    expect(reviewsPath("k3f9-q2xz-7mwd/v12")).toBe(
      "/papers/k3f9-q2xz-7mwd/reviews",
    );
  });
});

describe("loadReviews", () => {
  it("GETs the paper's reviews anonymously and uncached, and parses them", async () => {
    const client = clientOf(PAYLOAD);

    const data = await loadReviews("sch:k3f9-q2xz-7mwd", undefined, { client });

    expect(client.calls).toEqual([
      {
        path: "/papers/sch%3Ak3f9-q2xz-7mwd/reviews",
        options: expect.objectContaining({ auth: false, cache: "no-store" }),
      },
    ]);
    expect(data.reviews[0].label).toBe("Reviewer A");
    expect(data.gateOpen).toBe(false);
  });

  it("passes the caller's abort signal through", async () => {
    const client = clientOf(PAYLOAD);
    const controller = new AbortController();

    await loadReviews("k3f9-q2xz-7mwd", controller.signal, { client });

    expect(client.calls[0].options).toMatchObject({ signal: controller.signal });
  });
});

describe("classifyReviewsError", () => {
  it("a 404 is the calm missing state, whatever its detail says", () => {
    for (const detail of [
      "No paper 'sch:…' on this node.",
      "No listed version for 'sch:…'.",
    ]) {
      expect(classifyReviewsError(apiErrorFrom(404, { detail }))).toEqual(
        NO_REVIEWS_YET,
      );
    }
  });

  it("keeps a rate limit's advice", () => {
    expect(classifyReviewsError(apiErrorFrom(429, {}))).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Wait a moment"),
    });
  });

  it("transport and server failures stay retryable errors with plain words", () => {
    expect(classifyReviewsError(new NetworkError("http://x"))).toMatchObject({
      kind: "error",
      message: expect.stringContaining("could not reach the API"),
    });
    expect(
      classifyReviewsError(apiErrorFrom(503, { detail: "upgrading" })),
    ).toMatchObject({ kind: "error", message: "upgrading" });
    expect(classifyReviewsError(new Error("boom"))).toMatchObject({
      kind: "error",
      message: "boom",
    });
  });

  it("describeLoadError is the message a route shows", () => {
    expect(describeLoadError(apiErrorFrom(404, {}))).toBe(NO_REVIEWS_YET.message);
  });
});
