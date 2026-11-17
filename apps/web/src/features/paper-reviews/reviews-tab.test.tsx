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

  it("shows a revealed review without a written report as revealed, not sealed", () => {
    renderTab(
      dataOf(review({ revealed_at: "2027-03-02T05:00:00" })),
    );

    expect(screen.getByText("Minor revisions")).toBeTruthy();
    expect(screen.getByText("4 of 5")).toBeTruthy();
    expect(screen.getByText(/No written report/)).toBeTruthy();
    expect(screen.queryByText(/has not been revealed yet/)).toBeNull();
    expect(screen.queryByText(/Report sealed/)).toBeNull();
  });

  it("shows the reviewer's justification for every rubric score", () => {
    const { container } = renderTab(
      dataOf(review({ revealed_at: "2027-03-02T05:00:00" })),
    );

    const rubric = container.querySelector(".pr-rubric") as HTMLElement;
    expect(within(rubric).getByText("The design is sound.")).toBeTruthy();
    expect(within(rubric).getByText("One claim is unsupported.")).toBeTruthy();
  });

  it("marks a revised review and lists its earlier recommendations by version and date", () => {
    const { container } = renderTab(
      dataOf(
        review({
          revealed_at: "2027-04-01T00:00:00",
          recommendation: "sound_as_is",
          history: [
            {
              formal_cid: "bafy-formal-1",
              version: 1,
              revealed_at: "2027-03-02T05:00:00",
              recommendation: "minor_revisions",
            },
            {
              formal_cid: "bafy-formal-2",
              version: 2,
              revealed_at: "2027-04-01T00:00:00",
              recommendation: "sound_as_is",
            },
          ],
        }),
      ),
    );

    expect(screen.getByText("Revised")).toBeTruthy();
    const details = container.querySelector("details.pr-history");
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText(/Earlier revisions/)).toBeTruthy();
    expect(within(details as HTMLElement).getByText("Minor revisions")).toBeTruthy();
    expect(within(details as HTMLElement).getByText(/v1 · 2 Mar 2027/)).toBeTruthy();
  });

  it("does not label a revealed review of an earlier version as sealed", () => {
    const { container } = renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        // v2 has no review of its own: its reports are still sealed.
        gate_open: false,
        reviews: [
          review({
            label: "Reviewer A",
            version: 1,
            revealed_at: "2027-03-02T05:00:00",
          }),
        ],
      }),
    );

    const card = container.querySelector(".pr-card") as HTMLElement;
    expect(within(card).queryByText(/sealed/i)).toBeNull();
    expect(within(card).queryByText(/has not been revealed yet/i)).toBeNull();
    expect(within(card).getByText(/No written report/)).toBeTruthy();
  });

  it("says how many reviews are committed when the gate is shut, and never claims a sealed rubric is public", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review({ revealed_at: null, scores: null })],
      }),
    );

    expect(
      screen.getByText(/1 review has been committed on this version so far/),
    ).toBeTruthy();
    expect(screen.queryByText(/The rubric scores are already public/)).toBeNull();
    expect(screen.getByText(/The rubric is sealed with the review/)).toBeTruthy();
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

describe("the Report action on a review card", () => {
  it("is offered on every revealed review, even when it has no written report", () => {
    renderTab(dataOf(review({ revealed_at: "2027-03-02T05:00:00" })));

    expect(screen.getByRole("button", { name: "Report" })).toBeTruthy();
  });

  it("is absent while the review is sealed", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review({ revealed_at: null, scores: null })],
      }),
    );

    expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
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

