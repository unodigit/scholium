import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  CompareResponseError,
  comparePath,
  describeCompareError,
  describeCompareSummary,
  describeFileChange,
  diffFiles,
  diffText,
  loadCompare,
  parseCompare,
  type CompareClient,
  type CompareData,
  type CompareFile,
} from "./compare";
import { CompareView } from "./compare-view";
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
    files: [],
    details: [],
    detailsRead: true,
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

/* -------------------------------------------------------------------------- */
/* Files and details: what a new version can change besides its paragraphs     */
/* -------------------------------------------------------------------------- */

function file(path: string, cid: string, size: number, role = "manuscript"): CompareFile {
  return { path, cid, size, role, mediaType: null };
}

describe("diffFiles", () => {
  const v1 = [file("paper.pdf", "bafkrei-pdf-1", 482113), file("code/run.py", "bafkrei-code", 1204, "code")];

  it("reports nothing for the same files, whatever order they are listed in", () => {
    expect(diffFiles(v1, [...v1].reverse())).toEqual([]);
  });

  it("says a file with the same path and different bytes was replaced, with both sizes", () => {
    const v2 = [file("paper.pdf", "bafkrei-pdf-2", 530004), v1[1]];
    const changes = diffFiles(v1, v2);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "replaced", path: "paper.pdf" });
    expect(changes[0].from?.size).toBe(482113);
    expect(changes[0].to?.size).toBe(530004);
  });

  it("says a new path was added and a dropped path was removed", () => {
    const v2 = [v1[0], file("paper.tex", "bafkrei-tex", 9120, "source")];
    const changes = diffFiles(v1, v2);
    expect(changes.map((change) => [change.kind, change.path])).toEqual([
      ["added", "paper.tex"],
      ["removed", "code/run.py"],
    ]);
    expect(changes[0].from).toBeNull();
    expect(changes[1].to).toBeNull();
  });

  it("writes each change in words, with the size, never by colour alone", () => {
    expect(describeFileChange(diffFiles([], [file("paper.pdf", "c1", 2048)])[0])).toBe(
      "Added paper.pdf (2.0 KB)",
    );
    expect(describeFileChange(diffFiles([file("paper.pdf", "c1", 2048)], [])[0])).toBe(
      "Removed paper.pdf (2.0 KB)",
    );
    expect(
      describeFileChange(diffFiles([file("paper.pdf", "c1", 2048)], [file("paper.pdf", "c2", 3072)])[0]),
    ).toBe("Replaced paper.pdf (2.0 KB → 3.0 KB)");
  });
});

describe("diffText", () => {
  it("marks the words that went and the words that came, and keeps the rest", () => {
    const segments = diffText("We probe reward models.", "We probe reward and preference models.");
    expect(segments.filter((segment) => segment.kind === "added").map((segment) => segment.text.trim())).toEqual([
      "and preference",
    ]);
    expect(segments.filter((segment) => segment.kind === "removed")).toEqual([]);
    // Reading the segments back, without the removed ones, gives the new text.
    expect(
      segments
        .filter((segment) => segment.kind !== "removed")
        .map((segment) => segment.text)
        .join(""),
    ).toBe("We probe reward and preference models.");
    expect(
      segments
        .filter((segment) => segment.kind !== "added")
        .map((segment) => segment.text)
        .join(""),
    ).toBe("We probe reward models.");
  });

  it("is a single unchanged segment for identical text", () => {
    expect(diffText("Same words.", "Same words.")).toEqual([{ kind: "same", text: "Same words." }]);
  });
});

function manifestBody(n: number, files: CompareFile[]): Record<string, unknown> {
  return {
    shortId: SHORT,
    n,
    manifestCid: `bafyrei-manifest-${n}`,
    licence: "CC-BY-4.0",
    files: files.map((item) => ({ ...item, mediaType: "application/octet-stream", scanStatus: "passed" })),
  };
}

