import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError, type SignedRecord } from "../web-auth";
import {
  DECISIONS_ENDPOINT,
  DECISION_ACTIONS,
  DECISION_ACTION_LABELS,
  EMPTY_DECISION_DRAFT,
  ModerationPaperError,
  PUBLIC_RECORD_NOTICE,
  RECORDS_ENDPOINT,
  authorPreview,
  buildDecisionBody,
  classifyPaperError,
  describeDecisionError,
  isDecisionAction,
  loadModeratedPaper,
  parseDecisionAccepted,
  parseVersionRecord,
  shortenDid,
  submitModerationDecision,
  validateDecisionDraft,
  type DecisionDraft,
} from "./decision";

/** The paper.genesis vector's cid -> short id `sch:5jmi-pmva-4lmr`. */
const GENESIS = "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4";
const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";
const DID = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb";

const CLAUSES = [
  {
    id: "MOD-01",
    title: "Out of scope",
    text: "A submission outside every open category is rejected.",
  },
  {
    id: "MOD-02",
    title: "Plagiarism and unattributed overlap",
    text: "A submission must attribute every source it draws on.",
  },
] as const;

function versionRecord(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "paper.version",
    author: DID,
    created: "2026-11-14T05:33:00Z",
    prev: GENESIS,
    proofs: [],
    id: VERSION,
    body: {
      paper: GENESIS,
      n: 2,
      title: "Sparse attention without the quadratic cost",
      abstract: "  We remove the quadratic term.  ",
      authors: [
        {
          did: DID,
          name: "Mei Zhang",
          affiliation: "Harbour University",
        },
        "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
      ],
      manifest: "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli",
      licence: "CC-BY-4.0",
      changeNote: "Expanded the evaluation.",
      categories: ["cs.AI", "cs.LG"],
    },
    ...overrides,
  };
}

function draft(overrides: Partial<DecisionDraft> = {}): DecisionDraft {
  return {
    action: "reject",
    clause: "MOD-02",
    reason: "  The overlap is unattributed.  ",
    category: "",
    ...overrides,
  };
}

function signedRecord(body: Record<string, unknown>): SignedRecord {
  return {
    v: 1,
    type: "moderation.decision",
    id: "bafydecision",
    author: DID,
    created: "2026-11-14T06:00:00Z",
    prev: null,
    body,
    proofs: [],
    sig: "signature",
  };
}

describe("parseVersionRecord", () => {
  it("reads the paper a moderator decides on out of the signed version record", () => {
    const paper = parseVersionRecord(versionRecord());

    expect(paper.versionCid).toBe(VERSION);
    expect(paper.paperCid).toBe(GENESIS);
    expect(paper.shortId).toBe("sch:5jmi-pmva-4lmr");
    expect(paper.versionId).toBe("sch:5jmi-pmva-4lmr/v2");
    expect(paper.version).toBe(2);
    expect(paper.title).toBe("Sparse attention without the quadratic cost");
    expect(paper.abstract).toBe("We remove the quadratic term.");
    expect(paper.categories).toEqual(["cs.AI", "cs.LG"]);
    expect(paper.licence).toBe("CC-BY-4.0");
    expect(paper.changeNote).toBe("Expanded the evaluation.");
    expect(paper.manifestCid).toBe(
      "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli",
    );
    expect(paper.authors).toEqual([
      {
        did: DID,
        name: "Mei Zhang",
        affiliation: "Harbour University",
      },
      {
        did: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
        name: "did:key:z6MkpTHR…wWsdvktH",
        affiliation: null,
      },
    ]);
  });

  it("keeps a paper readable when optional fields are missing", () => {
    const paper = parseVersionRecord(
      versionRecord({
        id: undefined,
        body: { title: "Only a title" },
      }),
      "expected-version",
    );

    expect(paper.versionCid).toBe("expected-version");
    expect(paper.paperCid).toBeNull();
    expect(paper.shortId).toBeNull();
    expect(paper.versionId).toBeNull();
    expect(paper.title).toBe("Only a title");
    expect(paper.abstract).toBe("");
    expect(paper.authors).toEqual([]);
    expect(paper.categories).toEqual([]);
    expect(paper.licence).toBeNull();
  });

  it("calls an untitled version Untitled rather than hiding it", () => {
    expect(
      parseVersionRecord(versionRecord({ body: { title: "   " } })).title,
    ).toBe("Untitled");
  });

  it("refuses a record that is not a paper version", () => {
    expect(() =>
      parseVersionRecord(versionRecord({ type: "endorsement" })),
    ).toThrow(ModerationPaperError);
    expect(() => parseVersionRecord(null)).toThrow(ModerationPaperError);
    expect(() =>
      parseVersionRecord(versionRecord({ body: "not an object" })),
    ).toThrow(/no readable body/);
  });

  it("shortens long DIDs but leaves short identifiers whole", () => {
    expect(shortenDid("did:key:z6MkShort")).toBe("did:key:z6MkShort");
    expect(shortenDid(DID)).toBe("did:key:z6MkhaKg…CCZK7pBb");
  });
});

