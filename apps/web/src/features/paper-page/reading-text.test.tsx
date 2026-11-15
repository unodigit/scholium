// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadKatex, type LoadMath } from "./math-typeset";
import { stubApi } from "./paper-page-fixtures";
import { ReadingText } from "./reading-text";

/**
 * The paragraphs of the reading column, with their math typeset once the page
 * runs. The annotation component (feature 150) renders the paragraphs; these
 * tests check that typesetting works on what it renders and does not get in the
 * way of what it does.
 */

const PARAGRAPHS = [
  { id: "p1", text: "Multi-agent systems increasingly choose between plans." },
  { id: "p2", text: "The score is $s = \\sum_i w_i x_i$ for each branch." },
  { id: "p3", text: "A fee of $5 to $10 applies." },
  { id: "p4", text: "Normalising gives $$\\frac{a}{b}$$ in the limit." },
];

function renderText(loadMath: LoadMath = loadKatex, paragraphs = PARAGRAPHS) {
  return render(
    <ReadingText
      paperId="sch:6sel-2dio-orm6"
      version={2}
      versionCid="bafyrei-version-2"
      paragraphs={paragraphs}
      loadMath={loadMath}
    />,
  );
}

function paragraphElement(id: string): HTMLElement {
  const element = document.getElementById(`p-${id}`);
  if (element === null) {
    throw new Error(`no paragraph ${id}`);
  }
  return element;
}

beforeEach(() => {
  // The annotation component reads its markers on mount; this node has none.
  stubApi({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReadingText: paragraphs", () => {
  it("shows every paragraph as text before anything is typeset", () => {
    // `loadMath` never settles: this is the first paint, and what a reader with
    // no JavaScript would get.
    renderText(() => new Promise(() => {}));

    expect(paragraphElement("p1").textContent).toBe(PARAGRAPHS[0].text);
    expect(paragraphElement("p2").textContent).toBe(PARAGRAPHS[1].text);
  });
});

describe("ReadingText: math", () => {
  it("typesets the paragraphs that have math", async () => {
    renderText();

    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });
    expect(paragraphElement("p4").querySelector(".katex-display")).not.toBeNull();
    // The words around a formula are still there, the delimiters are not.
    expect(paragraphElement("p2").textContent).toContain("The score is ");
    expect(paragraphElement("p2").textContent).toContain(" for each branch.");
    expect(paragraphElement("p2").querySelector(".katex-html")?.textContent).not.toContain("$");
  });

  it("leaves a paragraph with no math, and one with only a price, as it was", async () => {
    renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    expect(paragraphElement("p1").querySelector(".katex")).toBeNull();
    expect(paragraphElement("p1").textContent).toBe(PARAGRAPHS[0].text);
    expect(paragraphElement("p3").textContent).toBe(PARAGRAPHS[2].text);
  });

  it("exposes each formula as MathML for screen readers", async () => {
    renderText();

    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex-mathml math")).not.toBeNull();
    });
    // The visible glyphs are hidden from assistive technology so a formula is
    // read once, from the MathML.
    expect(paragraphElement("p2").querySelector(".katex-html")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("does not load the math renderer for a paper that has none", async () => {
    const loadMath = vi.fn(loadKatex);

    renderText(loadMath, [PARAGRAPHS[0], PARAGRAPHS[2]]);
    // Let any effect settle.
    await Promise.resolve();

    expect(loadMath).not.toHaveBeenCalled();
  });

  it("keeps the LaTeX on the page when the renderer cannot be fetched", async () => {
    const loadMath = vi.fn(async () => {
      throw new Error("chunk failed to load");
    });

    renderText(loadMath);
    await waitFor(() => expect(loadMath).toHaveBeenCalled());
    await Promise.resolve();

    expect(paragraphElement("p2").textContent).toBe(PARAGRAPHS[1].text);
    expect(paragraphElement("p2").querySelector(".katex")).toBeNull();
  });

  it("does not touch the page if it went away before the renderer arrived", async () => {
    let arrive: (renderer: Awaited<ReturnType<LoadMath>>) => void = () => {};
    const slow: LoadMath = () =>
      new Promise((resolve) => {
        arrive = resolve;
      });
    const view = renderText(slow);
    const element = paragraphElement("p2");

    view.unmount();
    arrive(await loadKatex());
    await Promise.resolve();

    expect(element.querySelector(".katex")).toBeNull();
  });

  it("typesets again when a paragraph's text changes", async () => {
    const view = renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    view.rerender(
      <ReadingText
        paperId="sch:6sel-2dio-orm6"
        version={3}
        versionCid="bafyrei-version-3"
        paragraphs={[
          PARAGRAPHS[0],
          { id: "p2", text: "The revised score is $r = \\prod_i w_i$ now." },
          PARAGRAPHS[2],
          PARAGRAPHS[3],
        ]}
        loadMath={loadKatex}
      />,
    );

    await waitFor(() => {
      expect(paragraphElement("p2").textContent).toContain("The revised score is ");
    });
    await waitFor(() => {
      expect(
        paragraphElement("p2").querySelector('annotation[encoding="application/x-tex"]')
          ?.textContent,
      ).toBe("r = \\prod_i w_i");
    });
  });
});

describe("ReadingText: annotations", () => {
  it("still selects a typeset paragraph and opens the composer on A", async () => {
    renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    const paragraph = paragraphElement("p2");
    fireEvent.focus(paragraph);
    expect(paragraph.getAttribute("data-selected")).toBe("true");

    fireEvent.keyDown(paragraph, { key: "a" });
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeTruthy();
    });
    // The paragraph is still typeset while it is being annotated.
    expect(paragraph.querySelector(".katex")).not.toBeNull();
  });
});
