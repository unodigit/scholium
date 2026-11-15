import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  CompareResponseError,
  comparePath,
  describeCompareError,
  describeCompareSummary,
  loadCompare,
  parseCompare,
  type CompareClient,
  type CompareData,
} from "./compare";
import { comparePagePath } from "./paper-links";
import { COMPARE_BODY, SHORT_ID } from "./paper-page-fixtures";

const SHORT = SHORT_ID;

function data(overrides: Partial<CompareData> = {}): CompareData {
  return {
    paper: SHORT,
    from: 1,
    to: 2,
    fromChangeNote: null,
    toChangeNote: "Names the adversarial baseline.",
    added: [],
    removed: [],
    changed: [],
    ...overrides,
  };
}

describe("parseCompare", () => {
  it("reads the node's camelCase diff: both notes, changed, added and removed", () => {
    const parsed = parseCompare(COMPARE_BODY, { from: 1, to: 2 });

    expect(parsed.paper).toBe(SHORT);
    expect(parsed.from).toBe(1);
    expect(parsed.to).toBe(2);
    expect(parsed.fromChangeNote).toBeNull();
    expect(parsed.toChangeNote).toBe("Names the adversarial baseline in section 3.2.");

    expect(parsed.changed).toEqual([
      {
        from: {
          id: "para-1",
          position: 0,
          text: "Multi-agent systems choose between candidate plans.",
        },
        to: {
          id: "para-1b",
          position: 0,
          text: "Multi-agent systems increasingly choose between candidate plans.",
        },
      },
    ]);
    expect(parsed.added.map((item) => item.text)).toEqual([
      "Section 3.2 now names the adversarial baseline and its seed.",
    ]);
    expect(parsed.removed.map((item) => item.text)).toEqual([
      "The baseline was tuned on the test split.",
    ]);
  });

  it("reads the snake_case spellings and a diff nested under `diff`", () => {
    const parsed = parseCompare(
      {
        paper_id: SHORT,
        from_version: 2,
        to_version: 3,
        change_note_from: "Fixed the proof.",
        change_note_to: "Added the baseline.",
        diff: {
          added_paragraphs: [
            { paragraph_id: "p-new", position: 1, text: "A new paragraph." },
          ],
          removed_paragraphs: [],
          changed_paragraphs: [
            {
              old_paragraph: { paragraph_id: "p-old", position: 0, text: "Old." },
              new_paragraph: { paragraph_id: "p-new-2", position: 0, text: "New." },
            },
          ],
        },
      },
      { from: 1, to: 2 },
    );

    expect(parsed.from).toBe(2);
    expect(parsed.to).toBe(3);
    expect(parsed.fromChangeNote).toBe("Fixed the proof.");
    expect(parsed.toChangeNote).toBe("Added the baseline.");
    expect(parsed.added).toEqual([{ id: "p-new", position: 1, text: "A new paragraph." }]);
    expect(parsed.changed[0].from.id).toBe("p-old");
    expect(parsed.changed[0].to.id).toBe("p-new-2");
  });

  it("falls back to the versions array for change notes", () => {
    const parsed = parseCompare(
      {
        versions: [
          { n: 1, changeNote: "First." },
          { n: 2, changeNote: "Second." },
        ],
        addedParagraphs: [],
        removedParagraphs: [],
        changedParagraphs: [],
      },
      { from: 1, to: 2 },
    );

    expect(parsed.fromChangeNote).toBe("First.");
    expect(parsed.toChangeNote).toBe("Second.");
  });

  it("keeps the address's version numbers when the body does not repeat them", () => {
    const parsed = parseCompare({ added: [] }, { from: 3, to: 4 });
    expect([parsed.from, parsed.to]).toEqual([3, 4]);
  });

  it("drops one unreadable row instead of taking the comparison down", () => {
    const parsed = parseCompare(
      {
        addedParagraphs: [
          { paragraph_id: "ok", position: 0, text: "Readable." },
          { position: 1, text: "No id." },
          { paragraph_id: "empty", position: 2, text: "   " },
          "not a paragraph",
        ],
        removedParagraphs: [],
        changedParagraphs: [
          { from: { paragraph_id: "a", text: "Only one side." } },
          {
            from: { paragraph_id: "b", text: "Both sides." },
            to: { paragraph_id: "c", text: "Both sides, new." },
          },
        ],
      },
      { from: 1, to: 2 },
    );

    expect(parsed.added).toEqual([{ id: "ok", position: 0, text: "Readable." }]);
    expect(parsed.changed).toHaveLength(1);
    expect(parsed.changed[0].from.id).toBe("b");
  });

  it("treats a body with no diff lists as an error, not as 'nothing changed'", () => {
    expect(() => parseCompare({ paper: SHORT }, { from: 1, to: 2 })).toThrow(
      CompareResponseError,
    );
    expect(() => parseCompare(null, { from: 1, to: 2 })).toThrow(/paragraph diff/);
    expect(() => parseCompare("not a diff", { from: 1, to: 2 })).toThrow(
      CompareResponseError,
    );
  });

  it("treats three present but empty lists as a real, unchanged comparison", () => {
    const parsed = parseCompare(
      { added: [], removed: [], changed: [] },
      { from: 1, to: 2 },
    );
    expect(parsed.added).toEqual([]);
    expect(parsed.removed).toEqual([]);
    expect(parsed.changed).toEqual([]);
  });
});

