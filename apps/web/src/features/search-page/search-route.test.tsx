// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import SearchRoutePage from "../../app/(search-page)/search/page";

/**
 * `/search` is server-rendered: the first HTML response must already contain
 * the matching papers, so a shared or reloaded `?q=` link works before any
 * JavaScript runs. These tests render the route with stubbed `fetch`.
 */

const HIT = {
  version_cid: "bafy-version-1",
  paper_cid: "bafy-paper-1",
  short_id: "sch:k3f9-q2xz-7mwd",
  n: 2,
  title: "Sparse arrays for pulsar timing",
  abstract: "A timing model that survives sparse sampling.",
  categories: ["astro-ph.HE"],
  status: "reviewed",
  listed_at: "2026-11-02T10:00:00Z",
  has_code: true,
  score: 1.25,
};

const KEYWORD = {
  query: "pulsar",
  total: 1,
  results: [HIT],
  facets: {
    category: { "astro-ph.HE": 1 },
    status: { reviewed: 1 },
  },
};

const SEMANTIC = {
  query: "pulsar",
  embedder: "hashing-v1-1024",
  results: [{ ...HIT, has_code: undefined, score: 0.61 }],
};

function stubApi(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function params(q: string, extra: Record<string, string | string[]> = {}) {
  return Promise.resolve({ q, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search route (server render)", () => {
  it("puts the matching papers a keyword search found in the first HTML", async () => {
    const fetchMock = stubApi(KEYWORD);

    const html = renderToStaticMarkup(
      await SearchRoutePage({ searchParams: params("pulsar") }),
    );

    expect(html).toContain("Search");
    expect(html).toContain(HIT.title);
    expect(html).toContain(HIT.abstract);
    expect(html).toContain("1 result for “pulsar”");
    expect(html).toContain("Reviewed");
    expect(html).toContain("Code available");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain("/v1/search?");
    expect(url).toContain("q=pulsar");
    expect(url).toContain("limit=20");
  });

  it("renders every facet filter", async () => {
    stubApi(KEYWORD);

    const html = renderToStaticMarkup(
      await SearchRoutePage({ searchParams: params("pulsar") }),
    );

    expect(html).toContain("Category");
    expect(html).toContain("astro-ph.HE");
    expect(html).toContain("Date listed");
    expect(html).toContain('type="date"');
    expect(html).toContain("Status");
    expect(html).toContain("Code available");
  });

  it("sends the facet filters to the API when the URL carries them", async () => {
    const fetchMock = stubApi(KEYWORD);

    await SearchRoutePage({
      searchParams: params("pulsar", {
        category: ["astro-ph.HE", "cs.LG"],
        status: "reviewed",
        has_code: "true",
        from: "2026-01-01",
        to: "2026-02-01",
      }),
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("category=astro-ph.HE");
    expect(url).toContain("category=cs.LG");
    expect(url).toContain("status=reviewed");
    expect(url).toContain("has_code=true");
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-02-01");
  });

  it("calls the semantic endpoint when ?semantic=1 is set", async () => {
    const fetchMock = stubApi(SEMANTIC);

    const html = renderToStaticMarkup(
      await SearchRoutePage({
        searchParams: params("pulsar", { semantic: "1" }),
      }),
    );

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/search/semantic");
    expect(url).toContain("q=pulsar");
    expect(html).toContain("by meaning");
    expect(html).toContain("Semantic match");
  });

  it("renders a retryable notice instead of throwing when the API is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const html = renderToStaticMarkup(
      await SearchRoutePage({ searchParams: params("pulsar") }),
    );

    expect(html).toContain("Couldn’t reach the API");
    expect(html).toContain("Try again");
  });

  it("sends a sch: id to the paper page instead of searching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const thrown = await SearchRoutePage({
      searchParams: params("sch:k3f9-q2xz-7mwd/v2"),
    }).catch((error: unknown) => error);

    // Next's `redirect()` throws a control-flow error carrying the target.
    const digest = String((thrown as { digest?: string }).digest ?? "");
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/p/sch%3Ak3f9-q2xz-7mwd/v2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a term instead of calling the API when q is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(await SearchRoutePage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Enter a term above to search the listed papers.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
