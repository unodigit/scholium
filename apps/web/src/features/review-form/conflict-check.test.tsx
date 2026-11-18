// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictCheck, conflictSignInHref } from "./conflict-check";
import { parseConflictReport } from "./conflict";
import { ReviewSessionProvider, useReviewSession, type OwnReviewState } from "./review-session";

afterEach(cleanup);

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
      status: "unknown",
      passed: false,
      detail: "Save an affiliation on your profile so the node can compare it.",
    },
  ],
});

describe("ConflictCheck", () => {
  it("words a conflict as committed once the reviewer already has a review", () => {
    const conflict = parseConflictReport({
      paper: "sch:6sel-2dio-orm6",
      clear: false,
      checks: [
        {
          id: "not_author",
          label: "Not an author of this paper",
          status: "pass",
          passed: true,
          detail: "You are not an author of this paper.",
        },
        {
          id: "different_institution",
          label: "Different institution from all authors",
          status: "fail",
          passed: false,
          detail: "Your affiliation matches an author of this paper.",
        },
      ],
    });

    render(
      <ReviewSessionProvider>
        <ConflictCheck paperId="sch:6sel-2dio-orm6" initial={conflict} />
        <ReportsOwnReview state="sealed" />
      </ReviewSessionProvider>,
    );

    expect(
      screen.getByText(/Committed despite a declared affiliation overlap/),
    ).toBeTruthy();
    expect(screen.queryByText(/decides whether it can be committed/)).toBeNull();
  });

  it("shows the design's heading and every check with a word, not colour alone", () => {
    render(<ConflictCheck paperId="sch:6sel-2dio-orm6" initial={REPORT} />);

    expect(
      screen.getByRole("heading", { name: "Conflict check" }),
    ).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(within(rows[0]).getByText("Passed")).toBeTruthy();
    expect(within(rows[0]).getByText("Not an author of this paper")).toBeTruthy();
    expect(within(rows[2]).getByText("Couldn’t check")).toBeTruthy();
    // The status word is visible text; the icon is decorative.
    expect(rows[0].querySelector("svg")).toBeTruthy();
  });

  it("summarises the outcome before the list", () => {
    render(<ConflictCheck paperId="sch:6sel-2dio-orm6" initial={REPORT} />);

    const summary = screen.getByText(/One check could not be completed/);
    const list = screen.getByRole("list", { name: "Conflict checks" });
    expect(
      summary.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks a signed-out visitor to sign in instead of loading", async () => {
    const load = vi.fn();
    render(
      <ConflictCheck paperId="sch:6sel-2dio-orm6" signedIn={false} load={load} />,
    );

    expect(screen.getByText(/Sign in to check for conflicts/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe(
      conflictSignInHref("sch:6sel-2dio-orm6"),
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the checks once signed in", async () => {
    const load = vi.fn(async () => REPORT);
    render(
      <ConflictCheck paperId="sch:6sel-2dio-orm6" signedIn load={load} />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Checking for conflicts…",
    );
    expect(await screen.findByText("Not an author of this paper")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the form usable when the check fails, and offers a retry", async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("The node is offline.");
      return REPORT;
    });

    render(
      <ConflictCheck paperId="sch:6sel-2dio-orm6" signedIn load={load} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The node is offline.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Not an author of this paper")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows a server-reported failure until the reviewer retries", () => {
    const load = vi.fn(async () => REPORT);
    render(
      <ConflictCheck
        paperId="sch:6sel-2dio-orm6"
        signedIn
        initialError="Could not run the check."
        load={load}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Could not run the check.",
    );
    expect(load).not.toHaveBeenCalled();
  });
});

/**
 * Stands in for the review form, which reports to the shared session that the
 * reviewer already has a review (sealed or revealed).
 */
function ReportsOwnReview({ state }: { state: OwnReviewState }) {
  const session = useReviewSession();
  useEffect(() => {
    session?.setOwnReviewState(state);
  }, [session, state]);
  return null;
}
