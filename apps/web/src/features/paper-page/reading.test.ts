import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, apiErrorFrom } from "../../lib/api";
import {
  ReadingResponseError,
  describeReadingError,
  loadReadingText,
  parseReadingText,
  readingPath,
} from "./reading";

/**
 * The text of one version (`GET /v1/papers/{id}/v/{n}/text`): paragraphs in
 * reading order, each with the id an annotation anchors to.
 */

const body = (paragraphs: unknown[], extra: Record<string, unknown> = {}) => ({
  paper: "sch:6sel-2dio-orm6",
  version: 2,
  versionCid: "bafyrei-v2",
  count: paragraphs.length,
  paragraphs,
  ...extra,
});

describe("parseReadingText", () => {
  it("reads each paragraph's id and text, and the version's record id", () => {
    const text = parseReadingText(
      body([
        { paragraph_id: "p1", paragraphId: "p1", position: 0, text: "First." },
        { paragraph_id: "p2", paragraphId: "p2", position: 1, text: "Second." },
      ]),
    );

    expect(text.versionCid).toBe("bafyrei-v2");
    expect(text.paragraphs).toEqual([
      { id: "p1", text: "First." },
      { id: "p2", text: "Second." },
    ]);
  });

  it("puts paragraphs in reading order by position, not by arrival", () => {
    const text = parseReadingText(
      body([
        { paragraph_id: "b", position: 1, text: "Second." },
        { paragraph_id: "a", position: 0, text: "First." },
        { paragraph_id: "c", position: 2, text: "Third." },
      ]),
    );
    expect(text.paragraphs.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the order received when positions tie or are missing", () => {
    const text = parseReadingText(
      body([
        { paragraph_id: "x", text: "One." },
        { paragraph_id: "y", text: "Two." },
      ]),
    );
    expect(text.paragraphs.map((p) => p.id)).toEqual(["x", "y"]);
  });

  it("accepts the camel-case paragraph id", () => {
    const text = parseReadingText(body([{ paragraphId: "camel", position: 0, text: "Hi." }]));
    expect(text.paragraphs).toEqual([{ id: "camel", text: "Hi." }]);
  });

  it("skips a paragraph that cannot be shown or annotated, and keeps the rest", () => {
    const text = parseReadingText(
      body([
        { paragraph_id: "ok", position: 0, text: "Readable." },
        { position: 1, text: "No id, so it cannot be annotated." },
        { paragraph_id: "blank", position: 2, text: "   " },
        "not an object",
        null,
      ]),
    );
    expect(text.paragraphs).toEqual([{ id: "ok", text: "Readable." }]);
  });

  it("is an empty list, not an error, for a version with no paragraphs", () => {
    expect(parseReadingText(body([])).paragraphs).toEqual([]);
  });

  it.each([
    ["null", null],
    ["a string", "text"],
    ["a list", []],
    ["an object with no paragraph list", { paper: "sch:6sel-2dio-orm6" }],
    ["paragraphs that are not a list", { paragraphs: "none" }],
  ])("rejects %s: we do not know what the text is", (_name, payload) => {
    expect(() => parseReadingText(payload)).toThrow(ReadingResponseError);
  });
});

describe("readingPath", () => {
  it("is the version's text endpoint, with the id escaped", () => {
    expect(readingPath("sch:6sel-2dio-orm6", 2)).toBe(
      "/papers/sch%3A6sel-2dio-orm6/v/2/text",
    );
  });
});

describe("loadReadingText", () => {
  it("reads the text anonymously and without caching", async () => {
    const get = vi.fn().mockResolvedValue(body([{ paragraph_id: "p1", text: "Hi." }]));

    const text = await loadReadingText("sch:6sel-2dio-orm6", 2, { get });

    expect(get).toHaveBeenCalledWith("/papers/sch%3A6sel-2dio-orm6/v/2/text", {
      auth: false,
      cache: "no-store",
    });
    expect(text.paragraphs).toEqual([{ id: "p1", text: "Hi." }]);
  });
});

describe("describeReadingError", () => {
  const problem = (status: number, detail = "") =>
    apiErrorFrom(status, { title: "Problem", status, detail });

  it("says a missing version has no readable text", () => {
    expect(describeReadingError(problem(404))).toMatch(/no readable text for that version/);
  });

  it("passes on the server's own detail", () => {
    expect(describeReadingError(problem(500, "The text store is down."))).toBe(
      "The text store is down.",
    );
  });

  it("says a lost connection is a lost connection", () => {
    expect(describeReadingError(new NetworkError("http://x"))).toMatch(/Couldn’t reach the server/);
  });

  it("says what a malformed answer was", () => {
    expect(describeReadingError(new ReadingResponseError("The server did not return the paper's text."))).toBe(
      "The server did not return the paper's text.",
    );
  });

  it("never echoes something unexpected", () => {
    expect(describeReadingError(new TypeError("secret internals"))).toBe(
      "The text could not be loaded. Try again.",
    );
    expect(describeReadingError("boom")).not.toContain("boom");
  });

  it("is an ApiError for a real HTTP problem", () => {
    expect(problem(404)).toBeInstanceOf(ApiError);
  });
});
