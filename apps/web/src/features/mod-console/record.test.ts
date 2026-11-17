import { describe, expect, it, vi } from "vitest";

import {
  EXCERPT_LIMIT,
  RecordReadError,
  excerptOf,
  loadFlagTargetSummary,
  loadModerationItem,
  parseRecord,
  recordKindLabel,
  recordNoun,
  recordPaperHref,
  resolveOwningPaper,
  summarizeRecord,
  type RecordClient,
} from "./record";

const VERSION_CID = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";
const PAPER_CID = "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4";
const POST_CID = "bafyreidiscussionpostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVIEW_CID = "bafyreireviewaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHORT_ID = "sch:5jmi-pmva-4lmr";
const POSTER = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb";

function postPayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "discussion.post",
    author: POSTER,
    created: "2027-05-04T09:30:00Z",
    prev: null,
    body: {
      target: VERSION_CID,
      anchor: VERSION_CID,
      text: "  This figure is copied from another paper.  ",
      parent: null,
    },
    proofs: [],
    id: POST_CID,
    sig: "a-signature",
    ...overrides,
  };
}

function versionPayload() {
  return {
    v: 1,
    type: "paper.version",
    author: POSTER,
    created: "2027-05-01T09:30:00Z",
    prev: null,
    body: {
      paper: PAPER_CID,
      n: 2,
      title: "Sparse attention without the quadratic cost",
      abstract: "We remove the quadratic term.",
    },
    proofs: [],
    id: VERSION_CID,
    sig: "a-signature",
  };
}

function genesisPayload() {
  return {
    v: 1,
    type: "paper.genesis",
    author: POSTER,
    created: "2027-04-30T09:30:00Z",
    prev: null,
    body: {
      title: "Sparse attention without the quadratic cost",
      categories: ["cs.AI"],
      licence: "CC-BY-4.0",
      abstract: "An abstract.",
    },
    proofs: [],
    id: PAPER_CID,
    sig: "a-signature",
  };
}

/** A client that answers the three records above and 404s anything else. */
function client(): RecordClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith(VERSION_CID)) return versionPayload();
      if (path.endsWith(PAPER_CID)) return genesisPayload();
      throw new Error(`no record at ${path}`);
    }),
  } as unknown as RecordClient;
}

describe("parseRecord", () => {
  it("reads a discussion post's author, text and target", () => {
    const record = parseRecord(postPayload());

    expect(record).toMatchObject({
      cid: POST_CID,
      type: "discussion.post",
      authorDid: POSTER,
      created: "2027-05-04T09:30:00Z",
      text: "This figure is copied from another paper.",
      quote: null,
      targetCid: VERSION_CID,
    });
  });

  it("calls a post with an anchored quote an annotation", () => {
    const record = parseRecord(
      postPayload({
        body: {
          target: VERSION_CID,
          anchor: {
            version: VERSION_CID,
            paragraph_id: "p3",
            quote: "The quadratic term",
            offset: { start: 0, end: 18 },
          },
          text: "This is not what the paper says.",
        },
      }),
    );

    expect(record.quote).toBe("The quadratic term");
    expect(recordKindLabel(record)).toBe("Annotation");
    expect(recordNoun(record)).toBe("annotation");
  });

  it("reads a review's report and the version it reviews", () => {
    const record = parseRecord({
      type: "review.formal",
      id: REVIEW_CID,
      author: POSTER,
      body: { target: VERSION_CID, report: "The evaluation omits the baseline." },
    });

    expect(record.text).toBe("The evaluation omits the baseline.");
    expect(record.targetCid).toBe(VERSION_CID);
    expect(recordKindLabel(record)).toBe("Review");
  });

  it("reads a paper's title and abstract from its genesis record", () => {
    const record = parseRecord(genesisPayload());

    expect(record.title).toBe("Sparse attention without the quadratic cost");
    expect(record.text).toBe("An abstract.");
    expect(recordKindLabel(record)).toBe("Paper");
  });

  it("rejects a payload that is not a readable record", () => {
    expect(() => parseRecord("not a record")).toThrow(RecordReadError);
    expect(() => parseRecord({ id: POST_CID, body: {} })).toThrow(/what kind of record/);
    expect(() => parseRecord({ type: "discussion.post", body: {} })).toThrow(/no id/);
  });
});