/** A node that answers the compare, the two manifests and the two version reads. */
function nodeClient(options: {
  manifests: Record<number, CompareFile[] | "missing">;
  versions: Record<number, { title: string; abstract: string } | "missing">;
  compare?: Record<string, unknown>;
}): CompareClient {
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/compare")) {
      return (
        options.compare ?? {
          addedParagraphs: [],
          removedParagraphs: [],
          changedParagraphs: [],
          fromChangeNote: "Initial version.",
          toChangeNote: "Replaces the PDF and answers the reviewers.",
        }
      );
    }
    const manifest = /\/v\/(\d+)\/manifest$/.exec(path);
    if (manifest !== null) {
      const found = options.manifests[Number(manifest[1])];
      if (found === undefined || found === "missing") {
        throw new ApiError(404, { title: "Not Found", status: 404 });
      }
      return manifestBody(Number(manifest[1]), found);
    }
    const version = /\/v(\d+)$/.exec(path);
    if (version !== null) {
      const found = options.versions[Number(version[1])];
      if (found === undefined || found === "missing") {
        throw new ApiError(404, { title: "Not Found", status: 404 });
      }
      return { shortId: SHORT, n: Number(version[1]), ...found };
    }
    throw new Error(`unexpected read of ${path}`);
  });
  return { get } as unknown as CompareClient;
}

const V1_FILES = [file("paper.pdf", "bafkrei-pdf-1", 482113), file("code/run.py", "bafkrei-code", 1204, "code")];
const V2_FILES = [
  file("paper.pdf", "bafkrei-pdf-2", 530004),
  file("code/run.py", "bafkrei-code", 1204, "code"),
  file("paper.tex", "bafkrei-tex", 9120, "source"),
];

describe("loadCompare — files, title, abstract and change note", () => {
  it("reads both versions' manifests and says which files were replaced and added", async () => {
    const result = await loadCompare(
      SHORT,
      1,
      2,
      nodeClient({
        manifests: { 1: V1_FILES, 2: V2_FILES },
        versions: {
          1: { title: "Sparse Probing", abstract: "We probe reward models." },
          2: { title: "Sparse Probing", abstract: "We probe reward models." },
        },
      }),
    );

    expect(result.files).not.toBeNull();
    expect(result.files?.map((change) => [change.kind, change.path])).toEqual([
      ["replaced", "paper.pdf"],
      ["added", "paper.tex"],
    ]);
    expect(result.files?.[0].from?.size).toBe(482113);
    expect(result.files?.[0].to?.size).toBe(530004);
  });

  it("diffs the title, the abstract and the change note as text", async () => {
    const result = await loadCompare(
      SHORT,
      1,
      2,
      nodeClient({
        manifests: { 1: V1_FILES, 2: V1_FILES },
        versions: {
          1: { title: "Sparse Probing", abstract: "We probe reward models." },
          2: { title: "Sparse Probing of Reward Models", abstract: "We probe reward and preference models." },
        },
      }),
    );

    expect(result.detailsRead).toBe(true);
    expect(result.details.map((change) => change.field)).toEqual(["title", "abstract", "changeNote"]);
    const title = result.details[0];
    expect(title.from).toBe("Sparse Probing");
    expect(title.to).toBe("Sparse Probing of Reward Models");
    expect(title.segments.some((segment) => segment.kind === "added" && /Reward/.test(segment.text))).toBe(true);
    expect(result.details[2].to).toBe("Replaces the PDF and answers the reviewers.");
  });

  it("leaves out a field that did not change", async () => {
    const same = { title: "Sparse Probing", abstract: "We probe reward models." };
    const result = await loadCompare(
      SHORT,
      1,
      2,
      nodeClient({ manifests: { 1: V1_FILES, 2: V1_FILES }, versions: { 1: same, 2: same } }),
    );
    expect(result.details.map((change) => change.field)).toEqual(["changeNote"]);
    expect(result.files).toEqual([]);
  });

  it("says the file lists are unknown when a manifest cannot be read, rather than that nothing changed", async () => {
    const same = { title: "T", abstract: "A" };
    const result = await loadCompare(
      SHORT,
      1,
      2,
      nodeClient({ manifests: { 1: V1_FILES, 2: "missing" }, versions: { 1: same, 2: same } }),
    );
    expect(result.files).toBeNull();
  });

  it("says the details are unknown when a version cannot be read, and still diffs the change note", async () => {
    const result = await loadCompare(
      SHORT,
      1,
      2,
      nodeClient({ manifests: { 1: V1_FILES, 2: V1_FILES }, versions: { 1: "missing", 2: "missing" } }),
    );
    expect(result.detailsRead).toBe(false);
    expect(result.details.map((change) => change.field)).toEqual(["changeNote"]);
  });
});

