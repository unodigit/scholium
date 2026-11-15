import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, RecordSigningError } from "../web-auth/errors";
import type { SignedRecord } from "../web-auth/sign-record";
import {
  EmptyReplyError,
  GENERAL_REPLY_ID,
  REPLY_POINTS,
  REVIEW_RESPONSE_TYPE,
  ReplyInputError,
  WrongReplyRecordError,
  answeredPoints,
  buildReplyBody,
  describeReplyError,
  describeReplyProgress,
  emptyReplyDraft,
  isReplyComplete,
  respondToReview,
  responsePath,
  withReply,
} from "./reply";
import { RUBRIC_DIMENSIONS } from "./rubric";

const REVIEW = "bafyreireviewcommit";

function signed(overrides: Partial<SignedRecord> = {}): SignedRecord {
  return {
    v: 1,
    type: REVIEW_RESPONSE_TYPE,
    id: "bafyreiresponse",
    author: "did:key:z6MkAuthor",
    created: "2026-11-16T00:00:00Z",
    prev: null,
    body: {},
    proofs: [],
    sig: "sig",
    ...overrides,
  };
}

describe("the reply points", () => {
  it("are the six rubric dimensions in the rubric's order, then a general reply", () => {
    expect(REPLY_POINTS.map((point) => point.id)).toEqual([
      ...RUBRIC_DIMENSIONS.map((dimension) => dimension.id),
      GENERAL_REPLY_ID,
    ]);
  });

  it("are named the way the review card names its scores", () => {
    expect(REPLY_POINTS.map((point) => point.label)).toEqual([
      "Soundness",
      "Evidence",
      "Reproducibility",
      "Novelty",
      "Clarity",
      "Limitations & ethics",
      "General reply",
    ]);
  });

  it("only use dimension keys the review.response schema allows", () => {
    // review.response.json: soundness, evidence, reproducibility, novelty,
    // clarity, limitations, general.
    expect(REPLY_POINTS.map((point) => point.id).sort()).toEqual(
      [
        "clarity",
        "evidence",
        "general",
        "limitations",
        "novelty",
        "reproducibility",
        "soundness",
      ].sort(),
    );
  });
});

describe("the reply draft", () => {
  it("starts with every point blank, so nothing is pre-answered", () => {
    const draft = emptyReplyDraft();
    for (const { id } of REPLY_POINTS) expect(draft[id]).toBe("");
    expect(isReplyComplete(draft)).toBe(false);
    expect(answeredPoints(draft)).toEqual([]);
  });

  it("changes one point without touching the others or the original", () => {
    const blank = emptyReplyDraft();
    const draft = withReply(blank, "evidence", "See Table 2.");

    expect(draft.evidence).toBe("See Table 2.");
    expect(draft.soundness).toBe("");
    expect(blank.evidence).toBe("");
  });

  it("is complete once any one point has words, and ignores blank space", () => {
    const blank = emptyReplyDraft();
    expect(isReplyComplete(withReply(blank, "clarity", "   \n "))).toBe(false);
    expect(isReplyComplete(withReply(blank, "clarity", "Reworded."))).toBe(true);
  });

  it("lists the answered points in form order, whatever order they were typed in", () => {
    let draft = emptyReplyDraft();
    draft = withReply(draft, "general", "Thank you.");
    draft = withReply(draft, "soundness", "Fixed.");

    expect(answeredPoints(draft).map((point) => point.id)).toEqual(["soundness", "general"]);
  });

  it("says how many points are answered and that blanks are not sent", () => {
    const blank = emptyReplyDraft();
    expect(describeReplyProgress(blank)).toMatch(/Answer at least one point/);
    expect(describeReplyProgress(withReply(blank, "novelty", "Yes."))).toBe(
      "1 of 7 points answered. Points you leave blank are not sent.",
    );
  });
});

describe("buildReplyBody", () => {
  it("names the review and sends one item per answered point, trimmed", () => {
    let draft = emptyReplyDraft();
    draft = withReply(draft, "evidence", "  The baseline is named in §3.2.  ");
    draft = withReply(draft, "general", "Thank you for the careful read.");

    expect(buildReplyBody(` ${REVIEW} `, draft)).toEqual({
      review: REVIEW,
      items: [
        { dimension: "evidence", reply: "The baseline is named in §3.2." },
        { dimension: "general", reply: "Thank you for the careful read." },
      ],
    });
  });

  it("leaves blank points out entirely: the API rejects an empty reply", () => {
    const body = buildReplyBody(REVIEW, withReply(emptyReplyDraft(), "clarity", "Done."));
    expect(body.items).toHaveLength(1);
  });

  it("refuses an empty reply", () => {
    expect(() => buildReplyBody(REVIEW, emptyReplyDraft())).toThrow(EmptyReplyError);
  });

  it("refuses a reply that does not say which review it answers", () => {
    const draft = withReply(emptyReplyDraft(), "clarity", "Done.");
    expect(() => buildReplyBody("  ", draft)).toThrow(ReplyInputError);
  });
});