describe("author responses, as GET /papers/{id}/reviews serves them", () => {
  // One entry of ``responses``: the only field that carries an answer.
  const served = {
    response_cid: "bafyrei-resp",
    responseCid: "bafyrei-resp",
    cid: "bafyrei-resp",
    id: "bafyrei-resp",
    review_cid: "bafyrei-a",
    reviewCid: "bafyrei-a",
    replies: {
      soundness: "Section 3.2 names the baseline.",
      evidence: "Table 4 now reports the seeds.",
    },
    author: "did:key:z6MkAuthor",
    created: "2027-03-05T10:00:00",
    created_at: "2027-03-05T10:00:00",
  };

  it("draws the answer once, as a formatted reply with its date, never as a field dump", () => {
    const { container } = renderTab(dataOf(review({ responses: [served] })));

    expect(container.querySelectorAll(".pr-reply")).toHaveLength(1);
    expect(screen.getAllByText("Section 3.2 names the baseline.")).toHaveLength(1);
    expect(screen.getAllByText("Table 4 now reports the seeds.")).toHaveLength(1);
    // The signer is a DID, which is not a name: the byline says "The authors".
    expect(screen.getByText("The authors · 5 Mar 2027")).toBeTruthy();
    for (const dumped of ["Response cid", "Responsecid", "Cid", "Id", "Review cid"]) {
      expect(screen.queryByText(dumped)).toBeNull();
    }
    expect(container.textContent).not.toContain("bafyrei-resp");
  });

  it("puts each answer under the review it answers", () => {
    const { container } = renderTab(
      dataOf(
        review({ responses: [served] }),
        review({ review_cid: "bafyrei-b", label: "Reviewer B" }),
      ),
    );

    const cards = container.querySelectorAll(".pr-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelectorAll(".pr-reply")).toHaveLength(1);
    expect(cards[1].querySelectorAll(".pr-reply")).toHaveLength(0);
  });
});

describe("a review carried from an earlier version, and one revised since", () => {
  const FIRST = "The first report: the evidence is thin.";
  const REVISED = "The revised report: the evidence now holds.";

  it("shows the earlier revision's report under Earlier revisions, and the latest as the card's own", () => {
    const { container } = renderTab(
      dataOf(
        review({
          revealed_at: "2027-04-01T00:00:00",
          report: REVISED,
          history: [
            {
              formal_cid: "bafy-formal-1",
              version: 1,
              revealed_at: "2027-03-02T05:00:00",
              recommendation: "major_concerns",
              report: FIRST,
            },
            {
              formal_cid: "bafy-formal-2",
              version: 2,
              revealed_at: "2027-04-01T00:00:00",
              recommendation: "minor_revisions",
              report: REVISED,
            },
          ],
        }),
      ),
    );

    const history = container.querySelector("details.pr-history") as HTMLElement;
    expect(within(history).getByText(FIRST)).toBeTruthy();
    expect(within(history).queryByText(REVISED)).toBeNull();
    expect(screen.getAllByText(REVISED)).toHaveLength(1);
  });

  it("says an update's report is sealed, not that there is none, while its version's gate is shut", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review({ version: 2, revealed_at: "2027-04-01T00:00:00" })],
      }),
    );

    expect(screen.queryByText(/No written report/)).toBeNull();
    expect(screen.getByText(/Updated report sealed until 2 reviews are committed/)).toBeTruthy();
  });

  it("describes the reviews on this version, and says plainly that the earlier ones shown are revealed", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [
          review({ version: 1, revealed_at: "2027-03-02T05:00:00", report: FIRST }),
        ],
      }),
    );

    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/No review has been committed on this version yet/);
    expect(note.textContent).toMatch(/already revealed/);
    expect(note.textContent).toMatch(/earlier-version/);
  });

  it("does not mention earlier reviews when none is shown", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review({ version: 2, revealed_at: null, scores: null })],
      }),
    );

    expect(screen.getByRole("note").textContent).not.toMatch(/already revealed/);
  });
});

