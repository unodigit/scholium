import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import type { SignedRecord } from "../web-auth/sign-record";
import type { ReviewKeyMaterial } from "./review-key";
import {
  REVEAL_LABEL,
  REVIEW_FORMAL_TYPE,
  ReviewRevealInputError,
  WrongRevealRecordError,
  buildRevealBody,
  describeRevealError,
  describeUpdateError,
  loadRevealGate,
  revealReview,
  updateReview,
} from "./reveal";
import type { SealedReview } from "./sealed-review";
import {
  RUBRIC_DIMENSIONS,
  emptyDraft,
  withDimension,
  type ReviewDraft,
} from "./rubric";

/**
 * Revealing a sealed review (spec features 109/166, docs/design.md §5.5).
 *
 * Committing a review seals it as a `review.commit`; the review itself is only
 * published when it is revealed as a signed `review.formal` whose content
 * hashes to the commitment the commit sealed. Until `revealReview` existed the
 * web app never called `POST /v1/reviews/reveal`, so a review written in the
 * form could never be opened.
 *
 * The content, the key and the submission are injected, so these tests drive
 * the whole flow without a passkey or a network.
 */

const KEY: ReviewKeyMaterial = {
  did: "did:key:z6Mkreview",
  publicKey: new Uint8Array(32),
  seed: new Uint8Array(32).fill(1),
};

const SEALED: SealedReview = {
  paperId: "sch:6sel-2dio-orm6",
  versionCid: "bafyversion",
  reviewCid: "bafycommit",
  revealAt: "2026-12-14T00:00:00.000Z",
  commitment: "a1b2c3",
  revealBody: {
    target: "bafyversion",
    scores: {
      soundness: { score: 4, justification: "The design is sound." },
      evidence: { score: 3, justification: "One claim is unsupported." },
    },
    confidence: "high",
    recommendation: "sound_as_is",
    aiAssisted: false,
  },
};

function revealedRecord(
  body: Record<string, unknown> = {},
  type: string = REVIEW_FORMAL_TYPE,
): SignedRecord {
  return {
    v: 1,
    type,
    id: "bafyreveal",
    author: KEY.did,
    created: "2026-12-01T00:00:00Z",
    prev: null,
    body,
    proofs: [],
    sig: "sig",
  };
}

describe("buildRevealBody", () => {
  it("adds the commitment to the content the commit sealed, changing nothing else", () => {
    expect(buildRevealBody(SEALED)).toEqual({
      ...SEALED.revealBody,
      commitment: "a1b2c3",
    });
  });

  it("refuses a sealed review with no commitment", () => {
    expect(() => buildRevealBody({ ...SEALED, commitment: "  " })).toThrow(
      ReviewRevealInputError,
    );
  });
});