describe("respondToReview", () => {
  const draft = withReply(emptyReplyDraft(), "soundness", "The proof is in Appendix B.");

  it("signs a review.response with no prev and sends it to the review's response path", async () => {
    const record = signed();
    const sign = vi.fn(async () => record);
    const submit = vi.fn(async () => ({ response_cid: "bafyreistored", status: "recorded" }));
    const now = () => 0;

    const result = await respondToReview(
      { reviewCid: REVIEW, draft },
      { sign, submit, now },
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(
      "review.response",
      { review: REVIEW, items: [{ dimension: "soundness", reply: "The proof is in Appendix B." }] },
      null,
      { now },
    );
    expect(submit).toHaveBeenCalledWith(REVIEW, record);
    expect(result.responseCid).toBe("bafyreistored");
    expect(result.body.items).toEqual([
      { dimension: "soundness", reply: "The proof is in Appendix B." },
    ]);
    expect(result.record).toBe(record);
  });

  it("falls back to the other spellings the API uses for the response id, then the record's own", async () => {
    const sign = async () => signed();

    expect(
      (await respondToReview({ reviewCid: REVIEW, draft }, { sign, submit: async () => ({ responseCid: "b" }) }))
        .responseCid,
    ).toBe("b");
    expect(
      (await respondToReview({ reviewCid: REVIEW, draft }, { sign, submit: async () => ({ id: "c" }) }))
        .responseCid,
    ).toBe("c");
    expect(
      (await respondToReview({ reviewCid: REVIEW, draft }, { sign, submit: async () => ({}) }))
        .responseCid,
    ).toBe("bafyreiresponse");
  });

  it("signs nothing and sends nothing for an empty reply", async () => {
    const sign = vi.fn(async () => signed());
    const submit = vi.fn(async () => ({}));

    await expect(
      respondToReview({ reviewCid: REVIEW, draft: emptyReplyDraft() }, { sign, submit }),
    ).rejects.toThrow(EmptyReplyError);

    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends nothing when signing fails or is cancelled", async () => {
    const submit = vi.fn(async () => ({}));
    const sign = vi.fn(async () => {
      throw new DeviceKeyError("passkey-cancelled", "dismissed");
    });

    await expect(respondToReview({ reviewCid: REVIEW, draft }, { sign, submit })).rejects.toThrow(
      "dismissed",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to send a record the signer made as something else", async () => {
    const submit = vi.fn(async () => ({}));
    const sign = vi.fn(async () => signed({ type: "review.rating" }));

    await expect(respondToReview({ reviewCid: REVIEW, draft }, { sign, submit })).rejects.toThrow(
      WrongReplyRecordError,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets an API refusal reach the caller", async () => {
    const refusal = new ApiError(403, { detail: "Only a paper author may respond." });
    const submit = vi.fn(async () => {
      throw refusal;
    });

    await expect(
      respondToReview({ reviewCid: REVIEW, draft }, { sign: async () => signed(), submit }),
    ).rejects.toBe(refusal);
  });

  it("posts to /reviews/{cid}/response", () => {
    expect(responsePath(REVIEW)).toBe(`/reviews/${REVIEW}/response`);
    expect(responsePath("a/b c")).toBe("/reviews/a%2Fb%20c/response");
  });
});

describe("describeReplyError", () => {
  it("says a cancelled passkey sent nothing", () => {
    const message = describeReplyError(new DeviceKeyError("passkey-cancelled", "x")).message;
    expect(message).toMatch(/Signing was cancelled/);
    expect(message).toMatch(/your reply was not sent/);
    expect(message).toMatch(/Nothing was sent\./);
  });

  it("explains a missing device key and a failed passkey", () => {
    expect(describeReplyError(new DeviceKeyError("not-found", "x")).message).toMatch(
      /no signing key/,
    );
    expect(describeReplyError(new DeviceKeyError("passkey-failed", "x")).message).toMatch(
      /passkey could not be confirmed/,
    );
    expect(describeReplyError(new RecordSigningError("invalid-record", "x")).message).toMatch(
      /Could not prepare the reply record\. Nothing was sent\./,
    );
  });

  it("offers sign-in when the session has ended", () => {
    const failure = describeReplyError(new ApiError(401, { detail: "expired" }));
    expect(failure.signIn).toBe(true);
    expect(failure.message).toMatch(/session has ended/);
  });

  it("shows the API's own words when a non-author is refused, and says nothing was sent", () => {
    const failure = describeReplyError(
      new ApiError(403, { detail: "Only a paper author may answer its reviews" }),
    );
    expect(failure.signIn).toBe(false);
    expect(failure.message).toBe(
      "Only a paper author may answer its reviews. Nothing was sent.",
    );
  });

  it("explains a refusal that has no words of its own", () => {
    expect(describeReplyError(new ApiError(403, {})).message).toMatch(
      /Only a paper’s authors may reply/,
    );
  });

  it("says when the review is not on this node", () => {
    expect(describeReplyError(new ApiError(404, {})).message).toMatch(/could not be found/);
  });

  it("passes on what the API says was wrong with the reply", () => {
    expect(
      describeReplyError(new ApiError(422, { detail: "A response reply cannot be empty." })).message,
    ).toBe("A response reply cannot be empty. Nothing was sent.");
  });

  it("says the API failed on a 5xx and an offline API separately", () => {
    expect(describeReplyError(new ApiError(503, {})).message).toMatch(/could not save the reply/);
    expect(describeReplyError(new NetworkError("http://api")).message).toMatch(
      /could not reach the API/,
    );
  });

  it("covers the local refusals", () => {
    expect(describeReplyError(new EmptyReplyError()).message).toBe(
      "Write a reply to at least one point before sending. Nothing was sent.",
    );
    expect(describeReplyError(new ReplyInputError("No id.")).message).toBe(
      "No id. Nothing was sent.",
    );
    expect(describeReplyError(new WrongReplyRecordError("Wrong.")).message).toBe(
      "Wrong. Nothing was sent.",
    );
  });

  it("never throws, whatever it is given", () => {
    for (const thing of [null, undefined, "boom", 7, {}, new Error("odd")]) {
      expect(describeReplyError(thing).message).toMatch(/Nothing was sent\.|could not be sent/);
    }
  });
});
