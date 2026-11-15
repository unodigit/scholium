import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, RecordSigningError } from "../web-auth/errors";
import {
  REVIEW_COMMIT_TYPE,
  ReviewCommitInputError,
  buildReviewCommit,
  canonicalJson,
  commitmentDigest,
  commitReview,
  describeCommitError,
  formatRevealDate,
  revealDateFor,
  reviewCommitment,
  reviewRevealBody,
} from "./commit";
import { reviewKeyFromSeed } from "./review-key";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  toReviewBody,
  withDimension,
  type ReviewDraft,
} from "./rubric";

const SEED = new Uint8Array(32).fill(9);
const KEY = reviewKeyFromSeed(SEED);
const VERSION = "bafyreiversion";

function completeDraft(): ReviewDraft {
  return RUBRIC_DIMENSIONS.reduce(
    (current, { id }, index) =>
      withDimension(current, id, {
        score: 3,
        justification: `Reasons ${index + 1}.`,
      }),
    {
      ...emptyDraft(),
      confidence: "medium",
      recommendation: "minor_revisions",
    } as ReviewDraft,
  );
}

const PLAIN_BODY = {
  target: VERSION,
  scores: {
    soundness: { score: 4, justification: "The proof is checked." },
    evidence: { score: 3, justification: "Two datasets." },
    reproducibility: { score: 2, justification: "No code." },
    novelty: { score: 4, justification: "A new angle." },
    clarity: { score: 5, justification: "Very clear." },
    limitations: { score: 3, justification: "Discussed." },
  },
  confidence: "medium",
  recommendation: "minor_revisions",
  aiAssisted: false,
};

describe("canonicalJson", () => {
  it("sorts keys at every level and writes no insignificant whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null, "x"], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[true,null,"x"]},"b":1}',
    );
  });

  it("does not escape non-ASCII text, as Python's ensure_ascii=False does", () => {
    expect(canonicalJson({ note: "naïve — 日本語" })).toBe(
      '{"note":"naïve — 日本語"}',
    );
  });

  it("refuses values JSON cannot carry", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(
      ReviewCommitInputError,
    );
    expect(() => canonicalJson({ f: undefined })).toThrow(
      ReviewCommitInputError,
    );
  });
});

describe("commitmentDigest", () => {
  it("matches the Python reveal commitment byte for byte", () => {
    // Expected value computed with
    // json.dumps(body, sort_keys=True, separators=(",", ":")) + sha256.
    expect(commitmentDigest(PLAIN_BODY)).toBe(
      "efbacbb9292162ec8c96ed55c9355afaef176a9e0d5649cb4985624ee6ae5d3b",
    );
  });

  it("leaves a commitment member out of its own hash", () => {
    expect(commitmentDigest({ ...PLAIN_BODY, commitment: "ignored" })).toBe(
      commitmentDigest(PLAIN_BODY),
    );
  });
});

