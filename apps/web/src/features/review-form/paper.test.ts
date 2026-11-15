import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  InvalidPaperIdError,
  ReviewPaperError,
  describePaperError,
  loadReviewPaper,
  parseParagraphs,
  parsePaperHead,
  parseReviewTarget,
  reviewHref,
  type PaperClient,
} from "./paper";

/** A real id from the shared vectors (the checksum is verified). */
const ID = "sch:6sel-2dio-orm6";

const HEAD = {
  paper: ID,
  shortId: ID,
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study branching under uncertainty.",
  categories: ["cs.AI", "cs.CR"],
};

const TEXT = {
  paper: ID,
  version: 2,
  count: 2,
  paragraphs: [
    { paragraph_id: "b".repeat(8), paragraphId: "b".repeat(8), position: 1, text: "Second." },
    { paragraph_id: "a".repeat(8), paragraphId: "a".repeat(8), position: 0, text: "First." },
  ],
};

function problem(status: number, detail = "nope"): ApiError {
  return new ApiError(status, { status, title: "Problem", detail });
}

describe("parseReviewTarget", () => {
  it("accepts a full sch: id", () => {
    expect(parseReviewTarget(ID)).toBe(ID);
  });

  it("accepts the id without its sch: prefix, as paper URLs spell it", () => {
    expect(parseReviewTarget("6sel-2dio-orm6")).toBe(ID);
  });

  it("decodes a percent-encoded sch%3A prefix", () => {
    expect(parseReviewTarget("sch%3A6sel-2dio-orm6")).toBe(ID);
  });

  it("rejects an id with a bad checksum", () => {
    expect(() => parseReviewTarget("6sel-2dio-orm7")).toThrow(InvalidPaperIdError);
  });

  it("rejects nonsense and an empty segment", () => {
    expect(() => parseReviewTarget("hello")).toThrow(InvalidPaperIdError);
    expect(() => parseReviewTarget("")).toThrow(InvalidPaperIdError);
    expect(() => parseReviewTarget("   ")).toThrow(InvalidPaperIdError);
  });

  it("rejects a version id: a review is written against the newest version", () => {
    expect(() => parseReviewTarget(`${ID}/v2`)).toThrow(InvalidPaperIdError);
    expect(() => parseReviewTarget("sch%3A6sel-2dio-orm6%2Fv2")).toThrow(
      InvalidPaperIdError,
    );
  });

  it("reports a segment with broken percent-encoding as a bad id, not a crash", () => {
    expect(() => parseReviewTarget("%E0%A4%A")).toThrow(InvalidPaperIdError);
  });
});

describe("reviewHref", () => {
  it("links to /review with the id encoded", () => {
    expect(reviewHref(ID)).toBe("/review/sch%3A6sel-2dio-orm6");
  });
});

describe("parsePaperHead", () => {
  it("reads the fields the page shows", () => {
    expect(parsePaperHead(HEAD)).toEqual({
      shortId: ID,
      version: 2,
      title: "Can a Meta-Agent Choose the Safer Branch?",
      abstract: "We study branching under uncertainty.",
      categories: ["cs.AI", "cs.CR"],
    });
  });

  it("falls back to the other spellings of the id and version", () => {
    const head = parsePaperHead({ paper: ID, version: 3, title: "T" });
    expect(head.shortId).toBe(ID);
    expect(head.version).toBe(3);
  });

  it("treats a missing abstract and categories as empty", () => {
    const head = parsePaperHead({ shortId: ID, n: 1, title: "T" });
    expect(head.abstract).toBe("");
    expect(head.categories).toEqual([]);
  });

  it("drops categories that are not text", () => {
    const head = parsePaperHead({ ...HEAD, categories: ["cs.AI", 7, "", null] });
    expect(head.categories).toEqual(["cs.AI"]);
  });

  it.each([
    ["a string", "paper"],
    ["null", null],
    ["a list", [HEAD]],
    ["no title", { ...HEAD, title: "  " }],
    ["no version", { ...HEAD, n: undefined, version: undefined }],
    ["a version of zero", { ...HEAD, n: 0, version: 0 }],
    ["no id", { ...HEAD, shortId: undefined, paper: undefined }],
  ])("refuses %s rather than showing a blank paper", (_name, body) => {
    expect(() => parsePaperHead(body)).toThrow(ReviewPaperError);
  });
});

