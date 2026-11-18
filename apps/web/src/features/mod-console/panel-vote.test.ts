import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  DECIDING_VOTES,
  EMPTY_VOTE_DRAFT,
  PANEL_RECORD_NOTICE,
  PANEL_SIZE,
  VOTE_CHOICES,
  VoteDraftError,
  buildVoteBody,
  castPanelVote,
  describeVoteError,
  isVoteOutcome,
  parseVoteAccepted,
  validateVoteDraft,
  voteEndpoint,
} from "./panel-vote";

/** The outcomes `apps/api/.../appeals/votes.py` accepts as a vote. */
const API_VOTE_OUTCOMES = [
  "upheld",
  "overturned",
  "modified",
  "remanded",
  "granted",
  "grant",
  "denied",
  "deny",
  "allowed",
  "dismissed",
];

describe("the vote choices", () => {
  it("offers only outcomes the API accepts, each once, each with words", () => {
    const values = VOTE_CHOICES.map((choice) => choice.value);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(API_VOTE_OUTCOMES).toContain(value);
    }
    for (const choice of VOTE_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.hint.length).toBeGreaterThan(0);
    }
  });

  it("recognises an offered outcome and nothing else", () => {
    expect(isVoteOutcome("overturned")).toBe(true);
    expect(isVoteOutcome("granted")).toBe(false);
    expect(isVoteOutcome("")).toBe(false);
    expect(isVoteOutcome(undefined)).toBe(false);
  });

  it("describes a panel of three where two matching votes decide", () => {
    expect(PANEL_SIZE).toBe(3);
    expect(DECIDING_VOTES).toBe(2);
  });

  it("states that the panel's decision is a public signed record", () => {
    expect(PANEL_RECORD_NOTICE).toContain("public signed record");
    expect(PANEL_RECORD_NOTICE).toContain("vote and reasons");
  });
});

describe("validateVoteDraft", () => {
  it("requires both an outcome and reasons", () => {
    expect(validateVoteDraft(EMPTY_VOTE_DRAFT)).toEqual({
      outcome: "Choose the outcome you back.",
      reasons: "Give your reasons. They are published with the decision.",
    });
  });

  it("treats whitespace-only reasons as missing", () => {
    expect(validateVoteDraft({ outcome: "upheld", reasons: "  \n " })).toEqual({
      reasons: "Give your reasons. They are published with the decision.",
    });
  });

  it("passes a complete draft", () => {
    expect(validateVoteDraft({ outcome: "overturned", reasons: "In scope." })).toEqual({});
  });
});

describe("buildVoteBody", () => {
  it("sends the outcome and trimmed reasons, the fields the API reads", () => {
    expect(buildVoteBody({ outcome: "overturned", reasons: "  In scope of MOD-01.  " })).toEqual({
      outcome: "overturned",
      reasons: "In scope of MOD-01.",
    });
  });

  it("refuses an incomplete draft instead of sending something the API would 422", () => {
    expect(() => buildVoteBody(EMPTY_VOTE_DRAFT)).toThrow(VoteDraftError);
    expect(() => buildVoteBody({ outcome: "upheld", reasons: " " })).toThrow(/reasons/);
  });
});

describe("voteEndpoint", () => {
  it("is the appeal's votes collection, with the cid as one path segment", () => {
    expect(voteEndpoint("bafy-appeal")).toBe("/appeals/bafy-appeal/votes");
    expect(voteEndpoint("a/b c")).toBe("/appeals/a%2Fb%20c/votes");
  });
});

