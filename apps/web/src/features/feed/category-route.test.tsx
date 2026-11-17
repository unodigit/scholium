// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import CategoryRoutePage, {
  dynamic,
  generateMetadata,
} from "../../app/(feed)/c/[category]/page";

/**
 * `/c/{category}` is server-rendered: the first HTML response must already
 * contain the category's papers, the same rows the home feed uses, and the
 * link to the category's Atom feed.
 */

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const ITEM = {
  paper: "sch:k3f9-q2xz-7mwd",
  shortId: "sch:k3f9-q2xz-7mwd",
  paperCid: "bafy-paper-1",
  versionCid: "bafy-version-2",
  cid: "bafy-version-2",
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "An evaluation framework for whether meta-agents can identify safer branches.",
  authors: [
    { did: DID, author: DID, position: 1 },
    { did: "did:key:z6MkOkafor", author: "did:key:z6MkOkafor", position: 2 },
  ],
  categories: ["cs.AI", "cs.MA"],
  licence: "CC-BY-4.0",
  status: "reviewed",
  listedAt: "2026-11-13T09:00:00",
  updatedAt: "2026-11-15T09:00:00",
};

const SECOND = {
  ...ITEM,
  paper: "sch:abcd-efgh-jklm",
  shortId: "sch:abcd-efgh-jklm",
  paperCid: "bafy-paper-2",
  versionCid: "bafy-version-3",
  cid: "bafy-version-3",
  n: 1,
  version: 1,
  title: "Sparse Probing of Reward Models",
  categories: ["cs.AI"],
  status: "preprint",
};

function stubApi(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: {
          "content-type": status === 200 ? "application/json" : "application/problem+json",
        },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function params(category: string) {
  return Promise.resolve({ category });
}

async function render(category = "cs.AI"): Promise<string> {
  return renderToStaticMarkup(await CategoryRoutePage({ params: params(category) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("category route (server render)", () => {
  it("puts the category's papers in the first HTML", async () => {
    const fetchMock = stubApi({ items: [ITEM, SECOND], nextCursor: null });

    const html = await render();

    expect(html).toContain(ITEM.title);
    expect(html).toContain(SECOND.title);
    expect(html).toContain(ITEM.abstract);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/papers?");
    expect(url).toContain("tab=latest");
    expect(url).toContain("category=cs.AI");
    expect(url).toContain("sort=newest");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("cursor=");
  });

  it("uses the same row layout as the home feed", async () => {
    stubApi({ items: [ITEM, SECOND], nextCursor: null });

    const html = await render();

    expect(html).toContain('class="fd-list"');
    expect(html).toContain('class="fd-row"');
    expect(html).toContain('class="fd-row-title"');
    expect(html).toContain('class="fd-row-meta"');
    expect(html).toContain('class="fd-row-abstract"');
    expect(html).toContain('href="/p/k3f9-q2xz-7mwd"');
    expect(html).toContain('href="/c/cs.AI"');
    expect(html).toContain('href="/c/cs.MA"');
    expect(html).toContain(">v2<");
    expect(html).toContain("Reviewed");
    expect(html).toContain("Preprint");
  });

  it("heads the page with the category", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render();

    expect(html).toMatch(/<h1[^>]*class="fd-category-title"[^>]*>cs\.AI<\/h1>/);
    expect(html).toContain("scholium / category");
    expect(html).toContain("Artificial Intelligence");
  });

  it("links to the category's Atom feed", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render();

    expect(html).toContain('rel="alternate"');
    expect(html).toContain('type="application/atom+xml"');
    expect(html).toContain('href="http://localhost:8000/v1/feeds/cs.AI"');
    expect(html).toContain("Atom feed");
  });

  it("offers the follow control, sending signed-out readers to sign in", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render();

    // The server cannot see the browser's in-memory session, so the first
    // render is the sign-in link; it returns to this exact category page.
    expect(html).toContain('href="/signin?next=%2Fc%2Fcs.AI"');
    expect(html).toContain("Follow");
  });

  it("returns not found for a category no paper is filed under", async () => {
    stubApi({ items: [], nextCursor: null });

    const thrown = await CategoryRoutePage({
      params: params("xx.FAKE"),
    }).catch((error: unknown) => error);

    // Next's `notFound()` throws a control-flow error carrying the marker.
    // Next 15 spells it as an HTTP 404 fallback; older builds use NOT_FOUND.
    expect(String((thrown as { digest?: string }).digest ?? "")).toMatch(
      /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it("still shows a category the taxonomy does not name when it has papers", async () => {
    stubApi({
      items: [{ ...ITEM, categories: ["astro-ph.HE"] }],
      nextCursor: null,
    });

    const html = await render("astro-ph.HE");

    expect(html).toContain(ITEM.title);
  });

  it("points the Atom link at the configured API origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.org");
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render();

    expect(html).toContain('href="https://api.example.org/v1/feeds/cs.AI"');
    vi.unstubAllEnvs();
  });

  it("shows no vote, like or score even when the payload carries one", async () => {
    stubApi({
      items: [{ ...ITEM, votes: 4173, likes: 982, score: 8.8, popularity: 0.91 }],
      nextCursor: null,
    });

    const html = await render();

    expect(html).toContain(ITEM.title);
    expect(html).not.toMatch(/4173|982|8\.8|0\.91/);
    expect(html.toLowerCase()).not.toMatch(/vote|upvote|\blikes?\b|popular|trending/);
  });

  it("says the category has no papers, with one way forward", async () => {
    stubApi({ items: [], nextCursor: null });

    const html = await render();

    expect(html).toContain("No papers are listed in cs.AI yet.");
    expect(html).toContain('href="/"');
    expect(html).toContain("See the latest papers");
  });

  it("keeps the heading and Atom link when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const html = await render();

    expect(html).toContain("Couldn’t reach the API");
    expect(html).toContain("cs.AI");
    expect(html).toContain("Atom feed");
    expect(html).not.toContain("No papers are listed");
  });

  it("renders a body that is not a paper list as an error, not an empty category", async () => {
    stubApi({ unexpected: true });

    const html = await render();

    expect(html).toContain("The API did not return a list of papers.");
    expect(html).not.toContain("No papers are listed");
  });

  it("does not ask the API for a category it cannot accept", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = await render("x".repeat(65));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("That is not a category on this node.");
    // Nothing to subscribe to, and nothing to follow.
    expect(html).not.toContain("application/atom+xml");
    expect(html).not.toContain("/signin?next=");
  });

  it("is rendered on demand, never prerendered with a baked-in error", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("category metadata", () => {
  it("names the category and its label in the title", async () => {
    const metadata = await generateMetadata({ params: params("cs.AI") });

    expect(metadata.title).toBe("cs.AI · Artificial Intelligence");
    expect(String(metadata.description)).toContain("Artificial Intelligence");
  });

  it("advertises the Atom feed as an alternate", async () => {
    const metadata = await generateMetadata({ params: params("cs.AI") });

    expect(metadata.alternates?.types).toEqual({
      "application/atom+xml": "http://localhost:8000/v1/feeds/cs.AI",
    });
  });

  it("falls back to a plain title for an unknown category", async () => {
    const metadata = await generateMetadata({ params: params("astro-ph.HE") });

    expect(metadata.title).toBe("astro-ph.HE");
  });
});