describe("revealReview", () => {
  it("signs a review.formal with the per-paper key and posts it to /v1/reviews/reveal", async () => {
    const deriveKey = vi.fn(async () => KEY);
    const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
      revealedRecord(body, type),
    );
    const submit = vi.fn(async () => ({
      id: "bafyreveal",
      review: "bafycommit",
      state: "revealed",
    }));

    const result = await revealReview({ sealed: SEALED }, { deriveKey, sign, submit });

    // The same key that sealed the review opens it: derived from this paper.
    expect(deriveKey).toHaveBeenCalledWith("sch:6sel-2dio-orm6");
    expect(sign.mock.calls[0][0]).toBe(REVIEW_FORMAL_TYPE);
    expect(sign.mock.calls[0][1]).toEqual({
      ...SEALED.revealBody,
      commitment: SEALED.commitment,
    });
    // A first reveal starts its own chain.
    expect(sign.mock.calls[0][2]).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0] as unknown[])[0]).toMatchObject({
      type: "review.formal",
      author: KEY.did,
    });

    expect(result.revealCid).toBe("bafyreveal");
    expect(result.reviewCid).toBe("bafycommit");
  });

  it("signs with the derived review key, without a second passkey prompt", async () => {
    const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null, _options) =>
      revealedRecord(body, type),
    );
    const submit = vi.fn(async () => ({}));

    await revealReview({ sealed: SEALED }, { deriveKey: async () => KEY, sign, submit });

    const options = (sign.mock.calls[0] as unknown[])[3] as {
      signer: { didKey: () => Promise<string> };
    };
    expect(await options.signer.didKey()).toBe(KEY.did);
  });

  it("sends nothing when the API refuses the reveal", async () => {
    const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
      revealedRecord(body, type),
    );
    const submit = vi.fn(async () => {
      throw new ApiError(409, {
        detail:
          "The report gate is still closed for this version: a review may be revealed only once two independent reviews have been committed on it (this version has 1).",
      });
    });

    await expect(
      revealReview({ sealed: SEALED }, { deriveKey: async () => KEY, sign, submit }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses to send a record the signer did not make a review.formal", async () => {
    const submit = vi.fn(async () => ({}));

    await expect(
      revealReview(
        { sealed: SEALED },
        {
          deriveKey: async () => KEY,
          sign: async (type: string, body: Record<string, unknown>, prev: string | null) =>
            revealedRecord(body, "review.commit"),
          submit,
        },
      ),
    ).rejects.toBeInstanceOf(WrongRevealRecordError);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("describeRevealError", () => {
  it("shows the API's own words when the gate is still closed", () => {
    const failure = describeRevealError(
      new ApiError(409, {
        detail:
          "The report gate is still closed for this version: a review may be revealed only once two independent reviews have been committed on it (this version has 1).",
      }),
    );

    expect(failure.message).toContain("report gate is still closed");
    expect(failure.message).toContain("Nothing was sent.");
    expect(failure.signIn).toBe(false);
  });

  it("offers a sign-in when the session has ended", () => {
    const failure = describeRevealError(new ApiError(401, {}));

    expect(failure.message).toContain("Your session has ended.");
    expect(failure.signIn).toBe(true);
  });

  it("says the review is already revealed, in the API's words", () => {
    const failure = describeRevealError(
      new ApiError(409, { detail: "This review has already been revealed." }),
    );

    expect(failure.message).toContain("This review has already been revealed.");
    expect(failure.message).toContain("Nothing was sent.");
  });
});

describe("updating a review", () => {
  const input = {
    paperId: "sch:6sel-2dio-orm6",
    versionCid: "bafyversion",
    prev: "bafyformal1",
    draft: RUBRIC_DIMENSIONS.reduce(
      (current, { id }) =>
        withDimension(current, id, { score: 3, justification: "Fine." }),
      {
        ...emptyDraft(),
        confidence: "high",
        recommendation: "sound_as_is",
        report: "The revised report.",
      } as ReviewDraft,
    ),
  };

  it("carries the written report on the update", async () => {
    const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
      revealedRecord(body, type),
    );
    const submit = vi.fn(async () => ({ id: "bafyreveal", review: "bafycommit" }));

    await updateReview(input, {
      deriveKey: vi.fn(async () => KEY),
      sign,
      submit,
    });

    expect(sign.mock.calls[0][1]).toMatchObject({ report: "The revised report." });
  });

  it("turns an already-updated refusal into plain words, not the API's `prev` message", () => {
    const failure = describeUpdateError(
      new ApiError(409, {
        detail:
          "This review has already been updated; point 'prev' at the reviewer's latest review.",
      }),
    );

    expect(failure.message).toContain("already been updated");
    expect(failure.message).toContain("Nothing was sent.");
    expect(failure.message).not.toContain("prev");
  });
});

describe("loadRevealGate", () => {
  const client = (payload: unknown) => ({ get: vi.fn(async () => payload) });

  it("reads gate_open and the version from the public reviews listing", async () => {
    const api = client({ gate_open: true, version_cid: "bafyversion", reviews: [] });

    const gate = await loadRevealGate("sch:6sel-2dio-orm6", undefined, api);

    expect(gate).toEqual({ open: true, versionCid: "bafyversion", committed: 0 });
    expect(api.get).toHaveBeenCalledTimes(1);
    const [path, options] = api.get.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/papers/sch%3A6sel-2dio-orm6/reviews");
    // A public read, never cached: the gate changes with every commit.
    expect(options).toMatchObject({ auth: false, cache: "no-store" });
  });

  it("drops a version suffix, because the endpoint takes the paper's id", async () => {
    const api = client({ gateOpen: false });

    await loadRevealGate("sch:6sel-2dio-orm6/v2", undefined, api);

    expect((api.get.mock.calls[0] as unknown as [string])[0]).toBe(
      "/papers/sch%3A6sel-2dio-orm6/reviews",
    );
  });

  it("reads a missing gate as closed", async () => {
    expect(await loadRevealGate("sch:6sel-2dio-orm6", undefined, client({}))).toEqual({
      open: false,
      versionCid: null,
      committed: null,
    });
  });

  it("says how many reviews are committed on the version the gate is about", async () => {
    const api = client({
      gate_open: false,
      version_cid: "bafyversion",
      reviews: [
        { review_cid: "a", version_cid: "bafyversion", revealed_at: null },
        // A revealed review carried from an older version is not a commit here.
        { review_cid: "b", version_cid: "bafyold", revealed_at: "2026-11-01T00:00:00" },
      ],
    });

    expect(await loadRevealGate("sch:6sel-2dio-orm6", undefined, api)).toMatchObject({
      open: false,
      committed: 1,
    });
  });
});

describe("the reveal label", () => {
  it("is the design's word for the action", () => {
    expect(REVEAL_LABEL).toBe("Reveal review");
  });
});