describe("the listing of a newer version once a review is updated to it", () => {
  /**
   * v2's gate is shut (one commit on it), yet the reviewer's update to v2 is
   * revealed: its rubric and recommendation are public, its report is not
   * served until the gate opens (REV-4).
   */
  function updatedListing(overrides: Record<string, unknown> = {}): ReviewsData {
    return parseReviews({
      paper: PAPER,
      version: 2,
      gate_open: false,
      reviews: [
        review({
          version: 2,
          committed_at: "2027-03-02T04:00:00",
          revealed_at: "2027-04-01T00:00:00",
          history: [
            {
              formal_cid: "bafy-formal-1",
              version: 1,
              revealed_at: "2027-03-02T05:00:00",
              recommendation: "minor_revisions",
              scores: { soundness: { score: 3 } },
            },
            {
              formal_cid: "bafy-formal-2",
              version: 2,
              revealed_at: "2027-04-01T00:00:00",
              recommendation: "minor_revisions",
              scores: { soundness: { score: 4 } },
            },
          ],
          ...overrides,
        }),
      ],
    });
  }

  it("states the count on this version and that only the written reports are waiting", () => {
    renderTab(updatedListing());

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toContain(
      "1 review committed on this version; its written report unseals once 2 are committed, or on 23 Mar 2027.",
    );
  });

  it("counts the reviews on this version beside the earlier reviews it carries", () => {
    // The bug's listing: one reviewer has updated to v2 (revealed, its report
    // sealed), and a reviewer who has not yet updated is carried from v1
    // (revealed). The note must describe each group for what it is: it is not
    // true that the reviews shown below are all from an earlier version.
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [
          review({
            review_cid: "bafy-updated",
            label: "Reviewer A",
            version: 2,
            committed_at: "2027-03-02T04:00:00",
            revealed_at: "2027-04-01T00:00:00",
          }),
          review({
            review_cid: "bafy-earlier",
            label: "Reviewer B",
            version: 1,
            committed_at: "2027-02-01T00:00:00",
            revealed_at: "2027-02-02T00:00:00",
            report: "An earlier report.",
          }),
        ],
      }),
    );

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toContain("1 review committed on this version;");
    expect(note).toContain(
      "its written report unseals once 2 are committed, or on 23 Mar 2027.",
    );
    expect(note).toContain("1 earlier-version review below is already revealed.");
    expect(note).not.toContain("The reviews shown below are from an earlier version");
  });

  it("does not say the review is yet to be revealed while its card shows the scores", () => {
    renderTab(updatedListing());

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).not.toMatch(/The review is revealed/);
    expect(note).not.toMatch(/once one more independent review/);
    expect(note).not.toMatch(/with its rubric and report/);
    // The card it describes does show the rubric.
    expect(screen.getByText("4 of 5")).toBeTruthy();
    expect(screen.getByText("Minor revisions", { selector: ".pr-recommendation span" })).toBeTruthy();
  });

  it("names the date from the first commit counted on this version", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [
          review({ review_cid: "bafy-b", label: "Reviewer B", version: 2, committed_at: "2027-03-10T00:00:00", revealed_at: "2027-04-01T00:00:00" }),
          review({ review_cid: "bafy-a", version: 2, committed_at: "2027-03-05T23:30:00", revealed_at: "2027-04-02T00:00:00" }),
          // An earlier version's review is carried, not counted.
          review({ review_cid: "bafy-c", label: "Reviewer C", version: 1, committed_at: "2027-01-01T00:00:00", revealed_at: "2027-01-05T00:00:00" }),
        ],
      }),
    );

    expect(screen.getByRole("note").textContent).toContain("or on 26 Mar 2027.");
  });

  it("says an updated report is sealed, and until when, on the card", () => {
    renderTab(updatedListing());

    expect(
      screen.getByText("Updated report sealed until 2 reviews are committed on this version, or on 23 Mar 2027."),
    ).toBeTruthy();
    expect(screen.queryByText(/No written report/)).toBeNull();
  });

  it("still keeps the updated report out of the card (REV-4 is unchanged)", () => {
    const { container } = renderTab(updatedListing());

    expect(container.querySelector("details.pr-report")).toBeNull();
    expect(screen.queryByText("Read the report")).toBeNull();
  });

  it("has no date to name until a review is committed on this version, and says so", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        // Only v1's review is carried; the earlier commit date is not v2's clock.
        reviews: [review({ version: 1, committed_at: "2027-01-01T00:00:00", revealed_at: "2027-01-05T00:00:00" })],
      }),
    );

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toContain("No review has been committed on this version yet.");
    expect(note).toContain("Scores are public.");
    expect(note).toContain("or 21 days after the first commit.");
    expect(note).not.toMatch(/Jan 2027|Feb 2027/);
  });

  it("does not claim scores are public when the listing carries a sealed review", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [review({ revealed_at: null, scores: null })],
      }),
    );

    expect(screen.getByRole("note").textContent).not.toMatch(/Scores are public/);
  });

  it("tells a mixed listing which rubrics are public and which are not", () => {
    renderTab(
      parseReviews({
        paper: PAPER,
        version: 2,
        gate_open: false,
        reviews: [
          review({ version: 2, revealed_at: "2027-04-01T00:00:00" }),
          review({ review_cid: "bafy-b", label: "Reviewer B", version: 2, revealed_at: null, scores: null }),
        ],
      }),
    );

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toMatch(/Scores are public on the revealed reviews/);
    expect(note).toMatch(/still sealed/);
    expect(note).not.toMatch(/The review is revealed/);
  });
});

