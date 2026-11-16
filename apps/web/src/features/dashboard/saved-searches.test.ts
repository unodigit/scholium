import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { parseSearchParams } from "../search-page/search";

import {
  SAVED_SEARCHES_ENDPOINT,
  SavedSearchError,
  deleteSavedSearch,
  describeSavedSearchError,
  loadSavedSearches,
  parseSavedSearches,
  savedSearchEndpoint,
  savedSearchFilters,
  savedSearchHref,
  savedSearchTitle,
} from "./saved-searches";

/** The body `POST /v1/me/saved-searches` documents, as one list row. */
const ROW = {
  id: "ss_0123",
  did: "did:key:z6Mk",
  query: {
    q: "pulsar timing",
    category: ["cs.CR"],
    status: ["reviewed"],
    has_code: true,
    from: "2026-03-02",
    to: "2026-04-01",
  },
};

describe("saved-search endpoints", () => {
  it("lists under /me/saved-searches and deletes one id beneath it", () => {
    expect(SAVED_SEARCHES_ENDPOINT).toBe("/me/saved-searches");
    expect(savedSearchEndpoint("ss_0123")).toBe("/me/saved-searches/ss_0123");
  });

  it("percent-encodes the id so it stays one path segment", () => {
    expect(savedSearchEndpoint("a/b c")).toBe("/me/saved-searches/a%2Fb%20c");
  });
});

describe("parseSavedSearches", () => {
  it("reads {items: [...]} and a bare array", () => {
    const expected = [
      {
        id: "ss_0123",
        query: {
          q: "pulsar timing",
          category: ["cs.CR"],
          status: ["reviewed"],
          has_code: true,
          from: "2026-03-02",
          to: "2026-04-01",
        },
      },
    ];
    expect(parseSavedSearches({ items: [ROW] })).toEqual(expected);
    expect(parseSavedSearches([ROW])).toEqual(expected);
  });

  it("reads an empty list as no saved searches", () => {
    expect(parseSavedSearches({ items: [] })).toEqual([]);
  });

  it("keeps only the filters it knows and drops blank values", () => {
    const [search] = parseSavedSearches([
      { id: "ss_1", query: { q: "  ", category: ["", " cs.AI "], extra: 1, has_code: "yes" } },
    ]);
    expect(search.query).toEqual({
      q: undefined,
      category: ["cs.AI"],
      status: undefined,
      has_code: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it("reads a single string where a list is expected", () => {
    const [search] = parseSavedSearches([{ id: "ss_1", query: { category: "cs.AI" } }]);
    expect(search.query.category).toEqual(["cs.AI"]);
  });

  it.each([null, undefined, "x", 3, {}, { items: "no" }])(
    "rejects a %j body rather than showing an empty list",
    (payload) => {
      expect(() => parseSavedSearches(payload)).toThrow(SavedSearchError);
    },
  );

  it.each([{ query: {} }, { id: "  ", query: {} }, "ss_1", null])(
    "rejects a row that could not be deleted: %j",
    (row) => {
      expect(() => parseSavedSearches([row])).toThrow(/Saved search 1 has no id/);
    },
  );
});

describe("savedSearchHref", () => {
  it("re-runs the search: every filter lands in the /search URL", () => {
    const [{ query }] = parseSavedSearches([ROW]);
    const href = savedSearchHref(query);
    expect(href.startsWith("/search?")).toBe(true);
    // Round-trip through the search page's own parser instead of matching a string.
    const params = Object.fromEntries(new URL(href, "http://x").searchParams.entries());
    expect(parseSearchParams(params)).toMatchObject({
      q: "pulsar timing",
      mode: "keyword",
      categories: ["cs.CR"],
      statuses: ["reviewed"],
      hasCode: true,
      dateFrom: "2026-03-02",
      dateTo: "2026-04-01",
    });
  });

  it("repeats a multi-valued filter and encodes the text", () => {
    const href = savedSearchHref({ q: "a&b c", category: ["cs.AI", "cs.CR"] });
    expect(href).toBe("/search?q=a%26b+c&category=cs.AI&category=cs.CR");
  });

  it("keeps has_code=false, which excludes code, distinct from not set", () => {
    expect(savedSearchHref({ has_code: false })).toBe("/search?has_code=false");
    expect(savedSearchHref({ category: ["cs.AI"] })).not.toContain("has_code");
  });
});

describe("savedSearchTitle and savedSearchFilters", () => {
  it("titles a search by its text and lists the other filters in a fixed order", () => {
    const [{ query }] = parseSavedSearches([ROW]);
    expect(savedSearchTitle(query)).toBe("pulsar timing");
    expect(savedSearchFilters(query)).toEqual([
      "cs.CR",
      "reviewed",
      "has code",
      "2026-03-02 – 2026-04-01",
    ]);
  });

  it("titles a filter-only search by its filters", () => {
    expect(savedSearchTitle({ category: ["cs.AI", "cs.CR"], has_code: false })).toBe(
      "cs.AI, cs.CR · no code",
    );
  });

  it("words a one-sided date range", () => {
    expect(savedSearchFilters({ from: "2026-03-02" })).toEqual(["from 2026-03-02"]);
    expect(savedSearchFilters({ to: "2026-04-01" })).toEqual(["to 2026-04-01"]);
  });

  it("still names a query with no filter this screen knows", () => {
    expect(savedSearchTitle({})).toBe("Saved search");
  });
});

describe("saved-search calls", () => {
  it("loads the list with an uncached GET", async () => {
    const get = vi.fn().mockResolvedValue({ items: [ROW] });
    const list = await loadSavedSearches({ get });
    expect(get).toHaveBeenCalledWith("/me/saved-searches", { cache: "no-store" });
    expect(list.map((search) => search.id)).toEqual(["ss_0123"]);
  });

  it("deletes with DELETE on the id", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await deleteSavedSearch("ss_0123", { delete: del });
    expect(del).toHaveBeenCalledWith("/me/saved-searches/ss_0123");
  });
});

describe("describeSavedSearchError", () => {
  it("passes the API's detail through", () => {
    expect(
      describeSavedSearchError(new ApiError(404, { detail: "No such saved search." }), "delete"),
    ).toBe("No such saved search.");
  });

  it("explains an unreachable API and falls back per action", () => {
    expect(describeSavedSearchError(new NetworkError("/v1/x"), "load")).toMatch(
      /could not reach the API/,
    );
    expect(describeSavedSearchError(null, "load")).toBe(
      "The API could not return your saved searches.",
    );
    expect(describeSavedSearchError(null, "delete")).toBe("Couldn’t delete this saved search.");
    expect(describeSavedSearchError(new SavedSearchError("bad list"), "load")).toBe("bad list");
  });
});
