import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FAQ_ENTRIES } from "./faq";
// The data file owns the bare "./faq" specifier (.ts resolves before .tsx),
// so the section module is importable only through its explicit extension.
// The ts-expect-error silences TS5097, which fires exactly because the two
// files share the basename on purpose: questions and answers in faq.ts (the
// plain data structured data reuses), the section in faq.tsx.
// @ts-expect-error "./faq.tsx" needs its extension to be importable at all
import { FaqSection } from "./faq.tsx";

afterEach(cleanup);

/* The reference's eleven "at a glance" facts (docs/homepage/index.html, #faq). */
const GLANCE_FACTS = [
  ["What it is", "A preprint and open peer-review network"],
  ["Cost", "Free to read and to publish"],
  ["Licence", "CC BY 4.0 by default"],
  ["Identifiers", "sch:xxxx-xxxx-xxxx/vN"],
  ["Sign-in", "Passkey and ORCID iD"],
  ["Review", "Six-criterion rubric; anonymous but accountable"],
  ["AI", "Advisory pre-review, never a verdict"],
  ["Verification", "In the browser, or offline with scholium verify"],
  ["Moderation", "Public policy, signed decisions, 48-hour target"],
  ["Recovery", "Three of five guardians"],
  ["Token", "None"],
] as const;

describe("faq.ts (the data)", () => {
  it("holds the reference's eleven questions and answers as plain data", () => {
    expect(FAQ_ENTRIES).toHaveLength(11);
    expect(new Set(FAQ_ENTRIES.map((entry) => entry.question)).size).toBe(11);
    for (const entry of FAQ_ENTRIES) {
      expect(entry.question).toMatch(/\?\s*$/);
      expect(entry.answer.length).toBeGreaterThan(0);
    }
  });

  it("matches the questions the reference lists", () => {
    expect(FAQ_ENTRIES.map((entry) => entry.question)).toEqual([
      "What is Scholium?",
      "How is Scholium different from arXiv?",
      "Is Scholium free?",
      "How does Scholium prove who wrote a paper?",
      "Can reviewers stay anonymous?",
      "What is the AI pre-review?",
      "Does Scholium use a blockchain or a cryptocurrency?",
      "What happens if I lose my device?",
      "Who decides what gets listed?",
      "Can I take my papers elsewhere?",
      "What does the name mean?",
    ]);
  });
});

describe("FaqSection (#faq)", () => {
  it("renders the section with the reference's eyebrow and title", () => {
    render(createElement(FaqSection));
    const section = document.getElementById("faq");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-labelledby")).toBe("faq-title");

    expect(screen.getByText("Questions")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Questions, answered." })).toBeTruthy();
  });

  it("renders the at a glance card as a definition list of the reference's eleven facts", () => {
    const { container } = render(createElement(FaqSection));
    const glance = container.querySelector(".glance");
    expect(glance?.tagName).toBe("ASIDE");
    expect(within(glance as HTMLElement).getByRole("heading", { level: 3, name: "Scholium at a glance" })).toBeTruthy();

    const pairs = Array.from(glance?.querySelectorAll("dl > div") ?? []).map(
      (row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent] as const,
    );
    expect(pairs).toEqual(GLANCE_FACTS.map(([term, details]) => [term, details]));
  });

  it("renders every question as an h3 inside its summary, with the plus icon", () => {
    const { container } = render(createElement(FaqSection));
    const items = container.querySelectorAll("details");
    expect(items).toHaveLength(11);

    FAQ_ENTRIES.forEach((entry, index) => {
      const details = items[index] as HTMLElement;
      const summary = details.querySelector("summary");
      expect(summary).not.toBeNull();

      const heading = within(summary as HTMLElement).getByRole("heading", { level: 3, name: entry.question });
      expect(heading.tagName.toLowerCase()).toBe("h3");

      const plus = summary?.querySelector(".pm");
      expect(plus?.getAttribute("aria-hidden")).toBe("true");
      expect(plus?.querySelector("svg.ico")).not.toBeNull();
    });
  });

  it("renders every answer in the server-rendered document", () => {
    render(createElement(FaqSection));
    for (const { answer } of FAQ_ENTRIES) {
      expect(screen.getByText(answer)).toBeTruthy();
    }
  });

  it("keeps each answer inside its own details element", () => {
    const { container } = render(createElement(FaqSection));
    const items = Array.from(container.querySelectorAll("details"));
    FAQ_ENTRIES.forEach((entry, index) => {
      expect(within(items[index] as HTMLElement).getByText(entry.answer)).toBeTruthy();
    });
  });
});
