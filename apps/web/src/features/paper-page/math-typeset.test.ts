// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TYPESET_ATTRIBUTE,
  hasMath,
  loadKatex,
  typesetParagraph,
  typesetParagraphs,
  type MathRenderer,
} from "./math-typeset";

/**
 * These tests use the real KaTeX: what matters is the markup a reader and a
 * screen reader actually get (typeset HTML and MathML), and a stub could not
 * show that.
 */

let katex: MathRenderer;

beforeEach(async () => {
  katex = await loadKatex();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** A paragraph element the way the annotation component renders it. */
function paragraph(id: string, text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.setAttribute("data-paragraph-id", id);
  element.textContent = text;
  document.body.append(element);
  return element;
}

describe("loadKatex", () => {
  it("fetches a renderer that typesets", async () => {
    const markup = (await loadKatex()).renderToString("x^2");
    expect(markup).toContain('class="katex"');
  });
});

describe("hasMath", () => {
  it("is true when any paragraph has a formula", () => {
    expect(hasMath([{ text: "plain" }, { text: "so $x$" }])).toBe(true);
  });

  it("is false for plain paragraphs, even with a price in them", () => {
    expect(hasMath([{ text: "plain" }, { text: "costs $5 to $10" }])).toBe(false);
  });

  it("is false for no paragraphs", () => {
    expect(hasMath([])).toBe(false);
  });
});

describe("typesetParagraph", () => {
  it("replaces a formula with typeset math and keeps the words around it", () => {
    const element = paragraph("a", "Let $x^2$ be a square.");

    expect(typesetParagraph(element, "Let $x^2$ be a square.", katex)).toBe(true);

    expect(element.querySelectorAll(".katex")).toHaveLength(1);
    // The delimiters are gone from what is read; the words are not.
    expect(element.textContent).not.toContain("$");
    expect(element.textContent).toContain("Let ");
    expect(element.textContent).toContain(" be a square.");
  });

  it("exposes the formula as MathML, with the LaTeX as its annotation", () => {
    const element = paragraph("a", "so $x^2$");
    typesetParagraph(element, "so $x^2$", katex);

    expect(element.querySelector(".katex-mathml math")).not.toBeNull();
    expect(
      element.querySelector('annotation[encoding="application/x-tex"]')?.textContent,
    ).toBe("x^2");
  });

  it("marks display math, so it can sit on its own line", () => {
    const element = paragraph("a", "so $$x$$ and $y$");
    typesetParagraph(element, "so $$x$$ and $y$", katex);

    const formulas = [...element.querySelectorAll(".ppg-math")];
    expect(formulas.map((formula) => formula.classList.contains("ppg-math--display"))).toEqual([
      true,
      false,
    ]);
    expect(element.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves a paragraph with no math exactly as it was", () => {
    const element = paragraph("a", "costs $5 to $10");
    const before = element.innerHTML;

    expect(typesetParagraph(element, "costs $5 to $10", katex)).toBe(false);

    expect(element.innerHTML).toBe(before);
  });

  it("shows an escaped dollar sign as a dollar sign", () => {
    const element = paragraph("a", "costs \\$5");
    typesetParagraph(element, "costs \\$5", katex);

    expect(element.textContent).toBe("costs $5");
  });

  it("shows a formula KaTeX cannot parse as the author wrote it", () => {
    // Delimited, so it is a formula to the splitter, but not valid LaTeX.
    const invalid = "bad $\\notacommand{x}$ here";
    const element = paragraph("a", invalid);

    typesetParagraph(element, invalid, katex);

    expect(element.querySelector(".katex")).toBeNull();
    expect(element.textContent).toBe(invalid);
    // No red error styling is borrowed from KaTeX.
    expect(element.querySelector(".katex-error")).toBeNull();
  });

  it("keeps typesetting the formulas around one that fails", () => {
    const text = "$a$ then $\\notacommand$ then $b$";
    const element = paragraph("a", text);
    typesetParagraph(element, text, katex);

    expect(element.querySelectorAll(".katex")).toHaveLength(2);
    expect(element.textContent).toContain("$\\notacommand$");
  });

  it("does not trust the input: a link command is refused, and the formula is shown as written", () => {
    const text = "see $\\href{https://example.com/phish}{here}$";
    const element = paragraph("a", text);

    typesetParagraph(element, text, katex);

    expect(element.querySelector("a")).toBeNull();
    // Not KaTeX's rendering of a refused command (a red `\href` with its
    // arguments dropped, which would misstate the formula): the author's text.
    expect(element.querySelector(".katex")).toBeNull();
    expect(element.innerHTML).not.toContain("#cc0000");
    expect(element.textContent).toBe(text);
  });

  it("refuses the other commands that reach out of the page", () => {
    for (const tex of [
      "\\url{https://example.com}",
      "\\includegraphics{https://example.com/pixel.png}",
      "\\htmlClass{x}{y}",
    ]) {
      const text = `see $${tex}$`;
      const element = paragraph("a", text);
      typesetParagraph(element, text, katex);

      expect(element.querySelector("a, img")).toBeNull();
      expect(element.textContent).toBe(text);
    }
  });

  it("caps a formula's sizes, so one cannot paint a page-sized box over the paper", () => {
    for (const tex of ["\\rule{1000em}{1000em}", "\\hspace{5000em}x", "\\kern{900em}x"]) {
      const text = `see $${tex}$`;
      const element = paragraph("a", text);

      typesetParagraph(element, text, katex);

      // It still typesets: the size is capped, not the formula refused.
      expect(element.querySelector(".katex")).not.toBeNull();
      // The MathML carries the LaTeX as written (`\rule{1000em}…`) as an
      // annotation: that is data, not layout, so only the layout is measured.
      const layout = element.innerHTML.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
      const sizes = [...layout.matchAll(/(\d+(?:\.\d+)?)em/g)].map((match) => Number(match[1]));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
    }
  });

  it("leaves the size of ordinary math alone", () => {
    const element = paragraph("a", "so $\\frac{a^2}{b}$");
    typesetParagraph(element, "so $\\frac{a^2}{b}$", katex);

    expect(element.querySelector(".katex")).not.toBeNull();
    expect(element.textContent).not.toContain("$");
  });

  it("does not let a formula inject markup: it is shown as text", () => {
    const text = "$\\text{<img src=x onerror=alert(1)>}$";
    const element = paragraph("a", text);

    typesetParagraph(element, text, katex);

    // It did typeset (this is not the fallback), and the markup in it is text.
    expect(element.querySelector(".katex")).not.toBeNull();
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("does nothing the second time", () => {
    const text = "so $x$";
    const element = paragraph("a", text);

    expect(typesetParagraph(element, text, katex)).toBe(true);
    const once = element.innerHTML;
    const content = element.firstElementChild;

    expect(typesetParagraph(element, text, katex)).toBe(false);

    expect(element.innerHTML).toBe(once);
    expect(element.firstElementChild).toBe(content);
    expect(element.querySelectorAll(`[${TYPESET_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it("typesets again once the paragraph's content has been replaced", () => {
    const element = paragraph("a", "so $x$");
    typesetParagraph(element, "so $x$", katex);

    // What React does when a paragraph's text changes: replace its content.
    element.textContent = "now $y$";

    expect(typesetParagraph(element, "now $y$", katex)).toBe(true);
    expect(element.querySelectorAll(".katex")).toHaveLength(1);
    expect(element.textContent).toContain("now ");
  });

  it("is given the renderer to use", () => {
    const stub: MathRenderer = { renderToString: vi.fn(() => "<b>rendered</b>") };
    const element = paragraph("a", "so $x$");

    typesetParagraph(element, "so $x$", stub);

    expect(stub.renderToString).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({
        displayMode: false,
        throwOnError: true,
        trust: expect.any(Function),
        output: "htmlAndMathml",
        maxSize: 10,
      }),
    );
    expect(element.querySelector("b")?.textContent).toBe("rendered");
  });

  it("refuses trust for every command a renderer asks about", () => {
    let answer: boolean | undefined;
    const stub: MathRenderer = {
      renderToString: (_tex, options) => {
        const trust = options?.trust;
        answer = typeof trust === "function" ? trust({ command: "\\href" }) : trust;
        return "<b>rendered</b>";
      },
    };
    const element = paragraph("a", "so $x$");

    typesetParagraph(element, "so $x$", stub);

    expect(answer).toBe(false);
    // The renderer asked, so the formula was refused: shown as written.
    expect(element.textContent).toBe("so $x$");
  });
});

describe("typesetParagraphs", () => {
  it("typesets the paragraphs that have math and leaves the rest", () => {
    const first = paragraph("p1", "plain words");
    const second = paragraph("p2", "so $x$");
    const third = paragraph("p3", "costs $5 to $10");
    const plainBefore = [first.innerHTML, third.innerHTML];

    const changed = typesetParagraphs(
      document.body,
      [
        { id: "p1", text: "plain words" },
        { id: "p2", text: "so $x$" },
        { id: "p3", text: "costs $5 to $10" },
      ],
      katex,
    );

    expect(changed).toBe(1);
    expect(second.querySelector(".katex")).not.toBeNull();
    expect([first.innerHTML, third.innerHTML]).toEqual(plainBefore);
  });

  it("ignores elements it was not given text for", () => {
    const stray = paragraph("unknown", "so $x$");

    expect(typesetParagraphs(document.body, [{ id: "p1", text: "so $x$" }], katex)).toBe(0);

    expect(stray.querySelector(".katex")).toBeNull();
  });

  it("only touches paragraphs, not the markers that carry the same id", () => {
    const marker = document.createElement("button");
    marker.setAttribute("data-paragraph-id", "p1");
    marker.textContent = "so $x$";
    document.body.append(marker);
    paragraph("p1", "so $x$");

    typesetParagraphs(document.body, [{ id: "p1", text: "so $x$" }], katex);

    expect(marker.textContent).toBe("so $x$");
  });

  it("is safe to run twice", () => {
    paragraph("p1", "so $x$");
    const paragraphs = [{ id: "p1", text: "so $x$" }];

    expect(typesetParagraphs(document.body, paragraphs, katex)).toBe(1);
    expect(typesetParagraphs(document.body, paragraphs, katex)).toBe(0);
  });
});
