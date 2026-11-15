// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { DashboardPage, MeDashboardPage, MePage } from "./dashboard-page";
import type { DashboardData } from "./dashboard";

/** A parsed `GET /v1/me/dashboard` body with one item in every card. */
const DATA: DashboardData = {
  did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  needs_attention: {
    count: 2,
    consents_to_sign: [
      {
        kind: "consent_to_sign",
        summary: "Sign your co-author consent for sch:k3f9-q2xz-7mwd",
        reason: null,
        paper: "sch:k3f9-q2xz-7mwd",
        shortId: "sch:k3f9-q2xz-7mwd",
        paperCid: "bafy-genesis-1",
        version: 1,
        versionCid: "bafy-version-1",
        version_cid: "bafy-version-1",
        title: "Sparse attention without the quadratic cost",
        link: "/consent/bafy-version-1",
        createdAt: "2026-11-10T09:00:00Z",
      },
    ],
    review_invitations: [
      {
        kind: "review_invitation",
        summary: "Review sch:abcd-efgh-jklm",
        reason: null,
        paper: "sch:abcd-efgh-jklm",
        shortId: "sch:abcd-efgh-jklm",
        paperCid: "bafy-genesis-2",
        version: 2,
        versionCid: "bafy-version-2",
        version_cid: "bafy-version-2",
        title: "A tidy proof of a small lemma",
        link: "/review/sch:abcd-efgh-jklm",
        createdAt: null,
      },
    ],
    author_replies: [],
    moderation_outcomes: [],
    items: [
      {
        kind: "consent_to_sign",
        summary: "Sign your co-author consent for sch:k3f9-q2xz-7mwd",
        reason: null,
        paper: "sch:k3f9-q2xz-7mwd",
        shortId: "sch:k3f9-q2xz-7mwd",
        paperCid: "bafy-genesis-1",
        version: 1,
        versionCid: "bafy-version-1",
        version_cid: "bafy-version-1",
        title: "Sparse attention without the quadratic cost",
        link: "/consent/bafy-version-1",
        createdAt: "2026-11-10T09:00:00Z",
      },
      {
        kind: "review_invitation",
        summary: "Review sch:abcd-efgh-jklm",
        reason: null,
        paper: "sch:abcd-efgh-jklm",
        shortId: "sch:abcd-efgh-jklm",
        paperCid: "bafy-genesis-2",
        version: 2,
        versionCid: "bafy-version-2",
        version_cid: "bafy-version-2",
        title: "A tidy proof of a small lemma",
        link: "/review/sch:abcd-efgh-jklm",
        createdAt: null,
      },
    ],
  },
  my_papers: [
    {
      paper: "sch:k3f9-q2xz-7mwd",
      shortId: "sch:k3f9-q2xz-7mwd",
      paperCid: "bafy-genesis-1",
      paper_cid: "bafy-genesis-1",
      title: "Sparse attention without the quadratic cost",
      status: "under_review",
      categories: ["cs.AI"],
      role: "author",
      versionCount: 2,
      versions: 2,
      latestVersion: 2,
      latestVersionCid: "bafy-version-2",
      state: "awaiting_consent",
      reviewCount: 3,
      reviews: 3,
      revealedCount: 1,
      listedAt: null,
      claimed: true,
      link: "/p/sch:k3f9-q2xz-7mwd",
    },
  ],
  my_reviews: [
    {
      reviewCid: "bafy-review-1",
      review_cid: "bafy-review-1",
      state: "sealed",
      sealed: true,
      revealed: false,
      paper: "sch:k3f9-q2xz-7mwd",
      shortId: "sch:k3f9-q2xz-7mwd",
      paperCid: "bafy-genesis-1",
      version: 1,
      versionCid: "bafy-version-1",
      version_cid: "bafy-version-1",
      title: "Sparse attention without the quadratic cost",
      committedAt: "2026-11-12T10:00:00",
      revealedAt: null,
      recommendation: null,
      confidence: null,
      scores: null,
      signedBy: null,
      authorReplied: false,
      awaitingAuthor: true,
      responseCount: 0,
      link: "/review/sch:k3f9-q2xz-7mwd",
    },
    {
      reviewCid: "bafy-review-2",
      review_cid: "bafy-review-2",
      state: "revealed",
      sealed: false,
      revealed: true,
      paper: "sch:abcd-efgh-jklm",
      shortId: "sch:abcd-efgh-jklm",
      paperCid: "bafy-genesis-2",
      version: 2,
      versionCid: "bafy-version-2",
      version_cid: "bafy-version-2",
      title: "A tidy proof of a small lemma",
      committedAt: "2026-10-01T10:00:00",
      revealedAt: "2026-10-14T10:00:00",
      recommendation: "accept",
      confidence: 4,
      scores: null,
      signedBy: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
      authorReplied: true,
      awaitingAuthor: false,
      responseCount: 1,
      link: "/review/sch:abcd-efgh-jklm",
    },
  ],
};

/** The same document with every list empty, as a new member would see it. */
const EMPTY: DashboardData = {
  did: DATA.did,
  needs_attention: {
    count: 0,
    consents_to_sign: [],
    review_invitations: [],
    author_replies: [],
    moderation_outcomes: [],
    items: [],
  },
  my_papers: [],
  my_reviews: [],
};

