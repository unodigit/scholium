import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";

import {
  DASHBOARD_ENDPOINT,
  DASHBOARD_PATH,
  DASHBOARD_TITLE,
  DashboardError,
  ME_DASHBOARD_ENDPOINT,
  ME_PATH,
  ME_TITLE,
  SIGNIN_HREF,
  describeDashboardError,
  describeMeDashboardError,
  describeMeError,
  loadDashboard,
  loadMe,
  parseDashboard,
  type DashboardClient,
  NOTIFICATIONS_ENDPOINT,
  describeNotificationsError,
  loadNotifications,
  markNotificationRead,
  moderationChip,
  notificationDetail,
  notificationKindLabel,
  notificationLink,
  notificationSummary,
  notificationTime,
  orcidHref,
  parseNotifications,
  timeAgo,
  type MyPaper,
} from "./dashboard";

/** A `GET /v1/me/dashboard` body, exactly as the `me` plugin serves it. */
const PAYLOAD = {
  did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  needs_attention: {
    count: 3,
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
        title: "Sparse attention without the quadratic cost",
        link: "/consent/bafy-version-1",
        createdAt: "2026-11-10T09:00:00Z",
      },
    ],
    review_invitations: [
      {
        kind: "review_invitation",
        summary: "Review sch:abcd-efgh-jklm",
        paper: "sch:abcd-efgh-jklm",
        paperCid: "bafy-genesis-2",
        version: 2,
        versionCid: "bafy-version-2",
        title: "A tidy proof of a small lemma",
        link: "/review/sch:abcd-efgh-jklm",
      },
    ],
    author_replies: [
      {
        kind: "author_reply",
        summary: "The authors replied to your review",
        reviewCid: "bafy-review-1",
        responseCid: "bafy-response-1",
        title: "Sparse attention without the quadratic cost",
        link: "/review/sch:k3f9-q2xz-7mwd",
      },
    ],
    moderation_outcomes: [],
  },
  my_papers: [
    {
      paper: "sch:k3f9-q2xz-7mwd",
      shortId: "sch:k3f9-q2xz-7mwd",
      paperCid: "bafy-genesis-1",
      title: "Sparse attention without the quadratic cost",
      status: "under_review",
      categories: ["cs.AI", "cs.LG"],
      role: "author",
      versionCount: 2,
      latestVersion: 2,
      latestVersionCid: "bafy-version-2",
      state: "awaiting_consent",
      reviewCount: 3,
      revealedCount: 1,
      listedAt: "2026-11-09T12:00:00Z",
      claimed: true,
      link: "/p/sch:k3f9-q2xz-7mwd",
    },
  ],
  my_reviews: [
    {
      reviewCid: "bafy-review-1",
      state: "sealed",
      sealed: true,
      revealed: false,
      paper: "sch:k3f9-q2xz-7mwd",
      paperCid: "bafy-genesis-1",
      version: 1,
      versionCid: "bafy-version-1",
      title: "Sparse attention without the quadratic cost",
      committedAt: "2026-11-12T10:00:00",
      revealedAt: null,
      signedBy: null,
      authorReplied: false,
      awaitingAuthor: true,
      responseCount: 0,
      link: "/review/sch:k3f9-q2xz-7mwd",
    },
    {
      reviewCid: "bafy-review-2",
      state: "revealed",
      sealed: false,
      revealed: true,
      paper: "sch:abcd-efgh-jklm",
      paperCid: "bafy-genesis-2",
      version: 2,
      versionCid: "bafy-version-2",
      title: "A tidy proof of a small lemma",
      committedAt: "2026-10-01T10:00:00",
      revealedAt: "2026-10-14T10:00:00",
      signedBy: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
      authorReplied: true,
      awaitingAuthor: false,
      responseCount: 1,
      link: "/review/sch:abcd-efgh-jklm",
    },
  ],
};

describe("dashboard constants", () => {
  it("names the route, the endpoint and the page", () => {
    expect(ME_PATH).toBe("/me");
    expect(DASHBOARD_PATH).toBe("/me");
    expect(DASHBOARD_ENDPOINT).toBe("/me/dashboard");
    expect(ME_DASHBOARD_ENDPOINT).toBe("/me/dashboard");
    expect(ME_TITLE).toBe("Me");
    expect(DASHBOARD_TITLE).toBe("Me");
  });

  it("sends a signed-out reader back to /me after signing in", () => {
    expect(SIGNIN_HREF).toBe(`/signin?next=${encodeURIComponent("/me")}`);
  });
});

