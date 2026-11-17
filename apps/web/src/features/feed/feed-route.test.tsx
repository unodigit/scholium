// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import FeedLayout from "../../app/(feed)/layout";
import FeedRoutePage, { dynamic, metadata } from "../../app/(feed)/page";

// The layout mounts the global nav, which needs Next's app router. Rendering a
// layout outside Next has none, so stand in for the two modules that want it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children);
  return { default: Link };
});

/**
 * `/` is server-rendered: the first HTML response must already contain the
 * papers, so the home page works before any JavaScript runs. These tests
 * render the route with a stubbed `fetch`, the way `GET /v1/papers` answers.
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
  authors: [{ did: DID, author: DID, position: 1, creditRoles: null }],
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
  categories: ["cs.LG"],
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

function params(extra: Record<string, string | string[]> = {}) {
  return Promise.resolve(extra);
}

async function render(extra: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await FeedRoutePage({ searchParams: params(extra) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feed route (server render)", () => {
  it("puts the papers in the first HTML", async () => {
    const fetchMock = stubApi({ items: [ITEM, SECOND], nextCursor: null });

    const html = await render();

    expect(html).toContain(ITEM.title);
    expect(html).toContain(SECOND.title);
    expect(html).toContain(ITEM.abstract);
    expect(html).toContain('href="/p/k3f9-q2xz-7mwd"');
    expect(html).toContain('href="/c/cs.AI"');
    expect(html).toContain(">v2<");
    expect(html).toContain("Reviewed");
    expect(html).toContain("Preprint");

    const paperCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/v1/papers?"),
    );
    expect(paperCalls).toHaveLength(1);
    const url = String(paperCalls[0][0]);
    expect(url).toContain("/v1/papers?");
    expect(url).toContain("tab=latest");
    expect(url).toContain("sort=newest");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("category=");
    expect(url).not.toContain("cursor=");
  });

  it("shows author names read from their public profiles, not raw DIDs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/papers")) {
        return new Response(JSON.stringify({ items: [ITEM], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const did = decodeURIComponent(url.pathname.split("/profiles/")[1] ?? "");
      return new Response(JSON.stringify({ did, name: "Mei Zhang" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await render();

    expect(html).toContain("Mei Zhang");
    expect(html).not.toContain("z6Mkha…2doK");
  });

  it("falls back to the short DID when an author has no public profile", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/papers")) {
        return new Response(JSON.stringify({ items: [ITEM], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ title: "Not Found", status: 404 }),
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await render();

    expect(html).toContain("z6Mkha…2doK");
  });

  it("renders the three tabs and both selectors", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render();

    expect(html).toMatch(/<a[^>]*href="\/"[^>]*aria-current="page"[^>]*>Latest<\/a>/);
    expect(html).toContain(">Reviewed</a>");
    expect(html).toContain(">Following</a>");
    expect(html).toContain("Category");
    expect(html).toContain("All categories");
    expect(html).toContain("Sort");
    expect(html).toContain("Newest");
    expect(html).toContain("Recently reviewed");
    expect(html).toContain("Recently updated");
  });

  it("works without JavaScript: the selectors are a GET form with an Apply button", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render({ tab: "reviewed" });

    expect(html).toMatch(/<form[^>]*action="\/"[^>]*method="get"/);
    expect(html).toContain('<input type="hidden" name="tab" value="reviewed"/>');
    expect(html).toContain("<noscript><button");
    expect(html).toContain("Apply");
  });

  it("sends the tab, category and sort in the URL to the API", async () => {
    const fetchMock = stubApi({ items: [ITEM], nextCursor: null });

    await render({ tab: "reviewed", category: "cs.AI", sort: "recently_updated" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("tab=reviewed");
    expect(url).toContain("category=cs.AI");
    expect(url).toContain("sort=recently_updated");
  });

  it("marks the tab the URL names", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = await render({ tab: "reviewed" });

    expect(html).toMatch(/aria-current="page"[^>]*>Reviewed<\/a>/);
    expect(html).not.toMatch(/aria-current="page"[^>]*>Latest<\/a>/);
    expect(html).toContain("Reviewed papers");
  });

  it("falls back to the default view for a tab or sort the API does not serve", async () => {
    const fetchMock = stubApi({ items: [], nextCursor: null });

    await render({ tab: "trending", sort: "most_votes" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("tab=latest");
    expect(url).toContain("sort=newest");
  });

  it("offers a Show more button only when the API gave a next cursor", async () => {
    stubApi({ items: [ITEM], nextCursor: "eyJ2IjoxfQ" });
    expect(await render()).toContain("Show more papers");

    stubApi({ items: [ITEM], nextCursor: null });
    expect(await render()).not.toContain("Show more papers");
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

  it("says no papers are listed when the node has none", async () => {
    stubApi({ items: [], nextCursor: null });

    const html = await render();

    expect(html).toContain("No papers are listed yet.");
    expect(html).toContain("Submit a paper");
  });

  it("does not ask the API for Following on the server: it needs the browser's session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = await render({ tab: "following" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toMatch(/aria-current="page"[^>]*>Following<\/a>/);
    expect(html).toContain("Papers from categories you follow");
    // No flash of "sign in" at someone who is signed in: the browser decides.
    expect(html).not.toContain("Sign in to follow");
  });

  it("renders a retryable notice instead of throwing when the API is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const html = await render();

    expect(html).toContain("Couldn’t reach the API");
    expect(html).toContain("Try again");
    // The page around it stays usable.
    expect(html).toContain(">Reviewed</a>");
  });

  it("renders the API's own message for a refused request", async () => {
    stubApi(
      { type: "about:blank", title: "Internal Server Error", status: 500, detail: "The catalog is rebuilding." },
      500,
    );

    const html = await render();

    expect(html).toContain("The catalog is rebuilding.");
    expect(html).toContain("Try again");
  });

  it("treats a body that is not a paper list as an error, not an empty feed", async () => {
    stubApi({ unexpected: true });

    const html = await render();

    expect(html).toContain("The API did not return a list of papers.");
    expect(html).not.toContain("No papers are listed yet.");
  });

  it("renders for a request with no search params at all", async () => {
    stubApi({ items: [ITEM], nextCursor: null });

    const html = renderToStaticMarkup(await FeedRoutePage({}));

    expect(html).toContain(ITEM.title);
  });

  it("is rendered on demand, never prerendered with a baked-in error", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("has a title and a description", () => {
    expect(metadata.title).toBe("Home");
    expect(String(metadata.description)).toContain("no vote counts");
  });
});

describe("feed layout", () => {
  it("wraps the page in the global navigation and the feed shell", () => {
    const html = renderToStaticMarkup(
      FeedLayout({ children: <p>inside</p> }) as React.ReactElement,
    );

    expect(html).toContain("scholium");
    expect(html).toMatch(/<main class="fd-shell"><p>inside<\/p><\/main>/);
  });
});
