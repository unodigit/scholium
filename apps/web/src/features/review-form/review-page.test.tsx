// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ANONYMITY_DETAIL, ANONYMITY_HEADLINE } from "./anonymity-notice";
import type { PaperFailure, ReviewPaper } from "./paper";
import { PaperPane } from "./paper-pane";
import { ReviewNotice, ReviewPage } from "./review-page";

afterEach(cleanup);

const PAPER: ReviewPaper = {
  shortId: "sch:6sel-2dio-orm6",
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study how a meta-agent picks between branches.",
  categories: ["cs.AI", "cs.CR"],
  paragraphs: [
    { id: "aaaa", text: "Multi-agent systems increasingly delegate choices." },
    { id: "bbbb", text: "We define a safety score for each branch." },
  ],
};

describe("ReviewPage", () => {
  it("titles the page with the paper and its version", () => {
    render(<ReviewPage paper={PAPER} />);

    expect(
      screen.getByRole("heading", { level: 1 }).textContent,
    ).toBe("Reviewing: Can a Meta-Agent Choose the Safer Branch? · v2");
  });

  it("puts the paper on the left and the form on the right", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);

    const split = container.querySelector(".rf-split");
    const [left, right] = Array.from(split?.children ?? []);

    // DOM order is column order in the two-column grid, and reading order on a phone.
    expect(left.matches(".rf-paper")).toBe(true);
    expect(right.matches(".rf-side")).toBe(true);
    expect(within(left as HTMLElement).getByText(PAPER.abstract)).toBeTruthy();
    expect(
      within(right as HTMLElement).getByRole("form", { name: "Your review" }),
    ).toBeTruthy();
    expect(
      within(left as HTMLElement).queryByRole("form"),
    ).toBeNull();
  });

  it("shows the anonymity notice above the form, in the design's words", () => {
    const { container } = render(<ReviewPage paper={PAPER} />);

    const notice = screen.getByRole("note", { name: "Anonymity" });
    expect(notice.textContent).toBe(`${ANONYMITY_HEADLINE} ${ANONYMITY_DETAIL}`);
    expect(notice.textContent).toBe(
      "You are reviewing anonymously. Your identity is hidden from authors, " +
        "readers and this node. It can be opened only by 3 of 5 integrity " +
        "committee members in a misconduct case.",
    );

    const side = container.querySelector(".rf-side") as HTMLElement;
    const form = within(side).getByRole("form");
    expect(
      notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the rubric form: six scored dimensions, confidence, recommendation and the AI declaration", () => {
    render(<ReviewPage paper={PAPER} />);

    expect(screen.getAllByRole("radio", { name: /^[1-5] of 5$/ })).toHaveLength(30);
    expect(screen.getAllByRole("textbox", { name: /Justification/ })).toHaveLength(6);
    expect(screen.getByRole("group", { name: "Confidence" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Recommendation" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /I used AI assistance in writing this review/ }),
    ).toBeTruthy();
  });

  it("has exactly one h1", () => {
    render(<ReviewPage paper={PAPER} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("PaperPane", () => {
  it("shows the id, version and categories", () => {
    render(<PaperPane paper={PAPER} />);

    expect(screen.getByText("sch:6sel-2dio-orm6")).toBeTruthy();
    expect(screen.getByText("Version 2")).toBeTruthy();
    expect(screen.getByText("cs.AI, cs.CR")).toBeTruthy();
  });

  it("shows the abstract, then the text, paragraph by paragraph and in order", () => {
    const { container } = render(<PaperPane paper={PAPER} />);

    expect(screen.getByRole("heading", { name: "Abstract" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Full text" })).toBeTruthy();

    const paragraphs = Array.from(
      container.querySelectorAll<HTMLElement>("[data-paragraph-id]"),
    );
    expect(paragraphs.map((node) => node.textContent)).toEqual([
      "Multi-agent systems increasingly delegate choices.",
      "We define a safety score for each branch.",
    ]);
  });

  it("marks each paragraph with its stable id, which a citation will name", () => {
    const { container } = render(<PaperPane paper={PAPER} />);

    expect(
      Array.from(container.querySelectorAll("[data-paragraph-id]")).map((node) =>
        node.getAttribute("data-paragraph-id"),
      ),
    ).toEqual(["aaaa", "bbbb"]);
  });

  it("shows a repeated paragraph twice rather than collapsing or crashing", () => {
    const repeated: ReviewPaper = {
      ...PAPER,
      paragraphs: [
        { id: "same", text: "Figure 1." },
        { id: "same", text: "Figure 1." },
      ],
    };

    render(<PaperPane paper={repeated} />);

    expect(screen.getAllByText("Figure 1.")).toHaveLength(2);
  });

  it("leaves out the abstract and categories a paper does not have", () => {
    render(
      <PaperPane
        paper={{ ...PAPER, abstract: "", categories: [] }}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Abstract" })).toBeNull();
    expect(screen.queryByText("cs.AI, cs.CR")).toBeNull();
  });

  it("says so, in a status, when the text could not be loaded", () => {
    render(<PaperPane paper={{ ...PAPER, paragraphs: null }} />);

    // (The id pill keeps its own, empty, status region for toasts; the note is
    // the one with words in it.)
    const note = screen.getByText(/could not be loaded/);
    expect(note.getAttribute("role")).toBe("status");
    // The abstract is still there to read.
    expect(screen.getByText(PAPER.abstract)).toBeTruthy();
  });

  it("says so when a version has no text, without calling it a failure", () => {
    render(<PaperPane paper={{ ...PAPER, paragraphs: [] }} />);

    const note = screen.getByText("This version has no text to show.");
    expect(note.getAttribute("role")).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});

describe("ReviewNotice", () => {
  const FAILED: PaperFailure = {
    kind: "failed",
    title: "Couldn’t load the paper",
    message: "Scholium could not reach the API.",
  };

  it("replaces the whole split view: no form for a paper that is not shown", () => {
    render(<ReviewPage failure={FAILED} retryHref="/review/x" />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("note", { name: "Anonymity" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("states the problem as the page's one heading", () => {
    render(<ReviewNotice failure={FAILED} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Couldn’t load the paper" }),
    ).toBeTruthy();
    expect(screen.getByText("Scholium could not reach the API.")).toBeTruthy();
  });

  it("offers Try again for a failure worth retrying", () => {
    render(<ReviewNotice failure={FAILED} retryHref="/review/sch%3Aabc" />);

    const retry = screen.getByRole("link", { name: "Try again" });
    expect(retry.getAttribute("href")).toBe("/review/sch%3Aabc");
  });

  it.each(["invalid-id", "not-found"] as const)(
    "offers no retry for %s: asking again will not change the answer",
    (kind) => {
      render(
        <ReviewNotice
          failure={{ kind, title: "No such paper", message: "Nothing here." }}
          retryHref="/review/x"
        />,
      );

      expect(screen.queryByRole("link")).toBeNull();
    },
  );
});