describe("parseDashboard", () => {
  it("reads the caller and the three parts of the document", () => {
    const data = parseDashboard(PAYLOAD);

    expect(data.did).toBe(PAYLOAD.did);
    expect(data.needs_attention.count).toBe(3);
    expect(data.needs_attention.items).toHaveLength(3);
    expect(data.my_papers).toHaveLength(1);
    expect(data.my_reviews).toHaveLength(2);
  });

  it("keeps each attention group and flattens them in dashboard order", () => {
    const attention = parseDashboard(PAYLOAD).needs_attention;

    expect(attention.consents_to_sign[0].kind).toBe("consent_to_sign");
    expect(attention.consents_to_sign[0].link).toBe("/consent/bafy-version-1");
    expect(attention.review_invitations[0].kind).toBe("review_invitation");
    expect(attention.author_replies[0].kind).toBe("author_reply");
    expect(attention.moderation_outcomes).toHaveLength(0);

    expect(attention.items.map((item) => item.kind)).toEqual([
      "consent_to_sign",
      "review_invitation",
      "author_reply",
    ]);
  });

  it("derives the flat list from the groups when the API omits it", () => {
    const payload = structuredClone(PAYLOAD);
    delete (payload.needs_attention as { items?: unknown }).items;

    const attention = parseDashboard(payload).needs_attention;

    expect(attention.items).toHaveLength(3);
    expect(attention.items[2].kind).toBe("author_reply");
  });

  it("reads each paper's status, review count and version count", () => {
    const [paper] = parseDashboard(PAYLOAD).my_papers;

    expect(paper.status).toBe("under_review");
    expect(paper.reviewCount).toBe(3);
    expect(paper.reviews).toBe(3);
    expect(paper.versionCount).toBe(2);
    expect(paper.versions).toBe(2);
    expect(paper.state).toBe("awaiting_consent");
    expect(paper.categories).toEqual(["cs.AI", "cs.LG"]);
    expect(paper.link).toBe("/p/sch:k3f9-q2xz-7mwd");
  });

  it("tells a sealed review awaiting the author from a revealed one", () => {
    const [sealedReview, revealedReview] = parseDashboard(PAYLOAD).my_reviews;

    expect(sealedReview.state).toBe("sealed");
    expect(sealedReview.sealed).toBe(true);
    expect(sealedReview.revealed).toBe(false);
    expect(sealedReview.awaitingAuthor).toBe(true);
    expect(sealedReview.authorReplied).toBe(false);

    expect(revealedReview.state).toBe("revealed");
    expect(revealedReview.sealed).toBe(false);
    expect(revealedReview.revealed).toBe(true);
    expect(revealedReview.awaitingAuthor).toBe(false);
    expect(revealedReview.authorReplied).toBe(true);
    expect(revealedReview.revealedAt).toBe("2026-10-14T10:00:00");
  });

  it("reads the documented aliases and ignores spellings it does not know", () => {
    const data = parseDashboard({
      did: "did:key:z6Mk",
      needs_attention: { count: 0 },
      my_papers: [
        { paper: "sch:x", review_count: 4, version_count: 1, latest_version: 2 },
      ],
      my_reviews: [{ review_cid: "bafy-review", state: "sealed", awaiting_author: true }],
    });

    // `review_count` is not a documented spelling; the documented camelCase
    // `reviewCount` and the `reviews` alias are what the client reads, so an
    // unknown spelling must not silently become a number.
    expect(data.my_papers[0].reviewCount).toBe(0);
    expect(data.my_reviews[0].reviewCid).toBe("bafy-review");
    expect(data.my_reviews[0].awaitingAuthor).toBe(true);
  });

  it("clamps impossible counts to zero instead of rendering a negative", () => {
    const data = parseDashboard({
      did: "did:key:z6Mk",
      needs_attention: { count: -4 },
      my_papers: [{ paper: "sch:x", reviewCount: -2, versionCount: 1.9 }],
      my_reviews: [],
    });

    expect(data.needs_attention.count).toBe(0);
    expect(data.my_papers[0].reviewCount).toBe(0);
    expect(data.my_papers[0].versionCount).toBe(1);
  });

  it("rejects a payload that is not an object", () => {
    expect(() => parseDashboard(null)).toThrow(DashboardError);
    expect(() => parseDashboard("nope")).toThrow(DashboardError);
    expect(() => parseDashboard([])).toThrow(DashboardError);
  });

  it("rejects a document that does not name the caller", () => {
    expect(() =>
      parseDashboard({ needs_attention: { count: 0 }, my_papers: [], my_reviews: [] }),
    ).toThrow(/did not name the caller/);
  });

  it("rejects a review without an id rather than rendering a dead row", () => {
    expect(() =>
      parseDashboard({
        did: "did:key:z6Mk",
        needs_attention: { count: 0 },
        my_papers: [],
        my_reviews: [{ state: "sealed" }],
      }),
    ).toThrow(/has no review id/);
  });
});