describe("reviewRevealBody", () => {
  it("is the rubric plus the version the review targets", () => {
    const body = reviewRevealBody(toReviewBody(completeDraft()), VERSION);

    expect(body.target).toBe(VERSION);
    expect(body.confidence).toBe("medium");
    expect(body.recommendation).toBe("minor_revisions");
    expect(body.aiAssisted).toBe(false);
    expect(Object.keys(body.scores as object)).toEqual(
      RUBRIC_DIMENSIONS.map(({ id }) => id),
    );
  });

  it("makes the commitment depend on the review and the version", () => {
    const review = toReviewBody(completeDraft());
    const commitment = reviewCommitment(review, VERSION);

    expect(commitment).not.toBe(
      reviewCommitment(review, "bafyreiotherversion"),
    );
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildReviewCommit", () => {
  it("carries the target, the commitment, the nullifier and the review key", () => {
    const { body } = buildReviewCommit(completeDraft(), VERSION, KEY, "sch:abc");

    expect(body.target).toBe(VERSION);
    expect(body.commitment).toBe(
      reviewCommitment(toReviewBody(completeDraft()), VERSION),
    );
    expect(body.nullifier).toMatch(/^[0-9a-f]{64}$/);
    expect(body.reviewKey).toBe(KEY.did);
  });

  it("refuses a page that did not say which version to review", () => {
    expect(() =>
      buildReviewCommit(completeDraft(), "  ", KEY, "sch:abc"),
    ).toThrow(/which version/);
  });

  it("refuses an incomplete review before signing anything", () => {
    expect(() =>
      buildReviewCommit(emptyDraft(), VERSION, KEY, "sch:abc"),
    ).toThrow();
  });
});

describe("commitReview", () => {
  it("signs a review.commit with the derived key and submits it", async () => {
    const sign = vi.fn(async (type: string, body: Record<string, unknown>) => ({
      v: 1,
      type,
      id: "bafycommitted",
      author: KEY.did,
      created: "2026-11-23T00:00:00Z",
      prev: null,
      body,
      proofs: [],
      sig: "sig",
    }));
    const submit = vi.fn(async () => ({ id: "bafyaccepted" }));

    const result = await commitReview(
      { paperId: "sch:abc", versionCid: VERSION, draft: completeDraft() },
      { deriveKey: async () => KEY, sign, submit },
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toBe(REVIEW_COMMIT_TYPE);
    const body = sign.mock.calls[0][1] as Record<string, string>;
    expect(body.target).toBe(VERSION);
    expect(body.reviewKey).toBe(KEY.did);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.reviewCid).toBe("bafyaccepted");
  });

  it("reveals 21 days after the commit when the API does not say sooner", async () => {
    const result = await commitReview(
      { paperId: "sch:abc", versionCid: VERSION, draft: completeDraft() },
      {
        deriveKey: async () => KEY,
        sign: async (type, body) => ({
          v: 1,
          type,
          id: "bafycommitted",
          author: KEY.did,
          created: "2026-11-23T00:00:00Z",
          prev: null,
          body,
          proofs: [],
          sig: "sig",
        }),
        submit: async () => ({}),
      },
    );

    expect(result.revealAt).toBe("2026-12-14T00:00:00.000Z");
    expect(formatRevealDate(result.revealAt)).toBe("14 Dec");
  });

  it("takes an earlier reveal date the API reports", async () => {
    const result = await commitReview(
      { paperId: "sch:abc", versionCid: VERSION, draft: completeDraft() },
      {
        deriveKey: async () => KEY,
        sign: async (type, body) => ({
          v: 1,
          type,
          id: "bafycommitted",
          author: KEY.did,
          created: "2026-11-23T00:00:00Z",
          prev: null,
          body,
          proofs: [],
          sig: "sig",
        }),
        submit: async () => ({ reveal_at: "2026-12-01T00:00:00Z" }),
      },
    );

    expect(result.revealAt).toBe("2026-12-01T00:00:00Z");
  });

  it("refuses an incomplete review before deriving a key or prompting", async () => {
    const deriveKey = vi.fn();

    await expect(
      commitReview(
        { paperId: "sch:abc", versionCid: VERSION, draft: emptyDraft() },
        { deriveKey: deriveKey as never },
      ),
    ).rejects.toThrow();
    expect(deriveKey).not.toHaveBeenCalled();
  });

  it("refuses a missing target before deriving a key", async () => {
    const deriveKey = vi.fn();

    await expect(
      commitReview(
        { paperId: "sch:abc", versionCid: "", draft: completeDraft() },
        { deriveKey: deriveKey as never },
      ),
    ).rejects.toThrow(ReviewCommitInputError);
    expect(deriveKey).not.toHaveBeenCalled();
  });
});

describe("revealDateFor / formatRevealDate", () => {
  it("adds the reveal window in UTC, across a month boundary", () => {
    expect(revealDateFor("2026-11-23T12:00:00Z")).toBe(
      "2026-12-14T12:00:00.000Z",
    );
    expect(formatRevealDate("2026-12-14T12:00:00.000Z")).toBe("14 Dec");
  });

  it("leaves an unreadable date alone", () => {
    expect(formatRevealDate("not a date")).toBe("not a date");
  });
});

describe("describeCommitError", () => {
  it("says the prompt was cancelled and nothing was sent", () => {
    const error = new DeviceKeyError("passkey-cancelled", "dismissed");
    const failure = describeCommitError(error);

    expect(failure.message).toMatch(/cancelled/i);
    expect(failure.message).toContain("Nothing was sent.");
  });

  it("says this device cannot sign when it has no key", () => {
    expect(
      describeCommitError(new DeviceKeyError("not-found", "none")).message,
    ).toMatch(/no signing key/i);
  });

  it("offers sign-in when the session has ended", () => {
    const failure = describeCommitError(
      new ApiError(401, { detail: "Not authenticated" }),
    );

    expect(failure.signIn).toBe(true);
    expect(failure.message).toContain("Nothing was sent.");
  });

  it("explains a second review on the same paper", () => {
    const failure = describeCommitError(
      new ApiError(409, { detail: "Already reviewed." }),
    );

    expect(failure.message).toBe("Already reviewed. Nothing was sent.");
  });

  it("passes the API's refusal for an author through", () => {
    const failure = describeCommitError(
      new ApiError(403, { detail: "Only tier-3 non-authors may review." }),
    );

    expect(failure.message).toBe(
      "Only tier-3 non-authors may review. Nothing was sent.",
    );
  });

  it("explains an unreachable API", () => {
    expect(describeCommitError(new NetworkError("http://api")).message).toMatch(
      /could not reach the API/i,
    );
  });

  it("says nothing was sent when the record could not be prepared", () => {
    expect(
      describeCommitError(new RecordSigningError("invalid-record", "bad")).message,
    ).toContain("Nothing was sent.");
  });
});