describe("parseVoteAccepted", () => {
  const fallback = { appealCid: "bafy-appeal", outcome: "upheld" };

  it("reads the API's answer", () => {
    expect(
      parseVoteAccepted(
        {
          appeal: "bafy-appeal",
          vote: "overturned",
          counted: true,
          votes: 2,
          decision: "bafy-decision",
          outcome: "overturned",
        },
        fallback,
      ),
    ).toEqual({
      appealCid: "bafy-appeal",
      outcome: "overturned",
      votes: 2,
      decisionCid: "bafy-decision",
      decidedOutcome: "overturned",
      votedAt: null,
    });
  });

  it("reads a vote that has not decided the appeal", () => {
    const accepted = parseVoteAccepted(
      { appeal: "bafy-appeal", vote: "upheld", votes: 1, decision: null, outcome: null },
      fallback,
    );
    expect(accepted).toMatchObject({ votes: 1, decisionCid: null, decidedOutcome: null });
  });

  it("falls back to what was sent when a 200 has an unexpected body: the vote was recorded", () => {
    expect(parseVoteAccepted(undefined, fallback)).toEqual({
      appealCid: "bafy-appeal",
      outcome: "upheld",
      votes: null,
      decisionCid: null,
      decidedOutcome: null,
      votedAt: null,
    });
    expect(parseVoteAccepted("ok", fallback).outcome).toBe("upheld");
  });
});

describe("castPanelVote", () => {
  it("posts the body to the appeal's votes endpoint and reads the answer", async () => {
    const post = vi.fn(async () => ({
      appeal: "bafy-appeal",
      vote: "overturned",
      counted: true,
      votes: 1,
      decision: null,
      outcome: null,
    }));

    const accepted = await castPanelVote(
      "bafy-appeal",
      { outcome: "overturned", reasons: " In scope. " },
      { post } as never,
    );

    expect(post).toHaveBeenCalledWith("/appeals/bafy-appeal/votes", {
      outcome: "overturned",
      reasons: "In scope.",
    });
    expect(accepted).toMatchObject({ outcome: "overturned", votes: 1 });
  });

  it("sends nothing for an incomplete draft", async () => {
    const post = vi.fn();
    await expect(castPanelVote("bafy-appeal", EMPTY_VOTE_DRAFT, { post } as never)).rejects.toThrow(
      VoteDraftError,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

describe("describeVoteError", () => {
  it("sends a 401 to sign in again", () => {
    const failure = describeVoteError(new ApiError(401, { status: 401 }));
    expect(failure.kind).toBe("signed-out");
    expect(failure.message).toContain("session has ended");
  });

  it("reads a 403 as no seat on this panel: information, not a fault", () => {
    const failure = describeVoteError(
      new ApiError(403, {
        status: 403,
        type: "urn:scholium:problem:vote-not-authorized",
        detail: "did:key:z6MkX holds no seat on the panel for appeal 'bafy', so may not vote on it.",
      }),
    );
    expect(failure.kind).toBe("not-seated");
    expect(failure.message).toContain("do not hold a seat");
  });

  it("says no panel is seated yet on a 409", () => {
    const failure = describeVoteError(new ApiError(409, { status: 409 }));
    expect(failure).toMatchObject({ kind: "error" });
    expect(failure.message).toContain("No panel has been seated");
  });

  it("says the vote is kept when the server cannot sign the decision (503)", () => {
    const failure = describeVoteError(new ApiError(503, { status: 503 }));
    expect(failure.message).toContain("no signing key");
    expect(failure.message).toContain("Your vote is saved");
  });

  it("says the appeal is unknown on a 404", () => {
    expect(describeVoteError(new ApiError(404, { status: 404 })).message).toContain(
      "not filed on this server",
    );
  });

  it("repeats the API's sentence for a 422", () => {
    const failure = describeVoteError(
      new ApiError(422, { status: 422, detail: "The vote is invalid: 'outcome' must be one of upheld." }),
    );
    expect(failure.message).toBe("The vote is invalid: 'outcome' must be one of upheld.");
  });

  it("explains an unreachable API, a draft error and an unknown throw", () => {
    expect(describeVoteError(new NetworkError("offline")).message).toContain("not recorded");
    expect(describeVoteError(new VoteDraftError("Choose one.")).message).toBe("Choose one.");
    expect(describeVoteError(null).message).toBe("The vote could not be recorded.");
  });
});