describe("loadDashboard", () => {
  /** A spy with the API client's generic `get` signature. */
  function stubClient(payload: unknown = PAYLOAD): {
    get: ReturnType<typeof vi.fn>;
    client: DashboardClient;
  } {
    const get = vi.fn(async () => payload);
    return { get, client: { get: get as unknown as DashboardClient["get"] } };
  }

  it("asks GET /me/dashboard for a fresh copy every time", async () => {
    const { get, client } = stubClient();

    const data = await loadDashboard(client);

    expect(get).toHaveBeenCalledWith("/me/dashboard", { cache: "no-store" });
    expect(data.did).toBe(PAYLOAD.did);
  });

  it("is the same loader under its route and endpoint names", async () => {
    const { get, client } = stubClient();

    await loadMe(client);
    await loadDashboard(client);

    expect(
      get.mock.calls.filter(([path]) => path === "/me/dashboard"),
    ).toHaveLength(2);
  });

  it("adds an open recovery request to Needs your attention until the guardian answers", async () => {
    const viewer = PAYLOAD.did;
    const other = "did:key:z6MkOtherGuardianOtherGuardianOtherGuardian";
    const requester = "did:key:z6MkRequesterRequesterRequesterRequester";
    const recovery = [
      {
        request_id: "rec_open",
        did: requester,
        status: "pending",
        approvals: [{ guardian: other }],
        approval_count: 1,
        threshold: 3,
      },
      {
        request_id: "rec_answered",
        did: requester,
        status: "pending",
        approvals: [{ guardian: viewer }],
        approval_count: 1,
        threshold: 3,
      },
      {
        request_id: "rec_closed",
        did: requester,
        status: "finalized",
        approvals: [],
        approval_count: 0,
        threshold: 3,
      },
    ];
    const get = vi.fn(async (path: string) =>
      path === "/recovery/requests" ? recovery : PAYLOAD,
    );
    const client = { get: get as unknown as DashboardClient["get"] };

    const data = await loadDashboard(client);

    const added = data.needs_attention.items.filter(
      (item) => item.kind === "recovery_request",
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "recovery_request",
      link: "/me/recovery/rec_open",
    });
    expect(data.needs_attention.count).toBe(PAYLOAD.needs_attention.count + 1);
  });

  it("still loads the dashboard when the recovery list cannot be read", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/recovery/requests") {
        throw new ApiError(404, { title: "Not Found" });
      }
      return PAYLOAD;
    });
    const client = { get: get as unknown as DashboardClient["get"] };

    const data = await loadDashboard(client);

    expect(data.did).toBe(PAYLOAD.did);
    expect(data.needs_attention.items.every((item) => item.kind !== "recovery_request")).toBe(
      true,
    );
  });
});

describe("describeDashboardError", () => {
  it("prefers the API's own explanation", () => {
    const error = new ApiError(401, { detail: "Sign in to read your dashboard." });

    expect(describeDashboardError(error)).toBe("Sign in to read your dashboard.");
  });

  it("falls back to the problem title when there is no detail", () => {
    const error = new ApiError(403, { title: "Forbidden" });

    expect(describeDashboardError(error)).toBe("Forbidden");
  });

  it("turns an unreachable API into plain language", () => {
    expect(describeDashboardError(new NetworkError("/v1/me/dashboard"))).toMatch(
      /could not reach the API/,
    );
  });

  it("keeps a malformed-payload message and any other Error's message", () => {
    expect(describeDashboardError(new DashboardError("Bad payload."))).toBe(
      "Bad payload.",
    );
    expect(describeDashboardError(new Error("Boom."))).toBe("Boom.");
  });

  it("has a calm sentence for a value that is not an error at all", () => {
    expect(describeDashboardError("nope")).toBe(
      "The API could not return your dashboard.",
    );
  });

  it("is the same function under its route and endpoint names", () => {
    const error = new DashboardError("Bad payload.");

    expect(describeMeError(error)).toBe("Bad payload.");
    expect(describeMeDashboardError(error)).toBe("Bad payload.");
  });
});