describe("loadModeratedPaper", () => {
  it("reads the public record by id, without a token and without a cache", async () => {
    const get = vi.fn(async () => versionRecord());

    const paper = await loadModeratedPaper("a/b?c", { get } as never);

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = get.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe(`${RECORDS_ENDPOINT}/a%2Fb%3Fc`);
    expect(RECORDS_ENDPOINT).toBe("/records");
    expect(options.auth).toBe(false);
    expect(options.cache).toBe("no-store");
    expect(paper.versionCid).toBe(VERSION);
  });
});

describe("decision actions", () => {
  it("offers exactly the five actions the schema accepts, each with words", () => {
    expect(DECISION_ACTIONS).toEqual([
      "list",
      "hold",
      "reclassify",
      "reject",
      "delist",
    ]);
    for (const action of DECISION_ACTIONS) {
      expect(isDecisionAction(action)).toBe(true);
      expect(DECISION_ACTION_LABELS[action].length).toBeGreaterThan(0);
    }
    expect(isDecisionAction("banish")).toBe(false);
    expect(isDecisionAction(undefined)).toBe(false);
  });
});

describe("validateDecisionDraft", () => {
  it("accepts a complete decision", () => {
    expect(validateDecisionDraft(draft())).toEqual({});
  });

  it("requires an action, a clause and a reason", () => {
    expect(validateDecisionDraft(EMPTY_DECISION_DRAFT)).toEqual({
      action: "Choose an action.",
      clause: "Choose the policy clause this decision cites.",
      reason: "Write the reason the author will see.",
    });
  });

  it("will not accept whitespace as a reason", () => {
    expect(validateDecisionDraft(draft({ reason: "  \n\t " }))).toEqual({
      reason: "Write the reason the author will see.",
    });
  });

  it("requires a category only for a reclassification", () => {
    expect(validateDecisionDraft(draft({ action: "reclassify" }))).toEqual({
      category: "Name the category the paper moves to.",
    });
    expect(
      validateDecisionDraft(draft({ action: "reclassify", category: "cs.LG" })),
    ).toEqual({});
    // The category is ignored by every other action.
    expect(validateDecisionDraft(draft({ category: "" }))).toEqual({});
  });
});

describe("buildDecisionBody", () => {
  it("trims the signed values and omits an unused category", () => {
    expect(buildDecisionBody("bafyversion", draft())).toEqual({
      target: "bafyversion",
      action: "reject",
      clause: "MOD-02",
      reason: "The overlap is unattributed.",
    });
  });

  it("includes the new category for a reclassification", () => {
    expect(
      buildDecisionBody(
        "bafyversion",
        draft({ action: "reclassify", category: "  cs.LG " }),
      ),
    ).toEqual({
      target: "bafyversion",
      action: "reclassify",
      clause: "MOD-02",
      reason: "The overlap is unattributed.",
      category: "cs.LG",
    });
  });

  it("refuses to build a body the API would reject", () => {
    expect(() =>
      buildDecisionBody("bafyversion", draft({ action: "" })),
    ).toThrow(/Choose an action/);
    expect(() =>
      buildDecisionBody("bafyversion", draft({ clause: " " })),
    ).toThrow(/policy clause/);
    expect(() =>
      buildDecisionBody("bafyversion", draft({ reason: " " })),
    ).toThrow(/reason/);
    expect(() =>
      buildDecisionBody(
        "bafyversion",
        draft({ action: "reclassify", category: " " }),
      ),
    ).toThrow(/category/);
  });
});

describe("authorPreview", () => {
  it("has nothing to preview until an action is chosen", () => {
    expect(authorPreview(EMPTY_DECISION_DRAFT, CLAUSES)).toBeNull();
  });

  it("shows the outcome, the reason and the cited clause", () => {
    expect(authorPreview(draft(), CLAUSES)).toEqual({
      headline: "Your paper has not been listed.",
      clause: CLAUSES[1],
      reason: "The overlap is unattributed.",
      appeal: "You can appeal once.",
    });
  });

  it("uses the same words for each action, with an appeal only where one exists", () => {
    expect(authorPreview(draft({ action: "list" }), CLAUSES)).toMatchObject({
      headline: "Your paper has been listed.",
      appeal: null,
    });
    expect(authorPreview(draft({ action: "hold" }), CLAUSES)).toMatchObject({
      headline: "Your paper is on hold and has not been listed.",
      appeal: "You can appeal once.",
    });
    expect(
      authorPreview(
        draft({ action: "reclassify", category: "cs.LG" }),
        CLAUSES,
      ),
    ).toMatchObject({
      headline: "Your paper has been reclassified to cs.LG.",
      appeal: null,
    });
    expect(
      authorPreview(draft({ action: "reclassify", category: "" }), CLAUSES),
    ).toMatchObject({
      headline: "Your paper has been reclassified to a different category.",
    });
    expect(authorPreview(draft({ action: "delist" }), CLAUSES)).toMatchObject({
      headline: "Your paper has been removed from the catalog.",
      appeal: "You can appeal once.",
    });
  });

  it("leaves the clause blank when the chosen id is not in the list", () => {
    expect(
      authorPreview(draft({ clause: "MOD-99" }), CLAUSES),
    ).toMatchObject({ clause: null, reason: "The overlap is unattributed." });
  });
});