describe("describeCompareSummary — beyond the paragraphs", () => {
  it("names a replaced PDF even when every paragraph is the same", () => {
    const summary = describeCompareSummary(
      data({ files: diffFiles(V1_FILES, V2_FILES), details: [] }),
    );
    expect(summary).not.toBe("These two versions have the same paragraphs.");
    expect(summary).toContain("1 file replaced");
    expect(summary).toContain("1 file added");
    expect(summary).toContain("between v1 and v2");
  });

  it("names a changed title or abstract", () => {
    const [title] = [
      {
        field: "title" as const,
        label: "Title",
        from: "A",
        to: "B",
        segments: diffText("A", "B"),
      },
    ];
    expect(describeCompareSummary(data({ details: [title] }))).toContain("title changed");
  });

  it("keeps the paragraph-only sentence when nothing else differs", () => {
    expect(describeCompareSummary(data())).toBe("These two versions have the same paragraphs.");
  });
});

function render(over: Partial<CompareData>): string {
  return renderToStaticMarkup(
    createElement(CompareView, { shortId: SHORT, data: data(over), paperTitle: "Sparse Probing" }),
  );
}

describe("CompareView — files and details", () => {
  it("does not say 'Nothing changed' when only a file was replaced", () => {
    const html = render({ files: diffFiles(V1_FILES, V2_FILES) });
    expect(html).not.toContain("Nothing changed");
    expect(html).toContain("Files");
    expect(html).toContain("Replaced paper.pdf");
    expect(html).toContain("Added paper.tex");
  });

  it("shows each file change with the sizes on both sides", () => {
    const html = render({ files: diffFiles(V1_FILES, V2_FILES) });
    expect(html).toContain("470.8 KB");
    expect(html).toContain("517.6 KB");
  });

  it("shows a changed abstract as a text diff, old words struck and new words inserted", () => {
    const html = render({
      details: [
        {
          field: "abstract",
          label: "Abstract",
          from: "We probe reward models.",
          to: "We probe reward and preference models.",
          segments: diffText("We probe reward models.", "We probe reward and preference models."),
        },
      ],
    });
    expect(html).not.toContain("Nothing changed");
    expect(html).toContain("Abstract");
    expect(html).toContain("<ins>");
  });

  it("draws the change note's diff inside the Change notes, struck on v1's side and inserted on v2's", () => {
    const html = render({
      fromChangeNote: "Initial version.",
      toChangeNote: "Initial version with the appendix.",
      details: [
        {
          field: "changeNote",
          label: "Change note",
          from: "Initial version.",
          to: "Initial version with the appendix.",
          segments: diffText("Initial version.", "Initial version with the appendix."),
        },
      ],
    });
    expect(html).toContain("<ins>with the appendix</ins>");
    // A note that only differs is not a change to the paper: the empty state stands.
    expect(html).toContain("Nothing changed between these versions.");
  });

  it("still says 'Nothing changed' when paragraphs, files and details all match", () => {
    expect(render({})).toContain("Nothing changed between these versions.");
  });

  it("does not claim nothing changed when the file lists could not be read", () => {
    const html = render({ files: null });
    expect(html).not.toContain("Nothing changed");
    expect(html).toContain("could not be compared");
  });
});