/* -------------------------------------------------------------------------- */
/* Notifications (GET /v1/me/notifications)                                    */
/* -------------------------------------------------------------------------- */

/** One row exactly as `NotificationOut` serialises it. */
const NOTIFICATION_ROW = {
  id: 7,
  did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  kind: "consent.request",
  payload: { version_cid: "bafy-version-1", paper_cid: "bafy-genesis-1", n: 2 },
  read: false,
};

describe("parseNotifications", () => {
  it("keeps the API's order and every field the card needs", () => {
    const rows = parseNotifications([NOTIFICATION_ROW, { ...NOTIFICATION_ROW, id: 8, read: true }]);

    expect(rows.map((row) => row.id)).toEqual([7, 8]);
    expect(rows[0]).toMatchObject({ kind: "consent.request", read: false });
    expect(rows[1].read).toBe(true);
    expect(rows[0].payload).toEqual(NOTIFICATION_ROW.payload);
  });

  it("treats an unreadable payload as empty rather than failing the list", () => {
    expect(parseNotifications([{ ...NOTIFICATION_ROW, payload: "oops" }])[0].payload).toEqual({});
  });

  it("treats a row without an explicit read: true as unread", () => {
    const { read: _read, ...bare } = NOTIFICATION_ROW;
    expect(parseNotifications([bare])[0].read).toBe(false);
  });

  it("rejects a body that is not a list, never 'no notifications'", () => {
    expect(() => parseNotifications(null)).toThrow(/list of notifications/);
    expect(() => parseNotifications({ items: [] })).toThrow(/list of notifications/);
  });

  it("rejects a row with no id, which could never be marked read", () => {
    expect(() => parseNotifications([{ ...NOTIFICATION_ROW, id: undefined }])).toThrow(/has no id/);
  });
});

describe("loadNotifications / markNotificationRead", () => {
  it("asks GET /me/notifications for a fresh copy with the viewer's token", async () => {
    const get = vi.fn(async () => [NOTIFICATION_ROW]);

    const rows = await loadNotifications({ get } as unknown as Parameters<typeof loadNotifications>[0]);

    expect(NOTIFICATIONS_ENDPOINT).toBe("/me/notifications");
    expect(get).toHaveBeenCalledWith("/me/notifications", { cache: "no-store" });
    expect(rows).toHaveLength(1);
  });

  it("marks one read with POST /me/notifications/{id}/read, surviving a navigation", async () => {
    const post = vi.fn(async () => ({ ...NOTIFICATION_ROW, read: true }));

    await markNotificationRead(7, { post } as unknown as Parameters<typeof markNotificationRead>[1]);

    expect(post).toHaveBeenCalledWith("/me/notifications/7/read", undefined, { keepalive: true });
  });
});

describe("an appeal panel's attention item", () => {
  it("writes the due day with the shared formatter, from the deadline it carries", () => {
    const data = parseDashboard({
      did: "did:key:z6MkMember",
      needs_attention: {
        count: 1,
        appeal_panels: [
          {
            kind: "appeal_panel",
            summary: 'Vote on the appeal for "A paper under appeal" by 2026-12-02.',
            deadline: "2026-12-02T12:00:00+00:00",
          },
        ],
      },
      my_papers: [],
      my_reviews: [],
    });

    expect(data.needs_attention.appeal_panels?.[0]?.summary).toBe(
      'Vote on the appeal for "A paper under appeal" by 2 Dec 2026.',
    );
    expect(data.needs_attention.items[0]?.summary).toBe(
      'Vote on the appeal for "A paper under appeal" by 2 Dec 2026.',
    );
  });
});