describe("loadCompare", () => {
  it("asks the compare endpoint with both versions and no credentials", async () => {
    const get = vi.fn().mockResolvedValue(COMPARE_BODY);
    const result = await loadCompare(SHORT, 1, 2, { get } as unknown as CompareClient);

    expect(get).toHaveBeenCalledWith(comparePath(SHORT), {
      query: { from: 1, to: 2 },
      auth: false,
      cache: "no-store",
    });
    expect(result.toChangeNote).toContain("adversarial baseline");
  });

  it("encodes the paper id into the path", () => {
    expect(comparePath(SHORT)).toBe(`/papers/${encodeURIComponent(SHORT)}/compare`);
  });
});

describe("describeCompareError", () => {
  it("uses the parser's own sentence for a body it could not read", () => {
    expect(describeCompareError(new CompareResponseError("Boom."))).toBe("Boom.");
  });

  it("says the node does not hold both versions on a 404", () => {
    const apiError = new ApiError(404, { title: "Not Found", status: 404 });
    expect(describeCompareError(apiError)).toBe(
      "This server does not hold both versions of that paper.",
    );
  });

  it("falls back to the node's own words, then to a plain sentence", () => {
    const detail = new ApiError(500, {
      title: "Server Error",
      status: 500,
      detail: "The diff job failed.",
    });
    expect(describeCompareError(detail)).toBe("The diff job failed.");
    expect(describeCompareError(undefined)).toBe(
      "The comparison could not be loaded. Try again.",
    );
  });
});

describe("describeCompareSummary", () => {
  it("counts each kind and names both versions", () => {
    expect(
      describeCompareSummary(
        data({
          changed: [
            {
              from: { id: "a", position: 0, text: "Old." },
              to: { id: "b", position: 0, text: "New." },
            },
          ],
          added: [{ id: "c", position: 1, text: "Added." }],
          removed: [{ id: "d", position: 2, text: "Removed." }],
        }),
      ),
    ).toBe(
      "1 paragraph changed, 1 paragraph added and 1 paragraph removed between v1 and v2.",
    );
  });

  it("pluralises and omits the kinds that did not change", () => {
    expect(
      describeCompareSummary(
        data({
          changed: [
            { from: { id: "a", position: 0, text: "A." }, to: { id: "b", position: 0, text: "B." } },
            { from: { id: "c", position: 1, text: "C." }, to: { id: "d", position: 1, text: "D." } },
          ],
        }),
      ),
    ).toBe("2 paragraphs changed between v1 and v2.");
  });

  it("says plainly when there is no difference", () => {
    expect(describeCompareSummary(data())).toBe(
      "These two versions have the same paragraphs.",
    );
  });
});

describe("comparePagePath", () => {
  it("writes the paper page's compare address without the sch: prefix", () => {
    expect(comparePagePath(SHORT, 1, 2)).toBe("/p/6sel-2dio-orm6/compare/1..2");
  });
});
