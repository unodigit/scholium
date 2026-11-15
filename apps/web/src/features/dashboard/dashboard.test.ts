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

    expect(get).toHaveBeenCalledTimes(2);
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