describe("notification wording", () => {
  it("names each kind", () => {
    expect(notificationKindLabel("consent.request")).toBe("Consent request");
    expect(notificationKindLabel("recovery.request")).toBe("Recovery approval");
    expect(notificationKindLabel("moderation.decision")).toBe("Moderation outcome");
    expect(notificationKindLabel("review.invitation")).toBe("Review invitation");
    expect(notificationKindLabel("email.verify")).toBe("Email verification");
    expect(notificationKindLabel("something.brand_new")).toBe("Something brand new");
  });

  it("summarises in plain words, not payload keys", () => {
    expect(notificationSummary({ kind: "consent.request", payload: { n: 2 } })).toMatch(/co-author consent.*version 2/i);
    expect(notificationSummary({ kind: "moderation.decision", payload: { action: "hold" } })).toMatch(/paper on hold/i);
    expect(notificationSummary({ kind: "moderation.decision", payload: { action: "reject" } })).toMatch(/rejected/i);
    expect(notificationSummary({ kind: "email.verify", payload: {} })).toMatch(/confirm your email/i);
    expect(notificationSummary({ kind: "flag.decided", payload: { status: "upheld" } })).toMatch(/upheld/i);
    expect(notificationSummary({ kind: "x.y", payload: { summary: "Heads up" } })).toBe("Heads up");
    expect(notificationSummary({ kind: "x.y", payload: {} })).toBe("X y");
  });

  it("points at the web screen for the kinds that have one", () => {
    expect(notificationLink({ kind: "consent.request", payload: { version_cid: "bafy-v" } })).toBe("/consent/bafy-v");
    expect(notificationLink({ kind: "recovery.request", payload: { request_id: "rr-9" } })).toBe("/me/recovery/rr-9");
    expect(notificationLink({ kind: "moderation.decision", payload: { target_cid: "bafy-v" } })).toBe("/p/bafy-v");
  });

  it("rewords an answered notification in the past tense", () => {
    expect(
      notificationSummary({
        kind: "consent.request",
        read: true,
        payload: { n: 2, title: "Sparse attention" },
      }),
    ).toBe('You signed your consent on "Sparse attention" (version 2).');
    expect(
      notificationSummary({ kind: "email.verify", read: true, payload: {} }),
    ).toBe("You confirmed your email address.");
  });

  describe("a recovery notice says what the guardian did, never what was merely read", () => {
    const HANNA = { account_name: "Hanna Varga", request_id: "rec_1" };

    it("does not claim an approval just because the notice was read", () => {
      for (const payload of [HANNA, { ...HANNA, closed: "quorum", approval_count: 3, guardian_count: 5 }]) {
        const summary = notificationSummary({ kind: "recovery.request", read: true, payload });
        expect(summary).not.toMatch(/You approved/);
        expect(summary).not.toMatch(/You declined/);
      }
    });

    it("says 'You approved' with the date, only for the guardian's own approval", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, answer: "approved", answered_at: "2026-11-17T12:00:00Z" },
        }),
      ).toBe("You approved the recovery request from Hanna Varga on 17 Nov 2026.");
    });

    it("says 'You declined' for a recorded decline", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, answer: "declined", answered_at: "2026-11-17T12:00:00Z" },
        }),
      ).toBe("You declined the recovery request from Hanna Varga on 17 Nov 2026.");
    });

    it("leaves the date out when none was recorded", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, answer: "approved" },
        }),
      ).toBe("You approved the recovery request from Hanna Varga.");
    });

    it("says it closed, with how many guardians approved, for a guardian who did not answer", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, closed: "quorum", approval_count: 3, guardian_count: 5 },
        }),
      ).toBe("The recovery request from Hanna Varga closed (3 of 5 guardians approved).");
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, closed: "finalized", approval_count: 4, guardian_count: 5 },
        }),
      ).toBe("The recovery request from Hanna Varga closed (4 of 5 guardians approved).");
    });

    it("says it is approved, and when the new passkey takes over, while the safety window is open", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: {
            ...HANNA,
            contest_until: "2026-11-20T09:00:00Z",
            approval_count: 3,
            guardian_count: 5,
          },
        }),
      ).toBe(
        "The recovery request from Hanna Varga approved - the new passkey takes over on 20 Nov 2026.",
      );
    });

    it("says it closed after the window, not that the passkey is about to take over", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: {
            ...HANNA,
            closed: "finalized",
            contest_until: "2026-11-20T09:00:00Z",
            approval_count: 4,
            guardian_count: 5,
          },
        }),
      ).toBe("The recovery request from Hanna Varga closed (4 of 5 guardians approved).");
    });

    it("says it was cancelled when the account holder cancelled it", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: { ...HANNA, closed: "cancelled", approval_count: 1, guardian_count: 5 },
        }),
      ).toBe("The recovery request from Hanna Varga was cancelled.");
    });

    it("lets the guardian's own answer win over the request closing", () => {
      expect(
        notificationSummary({
          kind: "recovery.request",
          read: true,
          payload: {
            ...HANNA,
            answer: "approved",
            answered_at: "2026-11-17T12:00:00Z",
            closed: "quorum",
            approval_count: 3,
            guardian_count: 5,
          },
        }),
      ).toBe("You approved the recovery request from Hanna Varga on 17 Nov 2026.");
    });

    it("still asks an unanswered, unclosed request's guardian to approve", () => {
      expect(notificationSummary({ kind: "recovery.request", payload: HANNA })).toBe(
        "A recovery request from Hanna Varga needs your approval as a guardian.",
      );
    });
  });

  it("shows a panel notice's own sentence, whether or not it was read", () => {
    const voted = 'You voted to uphold the decision on the appeal for "A paper under appeal".';
    expect(
      notificationSummary({
        kind: "appeal.panel",
        read: true,
        payload: { title: "A paper under appeal", summary: voted, outcome: voted },
      }),
    ).toBe(voted);
    const decided = "The panel overturned the decision on \"A paper under appeal\".";
    expect(
      notificationSummary({
        kind: "appeal.panel",
        read: false,
        payload: { title: "A paper under appeal", summary: decided, outcome: decided },
      }),
    ).toBe(decided);
    // Read without a vote recorded is not a vote: nothing here says the member voted.
    expect(
      notificationSummary({
        kind: "appeal.panel",
        read: true,
        payload: {
          title: "A paper under appeal",
          summary: 'Vote on the appeal for "A paper under appeal" by 2 Dec 2026.',
        },
      }),
    ).not.toMatch(/You voted/);
  });

  it("writes a seat notice's due day with the shared formatter, from the deadline it carries", () => {
    const seat = {
      kind: "appeal.panel",
      read: false,
      payload: {
        title: "A paper under appeal",
        deadline: "2026-12-02T12:00:00+00:00",
        summary: 'Vote on the appeal for "A paper under appeal" by 2026-12-02.',
      },
    };
    expect(notificationSummary(seat)).toBe(
      'Vote on the appeal for "A paper under appeal" by 2 Dec 2026.',
    );
    // Already in words, it is left as it is.
    expect(
      notificationSummary({
        ...seat,
        payload: { ...seat.payload, summary: 'Vote on the appeal of a hidden post on "A paper under appeal" by 2 Dec 2026.' },
      }),
    ).toBe('Vote on the appeal of a hidden post on "A paper under appeal" by 2 Dec 2026.');
  });

  it("does not repeat a reason the sentence already carries", () => {
    const sentence =
      'The post you reported as "Off topic" on "Sparse attention" was reviewed and kept. Moderator\'s note: The post is on topic.';
    expect(
      notificationDetail({
        kind: "flag.decided",
        payload: { summary: sentence, outcome: sentence, reason: "Off topic" },
      }),
    ).toBeNull();
    // A reason the sentence leaves out is still shown.
    expect(
      notificationDetail({
        kind: "moderation.decision",
        payload: { action: "hold", reason: "Needs a licence." },
      }),
    ).toBe("Needs a licence.");
    expect(notificationDetail({ payload: { reason: "Needs a licence." } })).toBe("Needs a licence.");
  });

  it("keeps an unread notification's imperative wording", () => {
    expect(
      notificationSummary({ kind: "email.verify", payload: {} }),
    ).toBe("Confirm your email address.");
    expect(
      notificationSummary({ kind: "consent.request", payload: { n: 2 } }),
    ).toMatch(/waiting for your signature/i);
  });

  it("offers no action link on an answered notification", () => {
    expect(
      notificationLink({
        kind: "consent.request",
        read: true,
        payload: { version_cid: "bafy-v" },
      }),
    ).toBeNull();
    expect(
      notificationLink({
        kind: "email.verify",
        read: true,
        payload: { link: "/verify-email?did=x&token=y" },
      }),
    ).toBeNull();
  });

  it("uses a payload link only when it is a web page or an absolute http(s) address", () => {
    expect(notificationLink({ kind: "x.y", payload: { link: "/review/sch:abcd-efgh-jklm" } })).toBe(
      "/review/sch:abcd-efgh-jklm",
    );
    expect(notificationLink({ kind: "x.y", payload: { link: "https://scholium.example/x" } })).toBe(
      "https://scholium.example/x",
    );
    expect(notificationLink({ kind: "x.y", payload: { link: "javascript:alert(1)" } })).toBeNull();
    expect(notificationLink({ kind: "x.y", payload: { link: "//evil.example/x" } })).toBeNull();
    // An API route is not a page: the web origin would 404 it.
    expect(notificationLink({ kind: "x.y", payload: { link: "/v1/appeals/bafy-a" } })).toBeNull();
    expect(notificationLink({ kind: "x.y", payload: {} })).toBeNull();
  });

  it("reads the time from the payload when the kind carries one, else says nothing", () => {
    expect(notificationTime({ payload: { requested_at: "2026-11-16T10:00:00Z" } })).toBe("2026-11-16T10:00:00Z");
    expect(notificationTime({ payload: { created_at: "2026-11-15T10:00:00Z" } })).toBe("2026-11-15T10:00:00Z");
    expect(notificationTime({ payload: { requested_at: "not a date" } })).toBeNull();
    expect(notificationTime({ payload: {} })).toBeNull();
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-17T12:00:00Z");

  it("reads as a short relative phrase", () => {
    expect(timeAgo("2026-11-17T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-11-17T11:15:00Z", now)).toBe("45 minutes ago");
    expect(timeAgo("2026-11-17T11:00:00Z", now)).toBe("1 hour ago");
    expect(timeAgo("2026-11-16T12:00:00Z", now)).toBe("1 day ago");
    expect(timeAgo("2026-11-10T12:00:00Z", now)).toBe("7 days ago");
  });

  it("falls back to the date once it is more than a month old, and to just now for the future", () => {
    expect(timeAgo("2026-08-01T12:00:00Z", now)).toBe("2026-08-01");
    expect(timeAgo("2026-11-17T13:00:00Z", now)).toBe("just now");
  });
});