/** The card with the given heading, found by its accessible name. */
function card(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("DashboardPage with server data", () => {
  it("shows the page title and the five cards", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    expect(screen.getByRole("heading", { level: 1, name: "Me" })).toBeTruthy();
    for (const name of [
      "Needs your attention",
      "My papers",
      "My reviews",
      "Credentials",
      "Notifications",
    ]) {
      expect(card(name)).toBeTruthy();
    }
  });

  it("does not fetch when the route already supplied the document", () => {
    const loadDashboard = vi.fn(async () => DATA);

    render(
      <DashboardPage initialDashboard={DATA} signedIn loadDashboard={loadDashboard} />,
    );

    expect(loadDashboard).not.toHaveBeenCalled();
  });

  it("names each attention item by its kind and links to it", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    const attention = within(card("Needs your attention"));
    expect(attention.getByText("2 items")).toBeTruthy();
    expect(attention.getByText("Consent to sign")).toBeTruthy();
    expect(attention.getByText("Review invitation")).toBeTruthy();
    expect(attention.getAllByRole("link", { name: "Open" })).toHaveLength(2);
    expect(attention.getByText(/Sign your co-author consent/)).toBeTruthy();
  });

  it("shows each paper's status as a word plus its review count", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    const papers = within(card("My papers"));
    expect(
      papers.getByRole("link", { name: "Sparse attention without the quadratic cost" }),
    ).toBeTruthy();
    // StatusChip: the word, with the reviewer count for under-review papers.
    expect(papers.getByText("Under review (3)")).toBeTruthy();
    expect(papers.getByText(/3 reviews/)).toBeTruthy();
    expect(papers.getByText(/2 versions/)).toBeTruthy();
    expect(papers.getByText(/awaiting consent/)).toBeTruthy();
  });

  it("tells sealed, revealed and awaiting-author reviews apart", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    const reviews = within(card("My reviews"));
    expect(reviews.getByText("Sealed")).toBeTruthy();
    expect(reviews.getByText("Revealed")).toBeTruthy();
    expect(reviews.getByText(/Awaiting author/)).toBeTruthy();
    expect(reviews.getByText(/Author replied/)).toBeTruthy();
  });

  it("shows the credential the member signs with", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    expect(within(card("Credentials")).getByText(DATA.did)).toBeTruthy();
  });

  it("anchors the Notifications card at /me#notifications", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    expect(card("Notifications").id).toBe("notifications");
  });

  it("says there is nothing to attend rather than showing an empty box", () => {
    render(<DashboardPage initialDashboard={EMPTY} signedIn />);

    expect(
      within(card("Needs your attention")).getByText(
        "Nothing needs your attention right now.",
      ),
    ).toBeTruthy();
    expect(
      within(card("My papers")).getByRole("link", { name: "Submit a paper" }),
    ).toHaveProperty("href", "http://localhost:3000/submit");
    expect(
      within(card("My reviews")).getByRole("link", { name: "Find a paper to review" }),
    ).toBeTruthy();
  });

  it("refreshes from an empty card", async () => {
    const refreshed: DashboardData = {
      ...EMPTY,
      needs_attention: {
        ...DATA.needs_attention,
        count: 1,
        items: [DATA.needs_attention.items[0]],
        consents_to_sign: DATA.needs_attention.consents_to_sign,
      },
    };
    const loadDashboard = vi.fn(async () => refreshed);

    render(
      <DashboardPage initialDashboard={EMPTY} signedIn loadDashboard={loadDashboard} />,
    );

    fireEvent.click(
      within(card("Needs your attention")).getByRole("button", { name: "Refresh" }),
    );

    expect(
      await screen.findByText(/Sign your co-author consent for/),
    ).toBeTruthy();
    expect(loadDashboard).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardPage fetch states", () => {
  it("loads the document on mount when there is no server data", async () => {
    render(<DashboardPage signedIn loadDashboard={async () => DATA} />);

    expect(
      await screen.findByRole("heading", { level: 2, name: "My reviews" }),
    ).toBeTruthy();
  });

  it("shows a loading line while the request is in flight", () => {
    render(<DashboardPage signedIn loadDashboard={() => new Promise(() => {})} />);

    expect(screen.getByRole("status").textContent).toBe("Loading your dashboard…");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("explains a failed load and retries it", async () => {
    const loadDashboard = vi.fn(async () => {
      throw new NetworkError("/v1/me/dashboard");
    });

    render(<DashboardPage signedIn loadDashboard={loadDashboard} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t load your dashboard/);    expect(alert.textContent).toContain("could not reach the API");

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(2));
  });

  it("shows the API's own problem detail when it refuses", async () => {
    render(
      <DashboardPage
        signedIn
        loadDashboard={async () => {
          throw new ApiError(401, { detail: "Sign in to read your dashboard." });
        }}
      />,
    );

    expect(
      await screen.findByText("Sign in to read your dashboard."),
    ).toBeTruthy();
  });

  it("asks a signed-out reader to sign in, returning to /me afterwards", () => {
    render(<DashboardPage signedIn={false} />);

    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveProperty(
      "href",
      "http://localhost:3000/signin?next=%2Fme",
    );
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("alias exports", () => {
  it("renders the same dashboard under its route and endpoint names", () => {
    render(<MePage initialMe={DATA} signedIn />);
    expect(screen.getByRole("heading", { level: 1, name: "Me" })).toBeTruthy();

    cleanup();

    render(<MeDashboardPage initialData={DATA} signedIn />);
    expect(screen.getByRole("heading", { level: 1, name: "Me" })).toBeTruthy();
  });
});