describe("signing, submitting and failures", () => {
  it("reads a 201 body back into the form's fields", () => {
    const record = signedRecord({
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      reason: "The overlap is unattributed.",
    });

    expect(
      parseDecisionAccepted(
        {
          id: "bafydecision",
          shortId: "sch:5jmi-pmva-4lmr/v2",
          target: VERSION,
          action: "reject",
          clause: "MOD-02",
          state: "rejected",
          anchor: "pending",
        },
        { id: record.id, target: VERSION, action: "reject", clause: "MOD-02" },
      ),
    ).toEqual({
      id: "bafydecision",
      shortId: "sch:5jmi-pmva-4lmr/v2",
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      state: "rejected",
      anchor: "pending",
    });
  });

  it("keeps a 201 a success even when its body is not the expected shape", () => {
    const accepted = parseDecisionAccepted({}, {
      id: "bafydecision",
      target: VERSION,
      action: "hold",
      clause: "MOD-01",
    });
    expect(accepted).toEqual({
      id: "bafydecision",
      shortId: null,
      target: VERSION,
      action: "hold",
      clause: "MOD-01",
      state: "accepted",
      anchor: "pending",
    });
  });

  it("posts the signed decision to the decisions endpoint", async () => {
    const body = {
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      reason: "The overlap is unattributed.",
    };
    const record = signedRecord(body);
    const post = vi.fn(async () => ({
      id: record.id,
      state: "rejected",
      anchor: "pending",
    }));

    const accepted = await submitModerationDecision(record, { post } as never);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([DECISIONS_ENDPOINT, record]);
    expect(DECISIONS_ENDPOINT).toBe("/moderation/decisions");
    expect(accepted).toMatchObject({
      id: record.id,
      target: VERSION,
      action: "reject",
      clause: "MOD-02",
      state: "rejected",
    });
  });
});

describe("classifyPaperError", () => {
  it("treats an ended session as signed out", () => {
    expect(classifyPaperError(new ApiError(401, { status: 401 }))).toMatchObject({
      kind: "signed-out",
      message: expect.stringMatching(/session has ended/i),
    });
  });

  it("reports a 403 as moderators only, with the caller's tier", () => {
    expect(
      classifyPaperError(
        new ApiError(403, { status: 403, caller_tier: 2 }),
      ),
    ).toEqual({
      kind: "forbidden",
      message: expect.stringContaining("trust tier 4"),
      callerTier: 2,
    });
  });

  it("says a missing version is not on this server", () => {
    expect(
      classifyPaperError(new ApiError(404, { status: 404 })),
    ).toMatchObject({ kind: "error", message: expect.stringMatching(/not on this server/) });
  });

  it("explains a network failure and a malformed record", () => {
    expect(
      classifyPaperError(new NetworkError("http://api.invalid/v1/records/x")),
    ).toMatchObject({ kind: "error", message: expect.stringMatching(/could not reach the API/) });
    expect(
      classifyPaperError(new ModerationPaperError("Not a paper version.")),
    ).toEqual({ kind: "error", message: "Not a paper version." });
  });
});

describe("describeDecisionError", () => {
  it("says nothing was published when the passkey prompt is dismissed", () => {
    expect(describeDecisionError(new PasskeyCancelledError())).toBe(
      "Signing was cancelled, so the decision was not published.",
    );
  });

  it("names the session and tier failures plainly", () => {
    expect(describeDecisionError(new ApiError(401, { status: 401 }))).toMatch(
      /session has ended/i,
    );
    expect(describeDecisionError(new ApiError(403, { status: 403 }))).toMatch(
      /Only a moderator/,
    );
  });

  it("passes the API's conflict reason through", () => {
    expect(
      describeDecisionError(
        new ApiError(409, {
          status: 409,
          detail: "A decision already moved this version.",
        }),
      ),
    ).toBe("A decision already moved this version.");
  });

  it("uses the API's detail for an invalid record", () => {
    expect(
      describeDecisionError(
        new ApiError(422, { status: 422, detail: "Unknown policy clause." }),
      ),
    ).toBe("Unknown policy clause.");
  });

  it("explains an unreachable API and an unknown failure", () => {
    expect(
      describeDecisionError(new NetworkError("http://api.invalid/v1/x")),
    ).toMatch(/could not reach the API/);
    expect(describeDecisionError("???")).toBe("The decision could not be recorded.");
  });
});

describe("PUBLIC_RECORD_NOTICE", () => {
  it("is the sentence docs/design.md §5.7 requires, word for word", () => {
    expect(PUBLIC_RECORD_NOTICE).toBe("This decision is a public signed record.");
  });
});
