// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  EMPTY_SEARCH_STATE,
  clearFilters,
  describeSearchError,
  facetOptions,
  formatListedAt,
  hasActiveFilters,
  keywordQuery,
  loadKeywordSearch,
  loadSemanticSearch,
  paperHref,
  paperHrefForQuery,
  parseSchId,
  parseSearchParams,
  parseSearchResult,
  parseSemanticResult,
  resultHref,
  resultSummary,
  searchHref,
  searchStateKey,
  semanticQuery,
  statusOptions,
  toggleCategory,
  toggleStatus,
  type SearchClient,
  type SearchState,
} from "./search";

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

function state(overrides: Partial<SearchState> = {}): SearchState {
  return { ...EMPTY_SEARCH_STATE, q: "pulsar", ...overrides };
}

function fakeClient(payload: unknown): SearchClient & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => payload);
  return { get } as unknown as SearchClient & { get: ReturnType<typeof vi.fn> };
}

describe("parseSearchParams", () => {
  it("reads the query, both repeated filters, code and the semantic flag", () => {
    const parsed = parseSearchParams({
      q: "  pulsar timing ",
      category: ["astro-ph.HE", "cs.LG"],
      status: "reviewed",
      has_code: "true",
      from: "2026-01-01",
      to: "2026-12-31",
      semantic: "1",
    });

    expect(parsed).toEqual({
      q: "pulsar timing",
      mode: "semantic",
      categories: ["astro-ph.HE", "cs.LG"],
      statuses: ["reviewed"],
      hasCode: true,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
  });

  it("drops blank duplicates and values the API would reject", () => {
    const parsed = parseSearchParams({
      q: "pulsar",
      category: ["cs.LG", "cs.LG", " "],
      status: ["reviewed", ""],
      has_code: "maybe",
      from: "02/11/2026",
      to: "2026-11-02",
    });

    expect(parsed.categories).toEqual(["cs.LG"]);
    expect(parsed.statuses).toEqual(["reviewed"]);
    expect(parsed.hasCode).toBeNull();
    expect(parsed.dateFrom).toBe("");
    expect(parsed.dateTo).toBe("2026-11-02");
    expect(parsed.mode).toBe("keyword");
  });

  it("reads the date-filter aliases as well", () => {
    const parsed = parseSearchParams({
      q: "pulsar",
      date_from: "2026-03-01",
      date_to: "2026-03-31",
    });
    expect(parsed.dateFrom).toBe("2026-03-01");
    expect(parsed.dateTo).toBe("2026-03-31");
  });

  it("treats false as an active 'no code' filter", () => {
    expect(parseSearchParams({ q: "x", has_code: "false" }).hasCode).toBe(false);
  });
});

describe("searchHref", () => {
  it("carries every keyword filter in the URL", () => {
    const href = searchHref(
      state({
        categories: ["cs.LG", "cs.AI"],
        statuses: ["reviewed"],
        hasCode: false,
        dateFrom: "2026-01-01",
        dateTo: "2026-02-01",
      }),
    );

    const params = new URL(href, "http://example.test").searchParams;
    expect(href.startsWith("/search?")).toBe(true);
    expect(params.get("q")).toBe("pulsar");
    expect(params.getAll("category")).toEqual(["cs.LG", "cs.AI"]);
    expect(params.getAll("status")).toEqual(["reviewed"]);
    expect(params.get("has_code")).toBe("false");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
    expect(params.get("semantic")).toBeNull();
  });

  it("carries only q and semantic=1 in semantic mode", () => {
    const href = searchHref(
      state({ mode: "semantic", categories: ["cs.LG"], hasCode: true }),
    );
    const params = new URL(href, "http://example.test").searchParams;
    expect(params.get("q")).toBe("pulsar");
    expect(params.get("semantic")).toBe("1");
    expect(params.get("category")).toBeNull();
    expect(params.get("has_code")).toBeNull();
  });

  it("is bare /search with no terms", () => {
    expect(searchHref(EMPTY_SEARCH_STATE)).toBe("/search");
  });

  it("round-trips through parseSearchParams", () => {
    const original = state({
      categories: ["cs.LG"],
      statuses: ["preprint", "reviewed"],
      hasCode: true,
      dateFrom: "2026-01-01",
    });
    const params = new URL(searchHref(original), "http://example.test").searchParams;
    const input: Record<string, string[]> = {};
    params.forEach((value, key) => {
      (input[key] ??= []).push(value);
    });
    expect(parseSearchParams(input)).toEqual(original);
  });
});

describe("sch: ids in the search field", () => {
  it("recognises a paper id and a version id", () => {
    expect(parseSchId("sch:k3f9-q2xz-7mwd")).toEqual({
      shortId: "sch:k3f9-q2xz-7mwd",
      version: null,
    });
    expect(parseSchId("  SCH:K3F9-Q2XZ-7MWD/v3  ")).toEqual({
      shortId: "sch:k3f9-q2xz-7mwd",
      version: 3,
    });
  });

  it("does not mistake ordinary search terms for an id", () => {
    expect(parseSchId("pulsar timing")).toBeNull();
    expect(parseSchId("sch:nope")).toBeNull();
    expect(parseSchId("sch:k3f9-q2xz-7mwd/v0")).toBeNull();
    expect(parseSchId("title sch:k3f9-q2xz-7mwd")).toBeNull();
  });

  it("builds the paper page URL, percent-encoding the colon", () => {
    expect(paperHref({ shortId: "sch:k3f9-q2xz-7mwd", version: null })).toBe(
      "/p/sch%3Ak3f9-q2xz-7mwd",
    );
    expect(paperHref({ shortId: "sch:k3f9-q2xz-7mwd", version: 2 })).toBe(
      "/p/sch%3Ak3f9-q2xz-7mwd/v2",
    );
  });

  it("maps a query to the paper page only when it is an id", () => {
    expect(paperHrefForQuery("sch:abcd-efgh-jklm/v4")).toBe(
      "/p/sch%3Aabcd-efgh-jklm/v4",
    );
    expect(paperHrefForQuery("reward models")).toBeNull();
  });
});

describe("request building", () => {
  it("sends keyword filters under the names the API documents", () => {
    expect(
      keywordQuery(
        state({
          categories: ["cs.LG"],
          statuses: ["reviewed"],
          hasCode: true,
          dateFrom: "2026-01-01",
          dateTo: "2026-02-01",
        }),
      ),
    ).toEqual({
      q: "pulsar",
      limit: 20,
      category: ["cs.LG"],
      status: ["reviewed"],
      has_code: true,
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });

  it("omits unset filters", () => {
    expect(keywordQuery(state())).toEqual({ q: "pulsar", limit: 20 });
  });

  it("sends only q and limit to the semantic endpoint", () => {
    expect(semanticQuery(state({ mode: "semantic", statuses: ["reviewed"] }))).toEqual({
      q: "pulsar",
      limit: 20,
    });
  });

  it("refuses a blank query without calling the API", async () => {
    const client = fakeClient({});
    await expect(loadKeywordSearch(state({ q: "  " }), client)).rejects.toThrow(
      "Enter a search term.",
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("loads a keyword result from /search", async () => {
    const client = fakeClient({ query: "pulsar", total: 1, results: [HIT], facets: {} });
    const result = await loadKeywordSearch(state({ categories: ["cs.LG"] }), client);

    expect(client.get).toHaveBeenCalledTimes(1);
    const [path, options] = client.get.mock.calls[0];
    expect(path).toBe("/search");
    expect(options.query).toEqual({ q: "pulsar", limit: 20, category: ["cs.LG"] });
    expect(options.cache).toBe("no-store");
    expect(result.results[0]?.title).toBe(HIT.title);
  });

  it("loads a semantic result from /search/semantic", async () => {
    const client = fakeClient({ query: "pulsar", embedder: "hashing-v1-1024", results: [HIT] });
    const result = await loadSemanticSearch(state({ mode: "semantic" }), client);

    expect(client.get.mock.calls[0][0]).toBe("/search/semantic");
    expect(result.embedder).toBe("hashing-v1-1024");
  });
});

describe("response parsing", () => {
  it("maps the keyword response, facets included", () => {
    const result = parseSearchResult({
      query: "pulsar",
      total: 3,
      results: [HIT],
      facets: { category: { "astro-ph.HE": 3 }, status: { reviewed: 2, preprint: 1 } },
    });

    expect(result.total).toBe(3);
    expect(result.facets.category).toEqual({ "astro-ph.HE": 3 });
    expect(result.facets.status).toEqual({ reviewed: 2, preprint: 1 });
    expect(result.results[0]).toEqual({
      versionCid: HIT.version_cid,
      paperCid: HIT.paper_cid,
      shortId: HIT.short_id,
      n: 2,
      title: HIT.title,
      abstract: HIT.abstract,
      categories: ["astro-ph.HE"],
      status: "reviewed",
      listedAt: HIT.listed_at,
      hasCode: true,
      score: 1.25,
    });
  });

  it("falls back to the result count when total is absent", () => {
    expect(parseSearchResult({ results: [HIT] }).total).toBe(1);
  });

  it("keeps well-formed rows and drops malformed ones", () => {
    const result = parseSearchResult({
      results: [HIT, null, { abstract: "no title" }, 7],
    });
    expect(result.results).toHaveLength(1);
  });

  it("refuses a body that is not a result list", () => {
    expect(() => parseSearchResult({ results: "nope" })).toThrow(
      "The API did not return a result list.",
    );
    expect(() => parseSemanticResult([])).toThrow(
      "The API did not return a semantic result.",
    );
  });

  it("maps the semantic response and its embedder", () => {
    const result = parseSemanticResult({
      query: "pulsar",
      embedder: "hashing-v1-1024",
      results: [HIT],
    });
    expect(result.embedder).toBe("hashing-v1-1024");
    expect(result.results[0]?.versionCid).toBe(HIT.version_cid);
  });
});

describe("errors", () => {
  it("explains an unreachable semantic embedder", () => {
    const error = new ApiError(503, { status: 503, detail: "down" });
    expect(describeSearchError(error, "semantic")).toContain(
      "Semantic search is unavailable",
    );
    expect(describeSearchError(error, "keyword")).toBe("down");
  });

  it("uses the API's 422 detail", () => {
    const error = new ApiError(422, { status: 422, detail: "q must not be blank." });
    expect(describeSearchError(error)).toBe("q must not be blank.");
  });

  it("names a transport failure", () => {
    expect(describeSearchError(new NetworkError("http://api.test"))).toContain(
      "Couldn’t reach the API",
    );
  });
});

describe("display helpers", () => {
  it("links a result to its paper version", () => {
    expect(resultHref({ shortId: "sch:k3f9-q2xz-7mwd", paperCid: "p", versionCid: "v", n: 3 })).toBe(
      "/p/sch%3Ak3f9-q2xz-7mwd/v3",
    );
    expect(resultHref({ shortId: null, paperCid: "bafy-paper", versionCid: "v", n: 1 })).toBe(
      "/p/bafy-paper/v1",
    );
  });

  it("formats a listing date in UTC", () => {
    expect(formatListedAt("2026-11-02T23:30:00Z")).toBe("2 Nov 2026");
    expect(formatListedAt("not a date")).toBe("");
    expect(formatListedAt(null)).toBe("");
  });

  it("summarises results in the reader's words", () => {
    expect(resultSummary("pulsar", 1, "keyword")).toBe("1 result for “pulsar”");
    expect(resultSummary("pulsar", 0, "keyword")).toBe("0 results for “pulsar”");
    expect(resultSummary("pulsar", 2, "semantic")).toBe(
      "2 results by meaning for “pulsar”",
    );
  });

  it("keeps a selected facet visible when the narrowed answer no longer counts it", () => {
    const options = facetOptions({ "cs.LG": 2 }, ["cs.AI"]);
    expect(options).toEqual([
      { value: "cs.LG", count: 2 },
      { value: "cs.AI", count: 0 },
    ]);
  });

  it("orders statuses by reading order, then extras", () => {
    const values = statusOptions({ reviewed: 2, zzz: 1 }, []).map((o) => o.value);
    expect(values.slice(0, 6)).toEqual([
      "preprint",
      "under_review",
      "reviewed",
      "contested",
      "corrected",
      "retracted",
    ]);
    expect(values[6]).toBe("zzz");
  });
});

describe("filter state", () => {
  it("toggles a category in and out", () => {
    const once = toggleCategory(state(), "cs.LG");
    expect(once.categories).toEqual(["cs.LG"]);
    expect(toggleCategory(once, "cs.LG").categories).toEqual([]);
  });

  it("toggles a status in and out", () => {
    const once = toggleStatus(state(), "reviewed");
    expect(once.statuses).toEqual(["reviewed"]);
    expect(toggleStatus(once, "reviewed").statuses).toEqual([]);
  });

  it("knows when filters are active and clears them, keeping the query", () => {
    const filtered = state({ categories: ["cs.LG"], hasCode: true });
    expect(hasActiveFilters(state())).toBe(false);
    expect(hasActiveFilters(filtered)).toBe(true);
    expect(clearFilters(filtered)).toEqual(state());
  });

  it("keys a search independent of filter order", () => {
    expect(searchStateKey(state({ categories: ["cs.LG", "cs.AI"] }))).toBe(
      searchStateKey(state({ categories: ["cs.AI", "cs.LG"] })),
    );
  });
});