describe("a report written in Markdown", () => {
  const REPORT = "**Summary:** the method is *sound*.\n\n- clear claims\n- thin evidence\n\nSee [the data](https://example.org/d) and `run.sh`.";

  it("is rendered, not shown with its asterisks", () => {
    const { container } = renderTab(dataOf(review({ report: REPORT })));

    const body = container.querySelector(".pr-report__body") as HTMLElement;
    expect(body.textContent).not.toContain("**");
    expect(body.querySelector("strong")?.textContent).toBe("Summary:");
    expect(body.querySelector("em")?.textContent).toBe("sound");
    expect(Array.from(body.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "clear claims",
      "thin evidence",
    ]);
    expect(body.querySelector("code")?.textContent).toBe("run.sh");
    const link = body.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.org/d");
    expect(link.getAttribute("rel")).toBe("nofollow noopener");
  });

  it("renders an earlier revision's report the same way", () => {
    const { container } = renderTab(
      dataOf(
        review({
          report: "The revised report.",
          history: [
            { formal_cid: "bafy-1", version: 1, revealed_at: "2027-03-02T05:00:00", recommendation: "minor_revisions", report: "**Thin** first draft." },
            { formal_cid: "bafy-2", version: 2, revealed_at: "2027-04-01T00:00:00", recommendation: "minor_revisions", report: "The revised report." },
          ],
        }),
      ),
    );

    const history = container.querySelector("details.pr-history") as HTMLElement;
    expect(history.querySelector("strong")?.textContent).toBe("Thin");
    expect(history.textContent).not.toContain("**");
  });

  it("never turns a report's HTML into elements", () => {
    const { container } = renderTab(
      dataOf(review({ report: '<img src=x onerror="alert(1)"> and [x](javascript:alert(1))' })),
    );

    const body = container.querySelector(".pr-report__body") as HTMLElement;
    expect(body.querySelector("img, a, script")).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("reporting a revealed review", () => {
  function signedIn(): void {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    tokenStore.set({
      accessToken: `${encode({ alg: "HS256" })}.${encode({ sub: "did:key:z6MkMember", tier: 1 })}.sig`,
    });
  }

  function stubFlags(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "flag-1", authors: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** The `target` of every flag the tab filed. */
  function flagged(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/flags"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).target as string);
  }

  const revealed = review({
    review_cid: "bafy-commit",
    formal_cid: "bafy-formal-1",
    revealed_at: "2027-03-02T05:00:00",
  });

  it("asks about the review by the reviewer, not the post", () => {
    signedIn();
    stubFlags();
    renderTab(dataOf(revealed));

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(
      screen.getByRole("group", { name: "Why are you reporting the review by Reviewer A?" }),
    ).toBeTruthy();
  });

  it("files the flag against the revealed review record, not the sealed commit", async () => {
    signedIn();
    const fetchMock = stubFlags();
    renderTab(dataOf(revealed));

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    fireEvent.click(screen.getByRole("radio", { name: /Spam or advertising/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await screen.findByText("Reported");
    expect(flagged(fetchMock)).toEqual(["bafy-formal-1"]);
  });
});