describe("resolveOwningPaper", () => {
  it("follows a post's target version to its paper genesis", async () => {
    const record = await resolveOwningPaper(parseRecord(postPayload()), client());

    expect(record.paperCid).toBe(PAPER_CID);
    expect(record.paperShortId).toBe(SHORT_ID);
    expect(record.paperTitle).toBe("Sparse attention without the quadratic cost");
    expect(record.versionCid).toBe(VERSION_CID);
    expect(record.versionId).toBe(`${SHORT_ID}/v2`);
    expect(recordPaperHref(record)).toBe(`/p/${encodeURIComponent(SHORT_ID)}`);
  });

  it("follows a review response to its review, then to the reviewed version", async () => {
    const responseCid = "bafyreiresponseaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reading: RecordClient = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith(responseCid)) {
          return {
            type: "review.response",
            id: responseCid,
            author: POSTER,
            body: { review: REVIEW_CID, items: [{ dimension: "clarity", reply: "Fixed." }] },
          };
        }
        if (path.endsWith(REVIEW_CID)) {
          return {
            type: "review.formal",
            id: REVIEW_CID,
            author: POSTER,
            body: { target: VERSION_CID, report: "Please clarify." },
          };
        }
        if (path.endsWith(VERSION_CID)) return versionPayload();
        return genesisPayload();
      }),
    } as unknown as RecordClient;

    const record = await resolveOwningPaper(
      parseRecord({
        type: "review.response",
        id: responseCid,
        author: POSTER,
        body: { review: REVIEW_CID, items: [{ dimension: "clarity", reply: "Fixed." }] },
      }),
      reading,
    );

    expect(record.text).toBe("Fixed.");
    expect(record.paperCid).toBe(PAPER_CID);
    expect(record.paperShortId).toBe(SHORT_ID);
    expect(record.versionCid).toBe(VERSION_CID);
    expect(record.versionId).toBe(`${SHORT_ID}/v2`);
    expect(record.paperTitle).toBe("Sparse attention without the quadratic cost");
  });

  it("does not invent a paper id from a record it cannot read", async () => {
    const versionOnly = parseRecord({
      type: "paper.version",
      id: VERSION_CID,
      author: POSTER,
      body: { paper: PAPER_CID, n: 1, title: "A title" },
    });
    const missing = { get: vi.fn(async () => Promise.reject(new Error("404"))) } as unknown as RecordClient;

    const record = await resolveOwningPaper(versionOnly, missing);

    expect(record.paperShortId).toBeNull();
    expect(recordPaperHref(record)).toBeNull();
    // The version's own title still labels the record.
    expect(record.paperTitle).toBe("A title");
  });

  it("shows the record even when its paper cannot be read", async () => {
    const missing = { get: vi.fn(async () => Promise.reject(new Error("404"))) } as unknown as RecordClient;
    const record = await resolveOwningPaper(parseRecord(postPayload()), missing);

    expect(record.text).toBe("This figure is copied from another paper.");
    expect(record.paperCid).toBeNull();
    expect(record.paperTitle).toBeNull();
    expect(recordPaperHref(record)).toBeNull();
  });
});

describe("loadModerationItem", () => {
  it("hands a paper version to the paper reader", async () => {
    const item = await loadModerationItem(VERSION_CID, client());

    expect(item.kind).toBe("paper");
    if (item.kind === "paper") {
      expect(item.paper.title).toBe("Sparse attention without the quadratic cost");
      expect(item.paper.versionId).toBe(`${SHORT_ID}/v2`);
    }
  });

  it("reads any other type as a record", async () => {
    const reading: RecordClient = {
      get: vi.fn(async () => postPayload()),
    } as unknown as RecordClient;

    const item = await loadModerationItem(POST_CID, reading);

    expect(item.kind).toBe("record");
  });

  it("gives a review its public reviewer label, never the reviewer key", async () => {
    const reviewPayload = {
      type: "review.formal",
      id: REVIEW_CID,
      author: "did:key:z6MkReviewerKeyThatMustNotBeShown",
      created: "2027-05-02T09:30:00Z",
      body: {
        target: VERSION_CID,
        paper: PAPER_CID,
        report: "The evaluation omits the baseline.",
      },
      proofs: [],
      sig: "a-signature",
    };
    const reading: RecordClient = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith(REVIEW_CID)) return reviewPayload;
        if (path.endsWith(VERSION_CID)) return versionPayload();
        if (path.endsWith(PAPER_CID)) return genesisPayload();
        if (path.includes("/reviews")) {
          return {
            reviews: [{ review_cid: REVIEW_CID, label: "Reviewer A" }],
          };
        }
        throw new Error(`no record at ${path}`);
      }),
    } as unknown as RecordClient;

    const item = await loadModerationItem(REVIEW_CID, reading);

    expect(item.kind).toBe("record");
    if (item.kind === "record") {
      expect(item.record.reviewerLabel).toBe("Reviewer A");
    }
  });
});

describe("flag target summaries", () => {
  it("summarises a post with its type, paper and excerpt", async () => {
    const reading: RecordClient = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith(POST_CID)) return postPayload();
        if (path.endsWith(VERSION_CID)) return versionPayload();
        return genesisPayload();
      }),
    } as unknown as RecordClient;

    const summary = await loadFlagTargetSummary(POST_CID, reading);

    expect(summary).toMatchObject({
      cid: POST_CID,
      type: "discussion.post",
      typeLabel: "Discussion post",
      paperTitle: "Sparse attention without the quadratic cost",
      paperHref: `/p/${encodeURIComponent(SHORT_ID)}`,
      excerpt: "This figure is copied from another paper.",
    });
  });

  it("uses the paper version's title and abstract", async () => {
    const summary = await loadFlagTargetSummary(VERSION_CID, client());

    expect(summary.typeLabel).toBe("Paper version");
    expect(summary.paperTitle).toBe("Sparse attention without the quadratic cost");
    expect(summary.excerpt).toBe("We remove the quadratic term.");
  });

  it("cuts a long excerpt rather than blowing up the card", () => {
    const record = parseRecord(
      postPayload({ body: { target: VERSION_CID, anchor: VERSION_CID, text: "x".repeat(400) } }),
    );
    const summary = summarizeRecord(record);

    expect(summary.excerpt).not.toBeNull();
    expect(summary.excerpt!.length).toBe(EXCERPT_LIMIT);
    expect(summary.excerpt!.endsWith("…")).toBe(true);
    expect(excerptOf("   ")).toBeNull();
  });
});