describe("parseParagraphs", () => {
  it("returns the paragraphs in reading order, whatever order they arrived in", () => {
    expect(parseParagraphs(TEXT).map(({ text }) => text)).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("keeps each paragraph's id", () => {
    expect(parseParagraphs(TEXT)[0].id).toBe("a".repeat(8));
  });

  it("accepts the camel-case id and invents none that could collide", () => {
    const [first, second] = parseParagraphs({
      paragraphs: [
        { paragraphId: "x1", position: 0, text: "A" },
        { position: 1, text: "B" },
      ],
    });
    expect(first.id).toBe("x1");
    expect(second.id).toBe("p1");
  });

  it("drops a paragraph with no text", () => {
    const paragraphs = parseParagraphs({
      paragraphs: [
        { paragraph_id: "a", position: 0, text: "Kept." },
        { paragraph_id: "b", position: 1, text: "   " },
        { paragraph_id: "c", position: 2 },
        "junk",
      ],
    });
    expect(paragraphs.map(({ text }) => text)).toEqual(["Kept."]);
  });

  it("keeps arrival order for paragraphs with no position", () => {
    const paragraphs = parseParagraphs({
      paragraphs: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
    });
    expect(paragraphs.map(({ text }) => text)).toEqual(["One", "Two", "Three"]);
  });

  it("returns an empty list for a paper with no paragraphs", () => {
    expect(parseParagraphs({ paragraphs: [] })).toEqual([]);
  });

  it("refuses a body with no paragraph list", () => {
    expect(() => parseParagraphs({ text: "all of it" })).toThrow(ReviewPaperError);
    expect(() => parseParagraphs(null)).toThrow(ReviewPaperError);
  });
});

describe("loadReviewPaper", () => {
  function client(
    handler: (path: string) => unknown | Promise<unknown>,
  ): PaperClient & { get: ReturnType<typeof vi.fn> } {
    return {
      get: vi.fn(async (path: string) => handler(path)),
    } as unknown as PaperClient & { get: ReturnType<typeof vi.fn> };
  }

  it("reads the paper, then the text of the version it found", async () => {
    const api = client((path) => (path.endsWith("/text") ? TEXT : HEAD));

    const paper = await loadReviewPaper(ID, api);

    expect(paper.title).toBe(HEAD.title);
    expect(paper.version).toBe(2);
    expect(paper.paragraphs?.map(({ text }) => text)).toEqual(["First.", "Second."]);
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      "/papers/sch%3A6sel-2dio-orm6",
      "/papers/sch%3A6sel-2dio-orm6/v/2/text",
    ]);
  });

  it("makes both reads without the account, and never from a cache", async () => {
    const api = client((path) => (path.endsWith("/text") ? TEXT : HEAD));

    await loadReviewPaper(ID, api);

    for (const [, options] of api.get.mock.calls) {
      expect(options).toMatchObject({ auth: false, cache: "no-store" });
    }
  });

  it("still returns the paper, with no text, when the text cannot be read", async () => {
    const api = client((path) => {
      if (path.endsWith("/text")) throw problem(404);
      return HEAD;
    });

    const paper = await loadReviewPaper(ID, api);

    expect(paper.title).toBe(HEAD.title);
    expect(paper.paragraphs).toBeNull();
  });

  it("does not take a malformed text body for a paper with no paragraphs", async () => {
    const api = client((path) => (path.endsWith("/text") ? { nope: true } : HEAD));
    expect((await loadReviewPaper(ID, api)).paragraphs).toBeNull();
  });

  it("fails when the paper itself cannot be read", async () => {
    const api = client(() => {
      throw problem(404);
    });

    await expect(loadReviewPaper(ID, api)).rejects.toBeInstanceOf(ApiError);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("fails when the API answers with something that is not a paper", async () => {
    const api = client(() => ({ items: [] }));
    await expect(loadReviewPaper(ID, api)).rejects.toBeInstanceOf(ReviewPaperError);
  });
});

describe("describePaperError", () => {
  it("names a bad id as one, with the reason", () => {
    const failure = describePaperError(new InvalidPaperIdError("bad checksum"));
    expect(failure.kind).toBe("invalid-id");
    expect(failure.title).toBe("That is not a paper id");
    expect(failure.message).toBe("bad checksum");
  });

  it("says an unlisted paper is not there, and offers no retry", () => {
    const failure = describePaperError(problem(404));
    expect(failure.kind).toBe("not-found");
    expect(failure.message).toContain("no listed paper");
  });

  it("explains an unreachable API in plain words", () => {
    const failure = describePaperError(new NetworkError("http://localhost:8000/v1/papers/x"));
    expect(failure.kind).toBe("failed");
    expect(failure.message).toContain("could not reach the API");
  });

  it("passes on the API's own explanation for other failures", () => {
    const failure = describePaperError(problem(503, "The node is busy."));
    expect(failure.kind).toBe("failed");
    expect(failure.message).toBe("The node is busy.");
  });

  it("explains a body that was not a paper", () => {
    const failure = describePaperError(
      new ReviewPaperError("The API did not return a paper."),
    );
    expect(failure.kind).toBe("failed");
    expect(failure.message).toBe("The API did not return a paper.");
  });

  it("has something to say about an error it knows nothing about", () => {
    expect(describePaperError("boom").message).toBe("The paper could not be loaded.");
  });
});