describe("describeNotificationsError", () => {
  it("says it is the notifications that failed, in the API's own words when it has them", () => {
    expect(describeNotificationsError(new ApiError(401, { detail: "Sign in." }))).toBe("Sign in.");
    expect(describeNotificationsError(new NetworkError("/v1/me/notifications"))).toMatch(/could not reach the API/);
    expect(describeNotificationsError("nope")).toBe("The API could not return your notifications.");
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials and My papers                                                   */
/* -------------------------------------------------------------------------- */

describe("orcidHref", () => {
  it("links a linked iD to its public ORCID record", () => {
    expect(orcidHref("0000-0002-1825-0097")).toBe("https://orcid.org/0000-0002-1825-0097");
  });
});

describe("moderationChip", () => {
  /** A paper with only the fields the chip reads. */
  const paper = (state: string | null, status: string | null = "preprint"): MyPaper =>
    ({ state, status }) as unknown as MyPaper;

  it("names the moderation state as its own word", () => {
    expect(moderationChip(paper("held"))?.label).toBe("Held");
    expect(moderationChip(paper("rejected"))?.label).toBe("Rejected");
    expect(moderationChip(paper("listed"))?.label).toBe("Listed");
    expect(moderationChip(paper("awaiting_consent"))?.label).toBe("Awaiting consent");
  });

  it("says Appeal pending for a held or rejected paper whose appeal awaits a panel", () => {
    expect(moderationChip(paper("held"), { appealPending: true })?.label).toBe("Appeal pending");
    expect(moderationChip(paper("rejected"), { appealPending: true })?.label).toBe("Appeal pending");
    // An appeal means nothing for a paper that is not stopped.
    expect(moderationChip(paper("listed"), { appealPending: true })?.label).toBe("Listed");
  });

  it("has no chip when the paper has no version yet", () => {
    expect(moderationChip(paper(null))).toBeNull();
  });
});
