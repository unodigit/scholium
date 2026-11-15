// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ABSTRACT_SOURCE,
  CITE_ATTRIBUTE,
  CITE_LABEL,
  MAX_QUOTE_CHARS,
  appendCitation,
  citationFromSelection,
  collapseWhitespace,
  describeCitation,
  formatCitation,
  paragraphSource,
  shortenQuote,
  sourceRange,
} from "./citation";

describe("the words", () => {
  it("is the design's button label", () => {
    expect(CITE_LABEL).toBe("Cite in review");
  });

  it("marks citable blocks with the attribute the paper pane writes", () => {
    expect(CITE_ATTRIBUTE).toBe("data-cite");
  });
});

describe("collapseWhitespace", () => {
  it("makes every run of whitespace, newlines included, one space", () => {
    expect(collapseWhitespace("  one\n\n two\t three  ")).toBe("one two three");
  });
});

describe("shortenQuote", () => {
  it("leaves a quote that fits as it is", () => {
    expect(shortenQuote("A short quote.")).toBe("A short quote.");
  });

  it("cuts a long quote at a word and ends it with an ellipsis", () => {
    const long = "word ".repeat(200);
    const quote = shortenQuote(long);

    expect(quote.endsWith("…")).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 1);
    // Cut at a word boundary: nothing is left half-spelled.
    expect(quote.replace("…", "").split(" ").every((w) => w === "word")).toBe(
      true,
    );
  });

  it("does not leave punctuation hanging before the ellipsis", () => {
    const text = `${"a".repeat(18)}, ${"b".repeat(20)}`;
    expect(shortenQuote(text, 20)).toBe(`${"a".repeat(18)}…`);
  });

  it("cuts a single very long token rather than keeping next to nothing", () => {
    expect(shortenQuote("x".repeat(500), 50)).toBe(`${"x".repeat(50)}…`);
  });
});

describe("naming a place", () => {
  it("names a paragraph by number and by the start of its stable id", () => {
    expect(paragraphSource(7, "3fa9c1d2e5b84a1f9c0d")).toBe("¶ 7 · 3fa9c1d2");
  });

  it("names a paragraph by number alone when it has no id", () => {
    expect(paragraphSource(3, "  ")).toBe("¶ 3");
  });

  it("names one place once, and a span by its first and last", () => {
    expect(sourceRange("¶ 2 · aa", "¶ 2 · aa")).toBe("¶ 2 · aa");
    expect(sourceRange("abstract", "¶ 3 · cc")).toBe(
      "abstract – ¶ 3 · cc",
    );
  });
});

describe("formatCitation", () => {
  it("quotes the words in curly quotes, then says where they are", () => {
    expect(
      formatCitation({ quote: "We define a safety score.", source: "¶ 2 · bbbb2222" }),
    ).toBe("“We define a safety score.” [¶ 2 · bbbb2222]");
  });
});

describe("appendCitation", () => {
  const citation = { quote: "A quote.", source: "abstract" };
  const cited = "“A quote.” [abstract]";

  it("starts an empty box with the citation and a fresh line to carry on", () => {
    expect(appendCitation("", citation)).toBe(`${cited}\n`);
    expect(appendCitation("  \n ", citation)).toBe(`${cited}\n`);
  });

  it("adds the citation after what the reviewer wrote, on its own paragraph", () => {
    expect(appendCitation("The proof is wrong.", citation)).toBe(
      `The proof is wrong.\n\n${cited}\n`,
    );
  });

  it("does not stack blank lines when the box already ends in them", () => {
    expect(appendCitation("The proof is wrong.\n\n\n", citation)).toBe(
      `The proof is wrong.\n\n${cited}\n`,
    );
  });

  it("never changes what the reviewer wrote", () => {
    const written = "  Indented start.\nSecond line.";
    expect(appendCitation(written, citation).startsWith(written)).toBe(true);
  });
});

describe("describeCitation", () => {
  it("says what was quoted and where it went", () => {
    expect(
      describeCitation({ quote: "q", source: "¶ 2 · bb" }, "Novelty"),
    ).toBe("Quoted ¶ 2 · bb in the justification for Novelty.");
  });
});

