// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { parseConflictReport } from "./conflict";
import type { ReviewPaper } from "./paper";
import { ReviewPage } from "./review-page";

afterEach(cleanup);

const PAPER: ReviewPaper = {
  shortId: "sch:6sel-2dio-orm6",
  versionCid: "bafyversion",
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study how a meta-agent picks between branches.",
  categories: ["cs.AI"],
  paragraphs: [{ id: "aaaa", text: "Multi-agent systems delegate choices." }],
};

const REPORT = parseConflictReport({
  paper: "sch:6sel-2dio-orm6",
  clear: true,
  checks: [
    {
      id: "not_author",
      label: "Not an author of this paper",
      status: "pass",
      passed: true,
      detail: "You are not an author of this paper.",
    },
    {
      id: "no_recent_coauthorship",
      label: "No co-authorship with any author in the last 3 years",
      status: "pass",
      passed: true,
      detail: "You share no byline with any author in the last 3 years.",
    },
    {
      id: "different_institution",
      label: "Different institution from all authors",
      status: "pass",
      passed: true,
      detail: "Your affiliation differs from every author's on file.",
    },
  ],
});

describe("ReviewPage conflict check", () => {
  it("shows the conflict check results before the form", () => {
    const { container } = render(<ReviewPage paper={PAPER} conflict={REPORT} />);

    const side = container.querySelector(".rf-side") as HTMLElement;
    const conflict = within(side).getByRole("heading", {
      name: "Conflict check",
    });
    const form = within(side).getByRole("form", { name: "Your review" });

    expect(
      conflict.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The results are visible, with words, beside their icons.
    expect(within(side).getByText("Not an author of this paper")).toBeTruthy();
    expect(within(side).getAllByText("Passed")).toHaveLength(3);
  });

  it("shows the conflict check above the form even when it could not run", () => {
    render(
      <ReviewPage
        paper={PAPER}
        conflictError="The conflict check could not be run."
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Conflict check" }),
    ).toBeTruthy();
    expect(screen.getByRole("form", { name: "Your review" })).toBeTruthy();
  });

  it("offers the commit action beside the checks", () => {
    render(<ReviewPage paper={PAPER} conflict={REPORT} />);

    expect(screen.getByRole("button", { name: "Commit review" })).toBeTruthy();
  });
});
