import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CompareSection } from "./compare";
import { NameSection } from "./name-section";
import { PrinciplesSection } from "./principles";

afterEach(cleanup);

/* The reference's seven comparison rows (docs/homepage/index.html, #compare):
   [row header, typical server, Scholium]. */
const ROWS = [
  ["Proof of authorship", "The operator's database", "The authors' own signatures, checkable offline"],
  ["Proof of what changed", "A version list the operator keeps", "Each version records the fingerprint of the one before"],
  ["Peer review", "Elsewhere, usually closed", "Beside the paper, structured, readable by anyone"],
  ["AI assistance", "None, or unlabelled", "Advisory pre-review, clearly labelled, with evidence links"],
  ["Corrections", "A replaced file", "A signed record and a banner on every version"],
  ["Taking your work elsewhere", "Download the PDF", "Export a full archive that verifies without us"],
  ["Cost", "Usually free", "Free to read and to publish"],
] as const;

describe("CompareSection (#compare)", () => {
  it("renders the section with the reference's eyebrow, title and lead", () => {
    render(createElement(CompareSection));
    const section = document.getElementById("compare");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-labelledby")).toBe("compare-title");

    expect(screen.getByText("How Scholium compares")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Same free preprints. A record you can check." }),
    ).toBeTruthy();
    expect(
      screen.getByText("Scholium works alongside the preprint servers you already use. Here is what it adds."),
    ).toBeTruthy();
  });

  it("is a semantic table with an sr-only caption and three scoped column headers", () => {
    render(createElement(CompareSection));
    const table = screen.getByRole("table");

    const caption = table.querySelector("caption.sr-only");
    expect(caption?.textContent).toBe("How Scholium compares with a typical preprint server");

    const columns = within(table).getAllByRole("columnheader");
    expect(columns).toHaveLength(3);
    for (const column of columns) expect(column.getAttribute("scope")).toBe("col");
    expect(columns[0]?.textContent).toBe("Question"); // sr-only, still the header's name
    expect(columns[1]?.textContent).toBe("A typical preprint server");
    expect(columns[2]?.textContent).toBe("Scholium");
    expect(columns[2]?.className).toBe("us");
  });

  it("renders the reference's seven rows as scoped row headers with both columns", () => {
    render(createElement(CompareSection));
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders.map((th) => th.textContent)).toEqual(ROWS.map(([label]) => label));
    for (const rowHeader of rowHeaders) expect(rowHeader.getAttribute("scope")).toBe("row");

    const typical = cellsByLabel("Typical");
    const scholium = cellsByLabel("Scholium");
    expect(typical.map((td) => td.textContent)).toEqual(ROWS.map(([, typicalText]) => typicalText));
    expect(scholium.map((td) => td.textContent)).toEqual(ROWS.map(([, , scholiumText]) => scholiumText));
  });

  it("tints the Scholium column and puts a check icon in each of its seven cells", () => {
    render(createElement(CompareSection));
    const scholium = cellsByLabel("Scholium");
    expect(scholium).toHaveLength(7);
    for (const cell of scholium) {
      expect(cell.classList.contains("us")).toBe(true);
      expect(cell.querySelector("svg.ico")).not.toBeNull();
    }
    for (const cell of cellsByLabel("Typical")) expect(cell.querySelector("svg")).toBeNull();
  });
});

function cellsByLabel(label: string): HTMLElement[] {
  return screen
    .getAllByRole("cell")
    .filter((cell) => cell.getAttribute("data-label") === label) as HTMLElement[];
}

/* -------------------------------------------------------------------------- */

const PRINCIPLE_CARDS = [
  ["No token.", "There is nothing to trade or speculate on, and no token-weighted votes on scientific questions. Ever."],
  ["No paywall.", "Free to read and free to publish, with an open licence by default."],
  [
    "No verdicts.",
    "Scholium isn't a journal. It lists, reviews and badges papers. It doesn't accept or reject science.",
  ],
  [
    "No quiet edits.",
    "Corrections, retractions and moderation decisions are signed, public records. Old versions stay readable.",
  ],
] as const;

describe("PrinciplesSection (#principles)", () => {
  it("renders the section with the reference's eyebrow and title", () => {
    render(createElement(PrinciplesSection));
    const section = document.getElementById("principles");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-labelledby")).toBe("principles-title");

    expect(screen.getByText("Principles")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Four things Scholium won't do." })).toBeTruthy();
  });

  it("renders the four cards with the reference's words and an X icon each", () => {
    const { container } = render(createElement(PrinciplesSection));
    const cards = container.querySelectorAll("article.principle");
    expect(cards).toHaveLength(4);

    PRINCIPLE_CARDS.forEach(([title, body], index) => {
      const card = cards[index] as HTMLElement;
      const heading = within(card).getByRole("heading", { level: 3, name: title });
      expect(heading.querySelector("svg.ico")).not.toBeNull();
      expect(within(card).getByText(body)).toBeTruthy();
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("NameSection (#name)", () => {
  it("renders the dictionary entry: dfn, pronunciation, definition, lead", () => {
    render(createElement(NameSection));
    const section = document.getElementById("name");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-labelledby")).toBe("name-title");

    expect(screen.getByRole("heading", { level: 2, name: "scholium" })).toBeTruthy();
    const dfn = document.querySelector(".dict-word dfn");
    expect(dfn?.textContent).toBe("scholium");
    expect(dfn?.id).toBe("def-scholium");

    const pron = document.querySelector(".pron");
    expect(pron?.textContent).toBe("/ˈskoʊ·li·əm/ · noun · plural scholia");

    const definition = document.querySelector(".def");
    expect(definition?.textContent).toBe("An explanatory note written in the margin of a scholarly text.");

    expect(
      screen.getByText(
        "For more than two thousand years, readers have argued with texts in their margins. Scholium keeps that conversation next to the paragraph it is about, and signs it.",
      ),
    ).toBeTruthy();
  });

  it("places the animated brand glyph beside the entry, hidden from assistive tech", () => {
    const { container } = render(createElement(NameSection));
    const glyph = container.querySelector(".name-glyph");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");

    const parts = Array.from(glyph?.querySelectorAll("svg rect, svg path") ?? []).map((el) =>
      el.getAttribute("class"),
    );
    expect(parts).toEqual(["page", "line", "line", "line", "line", "line", "strip", "bracket"]);
  });
});

/* -------------------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));

describe("closing.css (the sections' stylesheet)", () => {
  const css = readFileSync(join(here, "closing.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("reads every colour from the tokens (no hex literal)", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("turns the FAQ plus icon 45 degrees when its details is open", () => {
    expect(css).toMatch(/\.faq details\[open\] \.pm\s*\{\s*transform: rotate\(45deg\);/);
  });

  it("labels the stacked table cells from their data-label under 720px", () => {
    expect(css).toMatch(/@media \(max-width: 720px\)/);
    expect(css).toMatch(/content: attr\(data-label\)/);
    expect(css).toMatch(/\.compare thead\s*\{\s*display: none;/);
  });

  it("animates the FAQ height only where interpolate-size is supported", () => {
    expect(css).toMatch(/@supports \(interpolate-size: allow-keywords\)/);
    expect(css).toMatch(/\.faq details\[open\]::details-content\s*\{\s*block-size: auto;/);
  });

  it("keeps the name section's definition on a margin-note rule", () => {
    expect(css).toMatch(/\.def\s*\{[^}]*border-left: 4px solid var\(--margin-note-strong\)/);
  });
});