describe("citationFromSelection", () => {
  let root: HTMLElement;
  let outside: HTMLElement;
  const text = (id: string): Text => {
    const node = document.getElementById(id)?.firstChild;
    if (!(node instanceof Text)) throw new Error(`no text in #${id}`);
    return node;
  };

  beforeEach(() => {
    document.body.innerHTML = `
      <p id="outside">Text outside the paper.</p>
      <div id="root">
        <h2 id="h-abstract">Abstract</h2>
        <p id="abs" data-cite="abstract">We study how a meta-agent picks between branches.</p>
        <h2 id="h-text">Full text</h2>
        <p id="p1" data-cite="¶ 1 · aaaa1111">Multi-agent systems increasingly delegate choices.</p>
        <p id="p2" data-cite="¶ 2 · bbbb2222">We define a safety score for each branch.</p>
        <p id="p3" data-cite="¶ 3 · cccc3333">Scores are compared across branches.</p>
      </div>`;
    root = document.getElementById("root") as HTMLElement;
    outside = document.getElementById("outside") as HTMLElement;
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  function select(
    startNode: Node,
    startOffset: number,
    endNode: Node,
    endOffset: number,
  ): Selection {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  it("quotes the words selected in one paragraph and names it", () => {
    const node = text("p2");
    const start = node.data.indexOf("safety");
    const found = citationFromSelection(
      root,
      select(node, start, node, start + "safety score".length),
    );

    expect(found?.citation).toEqual({
      quote: "safety score",
      source: "¶ 2 · bbbb2222",
    });
  });

  it("quotes the abstract and names it as the abstract", () => {
    const node = text("abs");
    const found = citationFromSelection(root, select(node, 9, node, 18));

    expect(found?.citation.source).toBe(ABSTRACT_SOURCE);
    expect(found?.citation.quote).toBe(node.data.slice(9, 18));
  });

  it("names the first and last paragraph of a selection that spans several", () => {
    const first = text("p1");
    const found = citationFromSelection(
      root,
      select(first, first.data.indexOf("systems"), text("p3"), "Scores".length),
    );

    expect(found?.citation.source).toBe(
      "¶ 1 · aaaa1111 – ¶ 3 · cccc3333",
    );
    expect(found?.citation.quote).toBe(
      "systems increasingly delegate choices. " +
        "We define a safety score for each branch. " +
        "Scores",
    );
  });

  it("leaves a heading between the abstract and the text out of the quote", () => {
    const abstract = text("abs");
    const found = citationFromSelection(
      root,
      select(abstract, abstract.data.indexOf("between"), text("p1"), "Multi".length),
    );

    expect(found?.citation.source).toBe("abstract – ¶ 1 · aaaa1111");
    expect(found?.citation.quote).toBe("between branches. Multi");
    expect(found?.citation.quote).not.toMatch(/Full text/);
  });

  it("does not count the next paragraph when a triple-click ends at its start", () => {
    // Browsers end a whole-paragraph selection at (next block, 0).
    const found = citationFromSelection(
      root,
      select(text("p1"), 0, document.getElementById("p2") as HTMLElement, 0),
    );

    expect(found?.citation.source).toBe("¶ 1 · aaaa1111");
    expect(found?.citation.quote).toBe(
      "Multi-agent systems increasingly delegate choices.",
    );
  });

  it("collapses the whitespace of what it quotes", () => {
    document.getElementById("p2")!.textContent =
      "We define\n   a safety   score.";
    const node = text("p2");
    const found = citationFromSelection(root, select(node, 0, node, node.data.length));

    expect(found?.citation.quote).toBe("We define a safety score.");
  });

  it("shortens a very long selection", () => {
    const long = "word ".repeat(200);
    document.getElementById("p2")!.textContent = long;
    const node = text("p2");
    const found = citationFromSelection(root, select(node, 0, node, node.data.length));

    expect(found?.citation.quote.endsWith("…")).toBe(true);
    expect(found!.citation.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 1);
  });

  it("offers nothing when nothing is selected", () => {
    expect(citationFromSelection(root, null)).toBeNull();
    expect(citationFromSelection(root, window.getSelection())).toBeNull();

    const node = text("p2");
    expect(citationFromSelection(root, select(node, 3, node, 3))).toBeNull();
  });

  it("offers nothing for a selection outside the paper", () => {
    const node = outside.firstChild as Text;
    expect(citationFromSelection(root, select(node, 0, node, 8))).toBeNull();
  });

  it("offers nothing for a selection that reaches out of the paper", () => {
    // It is not only the paper's words, so it is not quoted as if it were.
    const inside = text("p3");
    expect(
      citationFromSelection(
        root,
        select(inside, 0, outside.firstChild as Text, 4),
      ),
    ).toBeNull();
  });

  it("offers nothing for a selection that holds only a heading", () => {
    const heading = text("h-text");
    expect(citationFromSelection(root, select(heading, 0, heading, 4))).toBeNull();
  });

  it("offers nothing for a selection of only whitespace", () => {
    document.getElementById("p2")!.textContent = "Before.    After.";
    const node = text("p2");
    expect(citationFromSelection(root, select(node, 7, node, 10))).toBeNull();
  });

  describe("where to put the button", () => {
    const original = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

    afterEach(() => {
      if (original === undefined) {
        delete (Range.prototype as Partial<Range>).getClientRects;
      } else {
        Object.defineProperty(Range.prototype, "getClientRects", original);
      }
    });

    it("is the end of the last line of the selection", () => {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [
          { left: 10, top: 10, right: 300, bottom: 30, width: 290, height: 20 },
          { left: 10, top: 30, right: 120, bottom: 50, width: 110, height: 20 },
        ],
      });
      const node = text("p2");
      const found = citationFromSelection(root, select(node, 0, node, 10));

      expect(found?.point).toEqual({ right: 120, bottom: 50 });
    });

    it("skips an empty rectangle, as a line break leaves", () => {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [
          { left: 10, top: 10, right: 120, bottom: 30, width: 110, height: 20 },
          { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        ],
      });
      const node = text("p2");
      const found = citationFromSelection(root, select(node, 0, node, 10));

      expect(found?.point).toEqual({ right: 120, bottom: 30 });
    });

    it("is unknown where the browser cannot measure a range", () => {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
      const node = text("p2");
      const found = citationFromSelection(root, select(node, 0, node, 10));

      // The citation is still offered; only the button's place is a guess.
      expect(found?.citation.quote).toBe("We define");
      expect(found?.point ?? null).toBeNull();
    });
  });
});
