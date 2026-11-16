// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiErrorFrom, tokenStore } from "../../lib/api";

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

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.unstubAllGlobals();
});

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

describe("the actions on a revealed review card", () => {
  /** An unsigned JWT: the actions only read its claims. */
  function sessionToken(claims: unknown): string {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256" })}.${encode(claims)}.sig`;
  }

  const AUTHOR = "did:key:z6MkAuthor";
  const MEMBER = "did:key:z6MkMember";

  function stubByline(dids: string[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authors: dids.map((did) => ({ did })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("shows a paper author the point-by-point reply form", async () => {
    tokenStore.set({ accessToken: sessionToken({ sub: AUTHOR, tier: 2 }) });
    stubByline([AUTHOR]);

    renderTab(dataOf(review({ report: "The paper is careful." })));

    expect(await screen.findByText("Reply point by point")).toBeTruthy();
  });

  it("shows a tier-3 member the quality rating", async () => {
    tokenStore.set({ accessToken: sessionToken({ sub: MEMBER, tier: 3 }) });
    stubByline(["did:key:z6MkOther"]);

    renderTab(dataOf(review({ report: "The paper is careful." })));

    expect(await screen.findByText("Rate this review’s quality")).toBeTruthy();
  });

  it("offers nothing on a sealed review", () => {
    tokenStore.set({ accessToken: sessionToken({ sub: MEMBER, tier: 3 }) });
    const fetchMock = stubByline([]);

    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review()],
      }),
    );

    expect(screen.queryByText("Rate this review’s quality")).toBeNull();
    expect(screen.queryByText("Reply point by point")).toBeNull();
    // A sealed review is not answered or rated, so there is no byline read.
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("Update for v{latest} on a review of an earlier version", () => {
  /** An unsigned JWT: the tab only reads its claims. */
  function sessionToken(claims: unknown): string {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256" })}.${encode(claims)}.sig`;
  }

  const REVIEWER = "did:key:z6MkReviewer";
  const STRANGER = "did:key:z6MkStranger";

  /** The listing of v2 that carries a reviewer's revealed review of v1. */
  function listingOfV2(overrides: Record<string, unknown> = {}): ReviewsData {
    return parseReviews({
      paper: PAPER,
      version: 2,
      // v2 has no review committed on it yet: its reports are still sealed.
      gate_open: false,
      reviews: [
        review({
          review_cid: "bafy-commit",
          formal_cid: "bafy-formal-1",
          version: 1,
          revealed_at: "2027-03-02T05:00:00",
          ...overrides,
        }),
      ],
    });
  }

  function ownReviews(...cids: string[]) {
    return vi.fn(async () =>
      cids.map((reviewCid) => ({
        reviewCid,
        paper: PAPER,
        versionCid: "bafy-v1",
        sealed: false,
      })),
    );
  }

  function signIn(did: string): void {
    tokenStore.set({ accessToken: sessionToken({ sub: did, tier: 3 }) });
  }

  it("offers the signed-in reviewer an update, though v2's reports are still sealed", async () => {
    signIn(REVIEWER);
    const loadOwnReviews = ownReviews("bafy-commit");

    renderTab(listingOfV2(), { loadOwnReviews });

    const link = await screen.findByRole("link", { name: "Update for v2" });
    // The review they stand on is the one the update revises.
    expect(link.getAttribute("href")).toBe(
      `/review/${encodeURIComponent("k3f9-q2xz-7mwd")}?prev=bafy-formal-1`,
    );
    expect(loadOwnReviews).toHaveBeenCalledTimes(1);
  });

  it("says which version the review is of", async () => {
    renderTab(listingOfV2());

    expect(screen.getByText(/Review of v1/)).toBeTruthy();
  });

  it("offers nobody else an update, whoever they are", async () => {
    signIn(STRANGER);
    const loadOwnReviews = ownReviews("bafy-someone-elses");

    renderTab(listingOfV2(), { loadOwnReviews });

    await waitFor(() => expect(loadOwnReviews).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
  });

  it("offers a signed-out reader nothing and asks the API nothing", () => {
    const loadOwnReviews = ownReviews("bafy-commit");

    renderTab(listingOfV2(), { loadOwnReviews });

    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("offers nothing when the reviewer's own reviews cannot be read", async () => {
    signIn(REVIEWER);
    const loadOwnReviews = vi.fn(async () => {
      throw new Error("offline");
    });

    renderTab(listingOfV2(), { loadOwnReviews });

    await waitFor(() => expect(loadOwnReviews).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
    // The reviews themselves are still there.
    expect(screen.getByRole("heading", { name: "Reviewer A" })).toBeTruthy();
  });

  it("offers nothing on a review of the version being listed", () => {
    signIn(REVIEWER);
    const loadOwnReviews = ownReviews("bafy-commit");

    renderTab(listingOfV2({ version: 2 }), { loadOwnReviews });

    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
    expect(screen.queryByText(/Review of v/)).toBeNull();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("offers nothing on a review that is still sealed", () => {
    signIn(REVIEWER);
    const loadOwnReviews = ownReviews("bafy-commit");

    renderTab(listingOfV2({ revealed_at: null, scores: {} }), { loadOwnReviews });

    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("needs no question when the review was signed with the viewer's name", async () => {
    signIn(REVIEWER);
    const loadOwnReviews = ownReviews();

    renderTab(listingOfV2({ signed_by: REVIEWER }), { loadOwnReviews });

    expect(await screen.findByRole("link", { name: "Update for v2" })).toBeTruthy();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("does not offer the update of a review signed with someone else's name", async () => {
    signIn(REVIEWER);
    const loadOwnReviews = ownReviews("bafy-commit");

    renderTab(listingOfV2({ signed_by: STRANGER }), { loadOwnReviews });

    expect(screen.queryByRole("link", { name: /Update for/ })).toBeNull();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("offers the update from the review's own date even when the report is served", async () => {
    signIn(REVIEWER);
    const data = parseReviews({
      paper: PAPER,
      version: 2,
      gate_open: true,
      reviews: [
        review({
          review_cid: "bafy-commit",
          formal_cid: "bafy-formal-1",
          version: 1,
          revealed_at: "2027-03-02T05:00:00",
          report: "A careful report.",
        }),
      ],
    });

    renderTab(data, { loadOwnReviews: ownReviews("bafy-commit") });

    expect(await screen.findByRole("link", { name: "Update for v2" })).toBeTruthy();
    expect(screen.getByText("Read the report")).toBeTruthy();
  });
});
