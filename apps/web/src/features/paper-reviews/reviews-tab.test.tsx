// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiErrorFrom } from "../../lib/api";

import { ReviewsTab } from "./reviews-tab";
import { emptyReviews, parseReviews, type ReviewsData } from "./review";

/**
 * What the Reviews tab shows and does (docs/design.md §5.2, §7; the app
 * spec's feature: review cards with reviewer label, recommendation, rubric
 * dots with text equivalents, an expandable report and author replies, plus a
 * median-per-dimension summary bar).
 *
 * The loader is a prop, so these tests drive the tab the way the paper page
 * does, with the real parser in front of fake payloads.
 */

const PAPER = "sch:k3f9-q2xz-7mwd";

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_cid: "bafyrei-a",
    label: "Reviewer A",
    recommendation: "minor_revisions",
    confidence: 4,
    committed_at: "2027-03-02T04:00:00",
    scores: {
      soundness: { score: 4, justification: "The design is sound." },
      evidence: { score: 3, justification: "One claim is unsupported." },
    },
    ...overrides,
  };
}

function dataOf(...reviews: Array<Record<string, unknown>>): ReviewsData {
  return parseReviews({
    paper: PAPER,
    version: 2,
    gate_open: true,
    reviews,
  });
}

function renderTab(initial: ReviewsData | undefined, extra: Record<string, unknown> = {}) {
  return render(
    <ReviewsTab paperId={PAPER} initial={initial} {...extra} />,
  );
}

afterEach(cleanup);

