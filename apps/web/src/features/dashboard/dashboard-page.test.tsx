// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { DashboardPage, MeDashboardPage, MePage, hasPendingAppeal } from "./dashboard-page";
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
  it("shows the page title and its cards", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    expect(screen.getByRole("heading", { level: 1, name: "Me" })).toBeTruthy();
    for (const name of [
      "Needs your attention",
      "My papers",
      "My reviews",
      "Credentials",
      "Security",
      "Notifications",
    ]) {
      expect(card(name)).toBeTruthy();
    }
  });

  it("links the Security card to /me/security", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    const security = within(card("Security"));
    expect(security.getByRole("link", { name: "Manage security" }).getAttribute("href")).toBe(
      "/me/security",
    );
    expect(security.getByText(/recovery guardians/)).toBeTruthy();
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

  it("names an appeal-panel item in sentence case and links to the vote form", () => {
    const panel: DashboardData = {
      ...DATA,
      needs_attention: {
        ...DATA.needs_attention,
        count: 1,
        items: [
          {
            kind: "appeal_panel",
            summary: 'Vote on the appeal for "A paper under appeal" by 2026-11-30.',
            reason: null,
            paper: "sch:k3f9-q2xz-7mwd",
            shortId: "sch:k3f9-q2xz-7mwd",
            paperCid: "bafy-genesis-1",
            version: 1,
            versionCid: "bafy-version-1",
            version_cid: "bafy-version-1",
            title: "A paper under appeal",
            link: "/mod#appeal-bafy-appeal-title",
            createdAt: null,
          },
        ],
      },
    };

    render(<DashboardPage initialDashboard={panel} signedIn />);

    const attention = within(card("Needs your attention"));
    expect(attention.getByText("Appeal panel")).toBeTruthy();
    expect(
      attention.getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/mod#appeal-bafy-appeal-title");
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

/* -------------------------------------------------------------------------- */
/* Regressions: notifications, ORCID iD, moderation chip, public profile       */
/* -------------------------------------------------------------------------- */

/** The three unread rows the seeded author sees, oldest first as the API serves them. */
const BELL_ROWS = [
  {
    id: 1,
    did: DATA.did,
    kind: "consent.request",
    payload: { version_cid: "bafy-version-1", paper_cid: "bafy-genesis-1", n: 1 },
    read: false,
  },
  {
    id: 2,
    did: DATA.did,
    kind: "moderation.decision",
    payload: { decision_cid: "bafy-decision-1", target_cid: "bafy-version-1", action: "hold" },
    read: false,
  },
  {
    id: 3,
    did: DATA.did,
    kind: "recovery.request",
    payload: { request_id: "rr-9" },
    read: false,
  },
];

describe("/me Notifications card (bell regression)", () => {
  it("lists what GET /v1/me/notifications returns instead of 'No notifications yet'", async () => {
    const loadNotifications = vi.fn().mockResolvedValue(BELL_ROWS);

    render(
      <DashboardPage initialDashboard={DATA} signedIn loadNotifications={loadNotifications} />,
    );

    const notifications = within(card("Notifications"));
    expect(await notifications.findAllByRole("listitem")).toHaveLength(3);
    expect(loadNotifications).toHaveBeenCalledTimes(1);
    expect(notifications.queryByText("No notifications yet.")).toBeNull();
    expect(notifications.getAllByText("Unread")).toHaveLength(3);
  });

  it("clears an unread row through the API's mark-read call", async () => {
    const markNotificationRead = vi.fn().mockResolvedValue(undefined);

    render(
      <DashboardPage
        initialDashboard={DATA}
        signedIn
        loadNotifications={async () => BELL_ROWS}
        markNotificationRead={markNotificationRead}
      />,
    );

    const notifications = within(card("Notifications"));
    const rows = await notifications.findAllByRole("listitem");
    fireEvent.click(within(rows[0]).getByRole("button", { name: /mark as read/i }));

    await waitFor(() => expect(notifications.getAllByText("Unread")).toHaveLength(2));
    expect(markNotificationRead).toHaveBeenCalledWith(3);
  });

  it("keeps the empty state for a member the API says has none", async () => {
    render(<DashboardPage initialDashboard={DATA} signedIn loadNotifications={async () => []} />);

    expect(
      await within(card("Notifications")).findByText("No notifications yet."),
    ).toBeTruthy();
  });

  it("shows a retryable error rather than a false empty state when the load fails", async () => {
    const loadNotifications = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("/v1/me/notifications"))
      .mockResolvedValueOnce(BELL_ROWS);

    render(
      <DashboardPage initialDashboard={DATA} signedIn loadNotifications={loadNotifications} />,
    );

    const notifications = within(card("Notifications"));
    const alert = await notifications.findByRole("alert");
    expect(notifications.queryByText("No notifications yet.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await notifications.findAllByRole("listitem")).toHaveLength(3);
  });
});

describe("/me Credentials card (ORCID regression)", () => {
  it("shows the linked ORCID iD as a link to its ORCID record", async () => {
    const loadLinkedOrcid = vi.fn().mockResolvedValue("0000-0002-1825-0097");

    render(
      <DashboardPage initialDashboard={DATA} signedIn loadLinkedOrcid={loadLinkedOrcid} />,
    );

    const credentials = within(card("Credentials"));
    const iD = await credentials.findByRole("link", { name: "0000-0002-1825-0097" });
    expect(iD.getAttribute("href")).toBe("https://orcid.org/0000-0002-1825-0097");
    expect(loadLinkedOrcid).toHaveBeenCalledWith(DATA.did);
    // The did:key stays alongside it.
    expect(credentials.getByText(DATA.did)).toBeTruthy();
  });

  it("says no iD is linked when there is none", async () => {
    render(
      <DashboardPage initialDashboard={DATA} signedIn loadLinkedOrcid={async () => null} />,
    );

    const credentials = within(card("Credentials"));
    expect(await credentials.findByText(/no ORCID iD linked/i)).toBeTruthy();
    expect(credentials.queryByRole("link", { name: /\d{4}-\d{4}-\d{4}-\d{3}[\dX]/ })).toBeNull();
  });

  it("does not blank the card when the iD cannot be read", async () => {
    render(
      <DashboardPage
        initialDashboard={DATA}
        signedIn
        loadLinkedOrcid={async () => {
          throw new NetworkError("/v1/profiles");
        }}
      />,
    );

    const credentials = within(card("Credentials"));
    expect(await credentials.findByText(/couldn.t read your ORCID iD/i)).toBeTruthy();
    expect(credentials.getByText(DATA.did)).toBeTruthy();
  });
});

describe("/me My papers moderation chip (Contested regression)", () => {
  const HELD: DashboardData = {
    ...DATA,
    my_papers: [
      {
        ...DATA.my_papers[0],
        // The computed review status is `contested` purely because a hold is in force.
        status: "contested",
        state: "held",
        reviewCount: 0,
        reviews: 0,
      },
    ],
  };

  it("labels a held paper Held, never Contested merely for being held", async () => {
    render(<DashboardPage initialDashboard={HELD} signedIn loadAppealPending={async () => false} />);

    const papers = within(card("My papers"));
    expect(await papers.findByText("Held")).toBeTruthy();
    expect(papers.queryByText(/Contested/)).toBeNull();
  });

  it("says Appeal pending once the author has appealed and no panel has decided", async () => {
    const loadAppealPending = vi.fn().mockResolvedValue(true);

    render(
      <DashboardPage initialDashboard={HELD} signedIn loadAppealPending={loadAppealPending} />,
    );

    const papers = within(card("My papers"));
    expect(await papers.findByText("Appeal pending")).toBeTruthy();
    expect(papers.queryByText("Held")).toBeNull();
    expect(loadAppealPending).toHaveBeenCalledTimes(1);
    expect(loadAppealPending.mock.calls[0][0]).toMatchObject({ shortId: "sch:k3f9-q2xz-7mwd" });
  });

  it("only looks up appeals for papers that a moderator has stopped", () => {
    const loadAppealPending = vi.fn().mockResolvedValue(false);

    render(<DashboardPage initialDashboard={DATA} signedIn loadAppealPending={loadAppealPending} />);

    expect(loadAppealPending).not.toHaveBeenCalled();
  });

  it("shows the moderation state beside the computed review status, as its own chip", async () => {
    const listed: DashboardData = {
      ...DATA,
      my_papers: [{ ...DATA.my_papers[0], state: "listed", status: "under_review" }],
    };

    render(<DashboardPage initialDashboard={listed} signedIn />);

    const papers = within(card("My papers"));
    expect(papers.getByText("Under review (3)")).toBeTruthy();
    expect(papers.getByText("Listed")).toBeTruthy();
  });

  it("falls back to Held when the appeal lookup fails", async () => {
    render(
      <DashboardPage
        initialDashboard={HELD}
        signedIn
        loadAppealPending={async () => {
          throw new NetworkError("/v1/export");
        }}
      />,
    );

    expect(await within(card("My papers")).findByText("Held")).toBeTruthy();
  });
});

describe("/me public profile link", () => {
  it("links to the member's own public profile at /u/{did}", () => {
    render(<DashboardPage initialDashboard={DATA} signedIn />);

    const link = screen.getByRole("link", { name: "View public profile" });
    expect(link.getAttribute("href")).toBe(`/u/${encodeURIComponent(DATA.did)}`);
  });
});

describe("hasPendingAppeal (reads the paper's public records)", () => {
  const VERSION = "bafyrei-version-1";
  const hold = {
    seq: 4,
    record_cid: "bafyrei-held",
    record_type: "moderation.decision",
    received_at: "2027-03-01T10:00:00Z",
    body: { target: VERSION, action: "hold", clause: "MOD-01", reason: "Needs a licence." },
  };
  const appeal = {
    seq: 5,
    record_cid: "bafyrei-appeal-5",
    record_type: "appeal",
    received_at: "2027-03-05T10:00:00Z",
    body: { target: "bafyrei-held", grounds: "Why." },
  };
  const verdict = {
    seq: 6,
    record_cid: "bafyrei-verdict-6",
    record_type: "appeal.decision",
    received_at: "2027-03-06T10:00:00Z",
    body: { target: "bafyrei-appeal-5", outcome: "upheld" },
  };

  it("is true once the held version has an appeal no panel has decided", () => {
    expect(hasPendingAppeal([hold, appeal], VERSION)).toBe(true);
  });

  it("is false before any appeal is filed", () => {
    expect(hasPendingAppeal([hold], VERSION)).toBe(false);
  });

  it("is false once the panel has decided", () => {
    expect(hasPendingAppeal([hold, appeal, verdict], VERSION)).toBe(false);
  });

  it("is false when there are no records at all", () => {
    expect(hasPendingAppeal([], VERSION)).toBe(false);
  });
});

describe("the bell's /me#notifications deep link", () => {
  type Scrollable = Element & { scrollIntoView: (options?: ScrollIntoViewOptions) => void };

  function stubScrollIntoView() {
    const calls: Element[] = [];
    const spy = vi.fn(function (this: Element) {
      calls.push(this);
    });
    const proto = Element.prototype as Scrollable;
    const original = proto.scrollIntoView;
    proto.scrollIntoView = spy as Scrollable["scrollIntoView"];
    return {
      spy,
      calls,
      restore() {
        if (original === undefined) {
          delete (Element.prototype as Partial<Scrollable>).scrollIntoView;
        } else {
          proto.scrollIntoView = original;
        }
      },
    };
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("scrolls the Notifications section into view and focuses its heading", async () => {
    window.history.replaceState(null, "", "/me#notifications");
    const stub = stubScrollIntoView();
    try {
      render(
        <DashboardPage
          initialDashboard={DATA}
          signedIn
          loadNotifications={async () => []}
        />,
      );

      const heading = screen.getByRole("heading", { name: "Notifications" });
      await waitFor(() => expect(stub.spy).toHaveBeenCalledTimes(1));
      expect(stub.calls[0]).toBe(card("Notifications"));
      expect(document.activeElement).toBe(heading);
    } finally {
      stub.restore();
    }
  });

  it("waits for the cards to render before scrolling", async () => {
    window.history.replaceState(null, "", "/me#notifications");
    const stub = stubScrollIntoView();
    let resolve: (data: DashboardData) => void = () => {};
    const loadDashboard = () =>
      new Promise<DashboardData>((done) => {
        resolve = done;
      });
    try {
      render(
        <DashboardPage
          signedIn
          loadDashboard={loadDashboard}
          loadNotifications={async () => []}
        />,
      );
      expect(stub.spy).not.toHaveBeenCalled();

      resolve(DATA);
      await screen.findByRole("region", { name: "Notifications" });
      await waitFor(() => expect(stub.spy).toHaveBeenCalledTimes(1));
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Notifications" }),
      );
    } finally {
      stub.restore();
    }
  });

  it("leaves the page alone when the URL has no fragment", async () => {
    const stub = stubScrollIntoView();
    try {
      render(
        <DashboardPage
          initialDashboard={DATA}
          signedIn
          loadNotifications={async () => []}
        />,
      );
      await screen.findByRole("region", { name: "Notifications" });
      expect(stub.spy).not.toHaveBeenCalled();
    } finally {
      stub.restore();
    }
  });
});
