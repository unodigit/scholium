import { describe, expect, it } from "vitest";

import {
  MAX_MATH_LENGTH,
  mathPlan,
  splitMath,
  type ParagraphSegment,
} from "./math";

/** Compact form of the segments, so a case reads as "text, then math". */
function shape(text: string): string[] {
  return splitMath(text).map((segment) =>
    segment.kind === "text"
      ? `text:${segment.text}`
      : `${segment.display ? "display" : "inline"}:${segment.tex}`,
  );
}

/** What each segment shows when it cannot be typeset: the paragraph, as written. */
function rebuilt(segments: readonly ParagraphSegment[]): string {
  return segments
    .map((segment) => (segment.kind === "text" ? segment.text : segment.source))
    .join("");
}

describe("splitMath: the four delimiters", () => {
  it("finds inline math between dollar signs", () => {
    expect(shape("Let $x^2$ be a square.")).toEqual([
      "text:Let ",
      "inline:x^2",
      "text: be a square.",
    ]);
  });

  it("finds inline math between \\( and \\)", () => {
    expect(shape("Let \\(x^2\\) be a square.")).toEqual([
      "text:Let ",
      "inline:x^2",
      "text: be a square.",
    ]);
  });

  it("finds display math between double dollar signs", () => {
    expect(shape("We have $$\\sum_{i=1}^n i$$ for all n.")).toEqual([
      "text:We have ",
      "display:\\sum_{i=1}^n i",
      "text: for all n.",
    ]);
  });

  it("finds display math between \\[ and \\]", () => {
    expect(shape("We have \\[E = mc^2\\] here.")).toEqual([
      "text:We have ",
      "display:E = mc^2",
      "text: here.",
    ]);
  });

  it("finds several formulas in one paragraph, in reading order", () => {
    expect(shape("$a$ and $b$, then \\(c\\)")).toEqual([
      "inline:a",
      "text: and ",
      "inline:b",
      "text:, then ",
      "inline:c",
    ]);
  });

  it("lets a display formula span lines", () => {
    expect(shape("$$\na = b\n$$")).toEqual(["display:\na = b\n"]);
  });

  it("keeps the delimiters in `source`, so a formula that cannot be typeset can be shown as written", () => {
    const segments = splitMath("so $x_1$ and $$y$$");
    const sources = segments.flatMap((segment) =>
      segment.kind === "math" ? [segment.source] : [],
    );
    expect(sources).toEqual(["$x_1$", "$$y$$"]);
  });
});

describe("splitMath: dollar signs that are not math", () => {
  it("leaves prices alone", () => {
    expect(shape("It costs $5 to $10 each.")).toEqual(["text:It costs $5 to $10 each."]);
  });

  it("leaves a price range with no spaces alone", () => {
    // The second `$` is followed by a digit, so it cannot close a formula.
    expect(shape("Between $5–$10 a head.")).toEqual(["text:Between $5–$10 a head."]);
  });

  it("finds math after prices", () => {
    expect(shape("$5 to $10 or $x$")).toEqual(["text:$5 to $10 or ", "inline:x"]);
  });

  it("does not open math on a dollar sign followed by a space", () => {
    expect(shape("a $ b $ c")).toEqual(["text:a $ b $ c"]);
  });

  it("does not close math on a dollar sign that follows a space", () => {
    expect(shape("$x $ y")).toEqual(["text:$x $ y"]);
  });

  it("shows an escaped dollar sign as a dollar sign", () => {
    expect(shape("It costs \\$5 and \\$10.")).toEqual(["text:It costs $5 and $10."]);
  });

  it("does not let an escaped dollar sign end a formula", () => {
    expect(shape("$a \\$ b$")).toEqual(["inline:a \\$ b"]);
  });

  it("keeps a lone dollar sign", () => {
    expect(shape("just a $ here")).toEqual(["text:just a $ here"]);
  });
});

describe("splitMath: delimiters with no partner", () => {
  it("leaves an unclosed \\( as text", () => {
    expect(shape("a \\(b with no end")).toEqual(["text:a \\(b with no end"]);
  });

  it("leaves an unclosed \\[ as text", () => {
    expect(shape("a \\[b with no end")).toEqual(["text:a \\[b with no end"]);
  });

  it("leaves an unclosed $$ as text", () => {
    expect(shape("a $$b with no end")).toEqual(["text:a $$b with no end"]);
  });

  it("leaves an unclosed $ as text", () => {
    expect(shape("a $b with no end")).toEqual(["text:a $b with no end"]);
  });

  it("leaves empty delimiters as text", () => {
    expect(shape("a $$$$ b")).toEqual(["text:a $$$$ b"]);
    expect(shape("a \\(\\) b")).toEqual(["text:a \\(\\) b"]);
    expect(shape("a \\( \\) b")).toEqual(["text:a \\( \\) b"]);
  });

  it("does not take a LaTeX line break for an escape of what follows it", () => {
    expect(shape("a \\\\$x$")).toEqual(["text:a \\\\", "inline:x"]);
  });

  it("leaves a backslash in prose alone", () => {
    expect(shape("the path C:\\temp\\alpha")).toEqual(["text:the path C:\\temp\\alpha"]);
  });

  it("gives up on a formula longer than the cap, instead of searching to the end", () => {
    const long = `$${"x".repeat(MAX_MATH_LENGTH + 10)}$`;
    expect(splitMath(long)).toEqual([{ kind: "text", text: long }]);
  });
});

describe("splitMath: never loses text", () => {
  const paragraphs = [
    "",
    "plain",
    "Let $x^2$ be \\(y\\) and $$z$$ or \\[w\\].",
    "It costs $5 to $10, but $x$ is free.",
    "unclosed $a and \\(b and $$c and \\[d",
    "odd \\\\ and \\alpha and {braces} and ünïcode ∑",
  ];

  it.each(paragraphs)("reproduces %j from its segments' sources", (paragraph) => {
    // Escapes aside (`\$` shows as `$`), every character is accounted for.
    expect(rebuilt(splitMath(paragraph))).toBe(paragraph.replace(/\\\$/g, "$"));
  });
});

describe("mathPlan", () => {
  it("is null for a paragraph with nothing to typeset", () => {
    expect(mathPlan("An ordinary paragraph, with a $5 price.")).toBeNull();
  });

  it("is null for an empty paragraph", () => {
    expect(mathPlan("")).toBeNull();
  });

  it("is the segments for a paragraph with a formula", () => {
    expect(mathPlan("so $x$")?.map((segment) => segment.kind)).toEqual(["text", "math"]);
  });

  it("is the segments for a paragraph that only has an escaped dollar sign", () => {
    // The `\` must not be shown, so the paragraph is not left as it was.
    expect(mathPlan("costs \\$5")).toEqual([{ kind: "text", text: "costs $5" }]);
  });
});