describe("a review card", () => {
  it("shows the reviewer label, recommendation and date", () => {
    renderTab(
      dataOf(review({ report: "The paper is careful and the code runs." })),
    );

    expect(screen.getByRole("heading", { name: "Reviewer A" })).toBeTruthy();
    expect(screen.getByText("Minor revisions")).toBeTruthy();
    expect(screen.getByText(/Anonymous reviewer/)).toBeTruthy();
    expect(screen.getByText(/Reviewed 2 Mar 2027/)).toBeTruthy();
    expect(screen.getByText(/Confidence: High/)).toBeTruthy();
  });

  it("shows rubric dots and the text equivalent of every score", () => {
    const { container } = renderTab(dataOf(review()));

    const rubric = container.querySelector(".pr-rubric") as HTMLElement;
    expect(within(rubric).getByText("Soundness")).toBeTruthy();
    expect(within(rubric).getByText("4 of 5")).toBeTruthy();
    expect(within(rubric).getByText("3 of 5")).toBeTruthy();

    const rows = rubric.querySelectorAll(".pr-rubric__row");
    expect(rows).toHaveLength(2);

    // Five dots per dimension, four filled for a 4-of-5 score.
    const first = rows[0];
    expect(first.querySelectorAll(".pr-dot")).toHaveLength(5);
    expect(first.querySelectorAll(".pr-dot--on")).toHaveLength(4);
    // The dots are decorative; the words beside them carry the value.
    expect(first.querySelector(".pr-dots")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the report behind an expander, with its text in the summary", () => {
    const { container } = renderTab(
      dataOf(review({ report: "The paper is careful and the code runs." })),
    );

    const details = container.querySelector("details.pr-report");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(within(details as HTMLElement).getByText("Read the report")).toBeTruthy();
    expect(
      within(details as HTMLElement).getByText(
        "The paper is careful and the code runs.",
      ),
    ).toBeTruthy();
  });

  it("says a report is sealed instead of showing an empty expander", () => {
    const sealed = parseReviews({
      paper: PAPER,
      version: 2,
      gate_open: false,
      reviews: [review()],
    });
    const { container } = renderTab(sealed);

    expect(container.querySelector("details.pr-report")).toBeNull();
    expect(
      screen.getByText(/Report sealed until two reviews are committed/),
    ).toBeTruthy();
    expect(screen.getByText("reports sealed", { exact: false })).toBeTruthy();
  });

  it("shows author replies point by point", () => {
    const { container } = renderTab(
      dataOf(
        review({
          report: "…",
          responses: [
            {
              reply_cid: "bafyrei-reply",
              author_name: "Mei Zhang",
              version: 2,
              created_at: "2027-03-05T10:00:00",
              items: [
                { dimension: "soundness", text: "Section 3.2 names the baseline." },
                { dimension: "evidence", text: "Table 4 now reports the seeds." },
              ],
            },
          ],
        }),
      ),
    );

    expect(screen.getByRole("heading", { name: "Author reply" })).toBeTruthy();
    expect(screen.getByText(/Mei Zhang · v2 · 5 Mar 2027/)).toBeTruthy();
    expect(screen.getByText("Section 3.2 names the baseline.")).toBeTruthy();
    expect(screen.getByText("Table 4 now reports the seeds.")).toBeTruthy();

    // The dimension label lives beside the answer it belongs to, not only in
    // the rubric above it.
    const replies = container.querySelector(".pr-replies") as HTMLElement;
    expect(within(replies).getAllByText("Soundness")).toHaveLength(1);
    expect(within(replies).getAllByText("Evidence")).toHaveLength(1);
  });
});

describe("the median summary bar", () => {
  it("shows the median per dimension, half points included", () => {
    const data = dataOf(
      review({ review_cid: "a", label: "Reviewer A" }),
      review({
        review_cid: "b",
        label: "Reviewer B",
        scores: {
          soundness: { score: 3 },
          evidence: { score: 4 },
        },
      }),
    );
    const { container } = renderTab(data);

    const summary = container.querySelector(".pr-summary");
    expect(summary).not.toBeNull();
    expect(within(summary as HTMLElement).getByText("Median scores")).toBeTruthy();
    // (4 + 3) / 2 = 3.5 for both dimensions.
    expect(within(summary as HTMLElement).getAllByText("3.5 of 5")).toHaveLength(2);

    const rows = summary?.querySelectorAll(".pr-summary__row");
    expect(rows).toHaveLength(2);
    // 3.5 / 5 = 70% of the meter.
    expect(
      (rows?.[0].querySelector(".pr-meter__fill") as HTMLElement).style.width,
    ).toBe("70%");
  });

  it("is absent when no review served a score", () => {
    const { container } = renderTab(
      dataOf(review({ scores: null, report: "…" })),
    );
    expect(container.querySelector(".pr-summary")).toBeNull();
  });
});

describe("states", () => {
  it("invites a review when there are none", () => {
    renderTab(emptyReviews(PAPER));

    expect(screen.getByText(/No reviews yet/)).toBeTruthy();
    const action = screen.getByRole("link", { name: "Review this paper" });
    expect(action.getAttribute("href")).toBe("/review/k3f9-q2xz-7mwd");
  });

  it("uses the server's answer on the first paint and does not fetch again", () => {
    const load = vi.fn(async () => dataOf(review()));
    renderTab(dataOf(review()), { load });

    expect(screen.getByRole("heading", { name: "Reviewer A" })).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  it("offers a retry after a failed load, then shows the reviews", async () => {
    const load = vi
      .fn<() => Promise<ReviewsData>>()
      .mockRejectedValueOnce(apiErrorFrom(503, { detail: "The ledger is busy." }))
      .mockResolvedValueOnce(dataOf(review()));

    render(<ReviewsTab paperId={PAPER} load={load} />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The ledger is busy.")).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Reviewer A" })).toBeTruthy(),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows a retryable failure the server reported, without a second fetch", () => {
    const load = vi.fn(async () => dataOf(review()));
    render(
      <ReviewsTab
        paperId={PAPER}
        initialError="The API is down."
        load={load}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("The API is down.");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads on its own when the page passes no initial data", async () => {
    const load = vi.fn(async () => dataOf(review()));
    render(<ReviewsTab paperId={PAPER} load={load} />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Reviewer A" })).toBeTruthy(),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });
});
