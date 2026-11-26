// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchPage } from "./search-page";
import {
  EMPTY_SEARCH_STATE,
  type SearchResult,
  type SearchState,
  type SemanticResult,
} from "./search";

const HIT = {
  versionCid: "bafy-version-1",
  paperCid: "bafy-paper-1",
  shortId: "sch:k3f9-q2xz-7mwd",
  n: 2,
  title: "Sparse arrays for pulsar timing",
  abstract: "A timing model that survives sparse sampling.",
  authors: [
    { did: "did:key:z6Mkha", name: "M. Zhang" },
    { did: "did:key:z6MkOka", name: "A. Okafor" },
  ],
  categories: ["astro-ph.HE"],
  status: "reviewed",
  listedAt: "2026-11-02T10:00:00Z",
  hasCode: true,
  score: 1.25,
} as const;

const SECOND = {
  ...HIT,
  versionCid: "bafy-version-2",
  shortId: "sch:abcd-efgh-jklm",
  n: 1,
  title: "A quieter model of the same pulsar",
  abstract: "Fewer parameters, the same timing residuals.",
  status: "preprint",
  hasCode: false,
} as const;

const RESULT: SearchResult = {
  query: "pulsar",
  total: 2,
  results: [HIT, SECOND],
  facets: {
    category: { "astro-ph.HE": 2, "cs.LG": 1 },
    status: { reviewed: 1, preprint: 1 },
  },
};

const SEMANTIC: SemanticResult = {
  query: "pulsar",
  embedder: "hashing-v1-1024",
  results: [SECOND, HIT],
};

function state(overrides: Partial<SearchState> = {}): SearchState {
  return { ...EMPTY_SEARCH_STATE, q: "pulsar", ...overrides };
}

// The journeys ran in a GMT+11 browser, east of UTC: the zone where search
// results and paper pages disagreed on the day of the same instant. Pinned so
// the date assertion below holds whatever zone the suite runs in.
process.env.TZ = "Australia/Sydney";

afterEach(cleanup);

describe("SearchPage with server data", () => {
  it("shows the term, the result count and every result", () => {
    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "2 results for “pulsar”",
    );

    for (const hit of RESULT.results) {
      expect(
        screen.getByRole("heading", { level: 2, name: hit.title }),
      ).toBeTruthy();
      expect(screen.getByText(hit.abstract)).toBeTruthy();
    }
  });

  it("links each result to its paper version", () => {
    render(
      <SearchPage initialState={state()} initialResult={RESULT} updateUrl={vi.fn()} />,
    );

    expect(
      screen.getByRole("link", { name: HIT.title }).getAttribute("href"),
    ).toBe("/p/sch%3Ak3f9-q2xz-7mwd/v2");
  });

  it("shows the author line the feed shows", () => {
    const { container } = render(
      <SearchPage initialState={state()} initialResult={RESULT} updateUrl={vi.fn()} />,
    );

    // One byline per result. Each name is its own link, so the line is read
    // from the element's text rather than from a single text node.
    const bylines = [...container.querySelectorAll(".sp-result-authors")].map(
      (line) => line.textContent,
    );
    expect(bylines).toEqual(["M. Zhang, A. Okafor", "M. Zhang, A. Okafor"]);
  });

  it("links each author name to their profile, in byline order", () => {
    render(
      <SearchPage initialState={state()} initialResult={RESULT} updateUrl={vi.fn()} />,
    );

    const row = screen
      .getByRole("heading", { level: 2, name: HIT.title })
      .closest("li") as HTMLElement;
    const authorLinks = within(row)
      .getAllByRole("link")
      .filter((link) => (link.getAttribute("href") ?? "").startsWith("/u/"));

    expect(
      authorLinks.map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["M. Zhang", "/u/did%3Akey%3Az6Mkha"],
      ["A. Okafor", "/u/did%3Akey%3Az6MkOka"],
    ]);
  });

  it("links a name-less author by their short DID", () => {
    const nameless = {
      ...HIT,
      authors: [{ did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", name: null }],
    };
    render(
      <SearchPage
        initialState={state()}
        initialResult={{ ...RESULT, total: 1, results: [nameless] }}
        updateUrl={vi.fn()}
      />,
    );

    const link = screen.getByRole("link", { name: "z6Mkha…2doK" });
    expect(link.getAttribute("href")).toBe(
      "/u/did%3Akey%3Az6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    );
  });

  it("names the first two of four authors as links and counts the rest", () => {
    const many = {
      ...HIT,
      authors: ["A", "B", "C", "D"].map((name) => ({
        did: `did:key:z6Mk${name}`,
        name: `Author ${name}`,
      })),
    };
    const { container } = render(
      <SearchPage
        initialState={state()}
        initialResult={{ ...RESULT, total: 1, results: [many] }}
        updateUrl={vi.fn()}
      />,
    );

    const line = container.querySelector(".sp-result-authors") as HTMLElement;
    expect(line.textContent).toBe("Author A, Author B, +2");
    expect(
      [...line.querySelectorAll("a")].map((link) => link.textContent),
    ).toEqual(["Author A", "Author B"]);
    expect(line.getAttribute("title")).toBe("Author A, Author B, Author C, Author D");
  });

  it("shows no byline for a result with no authors", () => {
    const { container } = render(
      <SearchPage
        initialState={state()}
        initialResult={{ ...RESULT, total: 1, results: [{ ...HIT, authors: [] }] }}
        updateUrl={vi.fn()}
      />,
    );

    expect(container.querySelector(".sp-result-authors")).toBeNull();
    expect(container.querySelector(".sp-result-meta")?.textContent).toContain("v2");
  });

  it("dates a result the way the paper page does: the reader's zone, the API's zone-less timestamp read as UTC", () => {
    // No zone designator: the API's UTC convention. 04:53 UTC on 18 November
    // is 15:53 the same day in Sydney (UTC+11), so the search page must say
    // 18 Nov — the day the paper page names for the same instant — not the
    // UTC day of an instant misread as Sydney local time (17 Nov).
    const { container } = render(
      <SearchPage
        initialState={state()}
        initialResult={{
          ...RESULT,
          total: 1,
          results: [{ ...HIT, listedAt: "2026-11-18T04:53:41" }],
        }}
        updateUrl={vi.fn()}
      />,
    );

    const listed = container.querySelector(".sp-result-meta time");
    expect(listed?.textContent).toBe("18 Nov 2026");
    expect(listed?.getAttribute("datetime")).toBe("2026-11-18T04:53:41");
  });

  it("offers Save this search for the query on screen", () => {
    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
        signedIn
        saveSearch={vi.fn().mockResolvedValue({ id: "ss_1", query: {} })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Save this search" }),
    ).toBeTruthy();
  });

  it("does not offer Save this search before there is a search", () => {
    render(<SearchPage initialState={EMPTY_SEARCH_STATE} updateUrl={vi.fn()} />);

    expect(screen.queryByText("Save this search")).toBeNull();
  });

  it("shows status and code badges without relying on colour", () => {
    render(
      <SearchPage initialState={state()} initialResult={RESULT} updateUrl={vi.fn()} />,
    );

    expect(screen.getAllByText("Reviewed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Preprint").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("⌥ Code available")).toHaveLength(1);
  });

  it("offers facet filters with the API's counts", () => {
    render(
      <SearchPage initialState={state()} initialResult={RESULT} updateUrl={vi.fn()} />,
    );

    expect(screen.getByRole("checkbox", { name: /astro-ph\.HE\s*2/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /cs\.LG\s*1/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Reviewed\s*1/ })).toBeTruthy();
    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
    expect(screen.getByLabelText("Code available")).toBeTruthy();  });

  it("shows the empty state for a term nothing matches", () => {
    render(
      <SearchPage
        initialState={state()}
        initialResult={{ ...RESULT, total: 0, results: [] }}
        updateUrl={vi.fn()}
      />,
    );

    expect(screen.getByText("No listed papers match this search.")).toBeTruthy();
    expect(screen.queryByText(HIT.title)).toBeNull();
  });

  it("prompts for a term when the URL has no q", () => {
    render(<SearchPage initialState={EMPTY_SEARCH_STATE} updateUrl={vi.fn()} />);

    expect(
      screen.getByText("Enter a term above to search the listed papers."),
    ).toBeTruthy();
  });
});

describe("SearchPage filters", () => {
  it("adds a category to the URL and asks the API for it", async () => {
    const updateUrl = vi.fn();
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={updateUrl}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));

    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ categories: ["cs.LG"] });
    expect(updateUrl).toHaveBeenCalledWith(
      expect.stringContaining("category=cs.LG"),
      "replace",
    );
  });

  it("removes a category when its checkbox is cleared", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state({ categories: ["cs.LG"] })}
        initialResult={RESULT}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /cs\.LG/ });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);

    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ categories: [] });
  });

  it("sends the date range as from/to", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-01-01" },
    });

    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ dateFrom: "2026-01-01" });
  });

  it("sends the code filter as has_code", async () => {
    const updateUrl = vi.fn();
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={updateUrl}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.click(screen.getByLabelText("Code available"));

    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ hasCode: true });
    expect(updateUrl).toHaveBeenCalledWith(
      expect.stringContaining("has_code=true"),
      "replace",
    );
  });

  it("clears every filter at once", () => {
    const updateUrl = vi.fn();

    render(
      <SearchPage
        initialState={state({ categories: ["cs.LG"], statuses: ["reviewed"], hasCode: true })}
        initialResult={RESULT}
        updateUrl={updateUrl}
        loadKeyword={vi.fn(async (_next: SearchState) => RESULT)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(updateUrl).toHaveBeenCalledWith("/search?q=pulsar", "replace");
  });
});

describe("SearchPage facets across queries", () => {
  const NARROWER: SearchResult = {
    query: "1260 tasks",
    total: 1,
    results: [
      {
        ...HIT,
        versionCid: "bafy-version-3",
        title: "Doing 1260 tasks at once",
        categories: ["cs.AI"],
        status: "under_review",
      },
    ],
    facets: {
      category: { "cs.AI": 1 },
      status: { under_review: 1 },
    },
  };

  it("lists only the new answer's facet values and counts after a new search", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => NARROWER);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    // The first search's categories are on screen before the second one.
    expect(screen.getByRole("checkbox", { name: /cs\.LG\s*1/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "1260 tasks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // The second answer's values, with its counts.
    expect(
      await screen.findByRole("checkbox", { name: /cs\.AI\s*1/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /Under review\s*1/ }),
    ).toBeTruthy();

    // The first answer's categories are gone rather than carried over.
    expect(screen.queryByRole("checkbox", { name: /cs\.LG/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /astro-ph\.HE/ })).toBeNull();

    // Status rows are always listed, but the old counts must not survive.
    expect(
      screen.queryByRole("checkbox", { name: /Reviewed\s*1/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /Preprint\s*1/ }),
    ).toBeNull();
  });

  it("drops the previous query's facets when the route answers a new query", () => {
    const { rerender } = render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /cs\.LG\s*1/ })).toBeTruthy();

    // The header's search box submits to the route, so the next answer
    // arrives as new initial props rather than through the page's own loader.
    rerender(
      <SearchPage
        initialState={state({ q: "1260 tasks" })}
        initialResult={NARROWER}
        updateUrl={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /cs\.AI\s*1/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /cs\.LG/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /astro-ph\.HE/ })).toBeNull();
  });

  it("drops the previous keyword facets when the mode changes", async () => {
    const loadSemantic = vi.fn(async (_next: SearchState) => SEMANTIC);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={vi.fn()}
        loadSemantic={loadSemantic}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /cs\.LG\s*1/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Semantic" }));

    await waitFor(() => expect(loadSemantic).toHaveBeenCalledTimes(1));

    // Semantic answers carry no facets, and the keyword answer's must not
    // remain listed beside them.
    expect(screen.queryByRole("checkbox", { name: /cs\.LG/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /astro-ph\.HE/ })).toBeNull();
  });

  // "Rafael Silva": three papers. The API counts each facet over the matches
  // that pass every filter except that facet's own, so with cs.LG ticked the
  // category column still counts cs.AI and cs.MA, while the status column
  // counts only the one cs.LG paper.
  const RAFAEL_ALL: SearchResult = {
    query: "Rafael Silva",
    total: 3,
    results: [
      { ...HIT, versionCid: "bafy-r-1", title: "Rafael one", status: "under_review" },
      { ...HIT, versionCid: "bafy-r-2", title: "Rafael two", status: "corrected" },
      { ...HIT, versionCid: "bafy-r-3", title: "Rafael three", status: "preprint" },
    ],
    facets: {
      category: { "cs.AI": 2, "cs.LG": 1, "cs.MA": 1 },
      status: { under_review: 1, corrected: 1, preprint: 1 },
    },
  };
  const RAFAEL_LG: SearchResult = {
    query: "Rafael Silva",
    total: 1,
    results: [
      { ...HIT, versionCid: "bafy-r-1", title: "Rafael one", status: "under_review" },
    ],
    facets: {
      category: { "cs.AI": 2, "cs.LG": 1, "cs.MA": 1 },
      status: { under_review: 1 },
    },
  };

  function renderRafael(loadKeyword: (next: SearchState) => Promise<SearchResult>) {
    return render(
      <SearchPage
        initialState={state({ q: "Rafael Silva" })}
        initialResult={RAFAEL_ALL}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
  }

  /** A promise whose answer the test releases when it wants to. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it("keeps the previous values and counts while the next answer for the same query loads", async () => {
    const answer = deferred<SearchResult>();
    const loadKeyword = vi.fn(() => answer.promise);
    renderRafael(loadKeyword);

    const categoryGroup = screen.getByRole("group", { name: "Category" });
    const statusGroup = screen.getByRole("group", { name: "Status" });
    expect(categoryGroup.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));

    // Until the answer arrives the column keeps the previous answer's values
    // and counts (no collapse then re-expand), with the tick applied, and the
    // groups say they are updating.
    const lg = screen.getByRole("checkbox", { name: /cs\.LG\s*1/ }) as HTMLInputElement;
    expect(lg.checked).toBe(true);
    expect(screen.getByRole("checkbox", { name: /cs\.AI\s*2/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /cs\.MA\s*1/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Preprint\s*1/ })).toBeTruthy();
    expect(categoryGroup.getAttribute("aria-busy")).toBe("true");
    expect(statusGroup.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      answer.resolve(RAFAEL_LG);
    });

    // The new answer's counts replace the old ones, and the column settles.
    await screen.findByRole("checkbox", { name: /Under review\s*1/ });
    expect(screen.queryByRole("checkbox", { name: /Preprint/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /cs\.AI\s*2/ })).toBeTruthy();
    expect(categoryGroup.getAttribute("aria-busy")).toBe("false");
    expect(statusGroup.getAttribute("aria-busy")).toBe("false");
  });

  it("lists only the selected values while a new query's first answer loads", async () => {
    const answer = deferred<SearchResult>();
    const loadKeyword = vi.fn(() => answer.promise);
    renderRafael(loadKeyword);

    expect(screen.getByRole("checkbox", { name: /cs\.LG\s*1/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "1260 tasks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));

    // Nothing from the previous query's answer is carried into the new query.
    expect(screen.queryByRole("checkbox", { name: /cs\.LG/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /cs\.AI/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Preprint/ })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Category" }).getAttribute("aria-busy"),
    ).toBe("true");

    await act(async () => {
      answer.resolve(NARROWER);
    });

    await screen.findByRole("checkbox", { name: /cs\.AI\s*1/ });
    expect(
      screen.getByRole("group", { name: "Category" }).getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("within one query, selecting a category still lists the others, from the answer's own counts", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RAFAEL_LG);
    renderRafael(loadKeyword);

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));

    // The answer's disjunctive counts keep cs.AI and cs.MA listed, with the
    // counts that ticking them would add.
    expect(
      await screen.findByRole("checkbox", { name: /cs\.AI\s*2/ }),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /cs\.MA\s*1/ })).toBeTruthy();
    const lg = screen.getByRole("checkbox", { name: /cs\.LG\s*1/ });
    expect((lg as HTMLInputElement).checked).toBe(true);
    expect(loadKeyword).toHaveBeenCalledTimes(1);
  });

  it("does not list a status the current answer lacks, unless it is selected", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RAFAEL_LG);
    renderRafael(loadKeyword);

    // Before the filter every status of the first answer is listed.
    expect(screen.getByRole("checkbox", { name: /Preprint\s*1/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    await screen.findByRole("checkbox", { name: /Under review\s*1/ });

    // Ticking "Preprint 1" would give 0 results, so it is not offered; nor is
    // any other status the answer does not count — not even with no count.
    expect(screen.queryByRole("checkbox", { name: /Preprint/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Corrected/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Reviewed/ })).toBeNull();
  });

  it("offers only values that give a result when ticked", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RAFAEL_LG);
    renderRafael(loadKeyword);

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    await screen.findByRole("checkbox", { name: /Under review\s*1/ });

    const aside = screen.getByRole("complementary", { name: "Search filters" });
    const unselected = (
      within(aside).getAllByRole("checkbox") as HTMLInputElement[]
    ).filter((box) => !box.checked && box.id !== "sp-code");
    expect(unselected.length).toBeGreaterThan(0);
    for (const box of unselected) {
      // Every listed, unselected value carries a count of at least one.
      expect(box.labels?.[0]?.textContent ?? "").toMatch(/[1-9]\d*$/);
    }
  });

  it("keeps a selected category the answer lacks listed, so it can be unticked", async () => {
    // cs.MA is selected but the answer (a date filter, say) no longer counts it.
    const loadKeyword = vi.fn(async (_next: SearchState) => RAFAEL_ALL);
    render(
      <SearchPage
        initialState={state({ q: "Rafael Silva", categories: ["cs.MA"] })}
        initialResult={{
          ...RAFAEL_ALL,
          total: 0,
          results: [],
          facets: { category: { "cs.AI": 2 }, status: {} },
        }}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    const ma = screen.getByRole("checkbox", { name: /cs\.MA/ }) as HTMLInputElement;
    expect((ma as HTMLInputElement).checked).toBe(true);
    // No stale count is shown for it.
    expect(ma.labels?.[0]?.textContent).toBe("cs.MA");

    fireEvent.click(ma);
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ categories: [] });
  });

  it("keeps a selected status the answer lacks listed, so it can be unticked", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RAFAEL_ALL);
    render(
      <SearchPage
        initialState={state({ q: "Rafael Silva", statuses: ["retracted"] })}
        initialResult={{
          ...RAFAEL_ALL,
          total: 0,
          results: [],
          facets: { category: { "cs.AI": 2 }, status: { preprint: 1 } },
        }}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    const retracted = screen.getByRole("checkbox", {
      name: /Retracted/,
    }) as HTMLInputElement;
    expect((retracted as HTMLInputElement).checked).toBe(true);
    expect(retracted.labels?.[0]?.textContent).toBe("Retracted");
    // A status that is neither counted nor selected is not listed.
    expect(screen.queryByRole("checkbox", { name: /Corrected/ })).toBeNull();

    fireEvent.click(retracted);
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ statuses: [] });
  });

  it("shows the answer's own values after each filter step, never an earlier answer's", async () => {
    const answers = [RAFAEL_LG, RAFAEL_ALL];
    const loadKeyword = vi.fn(async (_next: SearchState) => answers.shift()!);
    renderRafael(loadKeyword);

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    await screen.findByRole("checkbox", { name: /Under review\s*1/ });
    expect(screen.queryByRole("checkbox", { name: /Preprint/ })).toBeNull();

    // Unticking cs.LG widens the answer again, and its statuses come back
    // with it: they are read from the answer, not remembered.
    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("checkbox", { name: /Preprint\s*1/ }),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Corrected\s*1/ })).toBeTruthy();
  });
});

describe("SearchPage results while the next answer loads", () => {
  // One query's answer, and the narrower answer a filter tick asks for. The
  // page keeps the first on screen (stale-while-loading) so a scrolled list
  // does not collapse to one "Searching…" line and jump the page.
  const RAFAEL_FIRST: SearchResult = {
    query: "Rafael Silva",
    total: 2,
    results: [
      {
        ...HIT,
        versionCid: "bafy-stale-1",
        title: "Rafael one",
        categories: ["cs.AI"],
        status: "under_review",
      },
      {
        ...HIT,
        versionCid: "bafy-stale-2",
        title: "Rafael two",
        categories: ["cs.MA"],
        status: "corrected",
      },
    ],
    facets: {
      category: { "cs.AI": 1, "cs.LG": 1, "cs.MA": 1 },
      status: { under_review: 1, corrected: 1 },
    },
  };
  const RAFAEL_FILTERED: SearchResult = {
    query: "Rafael Silva",
    total: 1,
    results: [
      {
        ...HIT,
        versionCid: "bafy-stale-1",
        title: "Rafael one",
        categories: ["cs.LG"],
        status: "under_review",
      },
    ],
    facets: { category: { "cs.LG": 1 }, status: { under_review: 1 } },
  };
  const NEW_QUERY: SearchResult = {
    query: "1260 tasks",
    total: 1,
    results: [{ ...HIT, versionCid: "bafy-new", title: "Doing 1260 tasks at once" }],
    facets: { category: { "cs.AI": 1 }, status: { reviewed: 1 } },
  };

  /** A promise whose answer the test releases when it wants to. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  function renderRafael(
    loadKeyword: (next: SearchState) => Promise<SearchResult>,
  ) {
    return render(
      <SearchPage
        initialState={state({ q: "Rafael Silva" })}
        initialResult={RAFAEL_FIRST}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
  }

  it("keeps the previous results on screen, marked busy, while a filter change loads", async () => {
    const answer = deferred<SearchResult>();
    const loadKeyword = vi.fn(() => answer.promise);
    const { container } = renderRafael(loadKeyword);

    expect(screen.getByText("2 results for “Rafael Silva”")).toBeTruthy();
    const list = container.querySelector(".sp-result-list") as HTMLElement;
    expect(list).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));

    // The same list stays mounted with the same rows: nothing collapses to
    // "Searching…", so the page height holds and a scrolled page does not jump.
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(container.querySelector(".sp-result-list")).toBe(list);
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Rafael one" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Rafael two" })).toBeTruthy();
    // A polite status says the list is being updated. It replaces the count in
    // the same one-line element, so the status itself adds no height.
    const summary = container.querySelector(".sp-summary") as HTMLElement;
    expect(summary.getAttribute("role")).toBe("status");
    expect(summary.textContent).toBe("Updating results…");

    await act(async () => {
      answer.resolve(RAFAEL_FILTERED);
    });

    // The answer replaces the stale rows and the list settles.
    await screen.findByText("1 result for “Rafael Silva”");
    expect(list.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("heading", { level: 2, name: "Rafael two" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Rafael one" })).toBeTruthy();
  });

  it("shows “Searching…” without the previous query's results when a new query loads", async () => {
    const answer = deferred<SearchResult>();
    const loadKeyword = vi.fn(() => answer.promise);
    const { container } = renderRafael(loadKeyword);

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "1260 tasks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));

    // Another query's answer is not this query's answer: keep today's
    // "Searching…" and never show the earlier query's rows or count.
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText("Updating results…")).toBeNull();
    expect(container.querySelector(".sp-result-list")).toBeNull();
    expect(container.querySelector(".sp-summary")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Rafael one" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Rafael two" })).toBeNull();

    await act(async () => {
      answer.resolve(NEW_QUERY);
    });

    expect(await screen.findByText("1 result for “1260 tasks”")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Doing 1260 tasks at once" }),
    ).toBeTruthy();
  });

  it("shows “Searching…” without the previous results when the mode changes", async () => {
    const answer = deferred<SemanticResult>();
    const loadSemantic = vi.fn(() => answer.promise);
    const { container } = render(
      <SearchPage
        initialState={state({ q: "Rafael Silva" })}
        initialResult={RAFAEL_FIRST}
        updateUrl={vi.fn()}
        loadSemantic={loadSemantic}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Semantic" }));
    await waitFor(() => expect(loadSemantic).toHaveBeenCalledTimes(1));

    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(container.querySelector(".sp-result-list")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Rafael one" })).toBeNull();

    await act(async () => {
      answer.resolve(SEMANTIC);
    });
  });
});

describe("SearchPage back and forward", () => {
  // The page's own box records its search with `history.pushState`, while the
  // header box goes through the Next router, which re-renders this component
  // with the route's `initialState`. On Back/Forward the router can hand down
  // the search the page was *first loaded with* rather than the one in the
  // address bar (the reported bug: an empty page, or the query from the first
  // load). These tests reproduce those steps with the props the router passes.
  const PAGE_BOX_HREF = "/search?q=Rafael+Silva";
  const HEADER_HREF = "/search?q=1260+tasks";

  const PAGE_BOX_ANSWER: SearchResult = {
    query: "Rafael Silva",
    total: 0,
    results: [],
    facets: { category: {}, status: {} },
  };

  const HEADER_ANSWER: SearchResult = {
    query: "1260 tasks",
    total: 1,
    results: [{ ...HIT, title: "Doing 1260 tasks at once" }],
    facets: { category: { "cs.AI": 1 }, status: { reviewed: 1 } },
  };

  const CALIBRATION_ANSWER: SearchResult = {
    ...HEADER_ANSWER,
    query: "calibration",
    results: [{ ...HIT, title: "Calibration of a timing model" }],
  };

  function answerFor(next: SearchState): SearchResult {
    switch (next.q) {
      case "Rafael Silva":
        return PAGE_BOX_ANSWER;
      case "1260 tasks":
        return HEADER_ANSWER;
      default:
        return CALIBRATION_ANSWER;
    }
  }

  /**
   * The browser moves to `href` and fires what Back/Forward fires. The
   * component's popstate listener runs inside `act`, so its state update and
   * the fetch it starts are committed before the caller re-renders with the
   * (possibly stale) route props.
   */
  function travel(href: string): void {
    window.history.pushState(null, "", href);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }

  /** Type a term in the page's own box and submit it. */
  function searchFromPageBox(term: string): void {
    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: term },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
  }

  it("shows the URL's search after Back to a page-box search, not the empty search the page was loaded with", async () => {
    window.history.replaceState(null, "", "/search");
    const loadKeyword = vi.fn(async (next: SearchState) => answerFor(next));

    const { rerender } = render(
      <SearchPage
        initialState={EMPTY_SEARCH_STATE}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(
      screen.getByText("Enter a term above to search the listed papers."),
    ).toBeTruthy();

    // 1. A full load of /search, then "Rafael Silva" in the page's own box:
    // one history entry, answered by the browser-side loader.
    searchFromPageBox("Rafael Silva");
    expect(
      await screen.findByText("No listed papers match this search."),
    ).toBeTruthy();
    window.history.pushState(null, "", PAGE_BOX_HREF);

    // 2. "1260 tasks" in the header box: the router re-renders the page with
    // the new search and its server answer.
    window.history.pushState(null, "", HEADER_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "1260 tasks" })}
        initialResult={HEADER_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(await screen.findByText("1 result for “1260 tasks”")).toBeTruthy();

    // 3. Back: the address bar returns to the page-box search, but the router
    // hands down the search the page was first loaded with — empty.
    travel(PAGE_BOX_HREF);
    rerender(
      <SearchPage
        initialState={EMPTY_SEARCH_STATE}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    // The box, the heading and the results all describe the URL's query.
    expect(
      (screen.getByLabelText("Search papers") as HTMLInputElement).value,
    ).toBe("Rafael Silva");
    expect(
      await screen.findByText("0 results for “Rafael Silva”"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Enter a term above to search the listed papers."),
    ).toBeNull();
    expect(screen.queryByText("1 result for “1260 tasks”")).toBeNull();
  });

  it("shows the URL's search after Back when the page was loaded with another query", async () => {
    window.history.replaceState(null, "", "/search?q=calibration");
    const loadKeyword = vi.fn(async (next: SearchState) => answerFor(next));

    const { rerender } = render(
      <SearchPage
        initialState={state({ q: "calibration" })}
        initialResult={CALIBRATION_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(screen.getByText("1 result for “calibration”")).toBeTruthy();

    searchFromPageBox("Rafael Silva");
    expect(
      await screen.findByText("No listed papers match this search."),
    ).toBeTruthy();
    window.history.pushState(null, "", PAGE_BOX_HREF);

    window.history.pushState(null, "", HEADER_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "1260 tasks" })}
        initialResult={HEADER_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(await screen.findByText("1 result for “1260 tasks”")).toBeTruthy();

    // Back: the route still describes the first load (calibration).
    travel(PAGE_BOX_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "calibration" })}
        initialResult={CALIBRATION_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    expect(
      (screen.getByLabelText("Search papers") as HTMLInputElement).value,
    ).toBe("Rafael Silva");
    expect(
      await screen.findByText("0 results for “Rafael Silva”"),
    ).toBeTruthy();
    expect(screen.queryByText("1 result for “calibration”")).toBeNull();
    expect(screen.queryByText("Calibration of a timing model")).toBeNull();
  });

  it("returns to the later header search on Forward, whatever the route props say", async () => {
    window.history.replaceState(null, "", "/search?q=calibration");
    const loadKeyword = vi.fn(async (next: SearchState) => answerFor(next));

    const { rerender } = render(
      <SearchPage
        initialState={state({ q: "calibration" })}
        initialResult={CALIBRATION_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    // Page-box search, then a header-box search: two more history entries.
    searchFromPageBox("Rafael Silva");
    expect(
      await screen.findByText("No listed papers match this search."),
    ).toBeTruthy();
    window.history.pushState(null, "", PAGE_BOX_HREF);
    window.history.pushState(null, "", HEADER_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "1260 tasks" })}
        initialResult={HEADER_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(await screen.findByText("1 result for “1260 tasks”")).toBeTruthy();

    // Back to the page-box search.
    travel(PAGE_BOX_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "calibration" })}
        initialResult={CALIBRATION_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );
    expect(await screen.findByText("0 results for “Rafael Silva”")).toBeTruthy();

    // Forward to "1260 tasks": the URL wins over the stale route props too.
    travel(HEADER_HREF);
    rerender(
      <SearchPage
        initialState={state({ q: "calibration" })}
        initialResult={CALIBRATION_ANSWER}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    expect(
      (screen.getByLabelText("Search papers") as HTMLInputElement).value,
    ).toBe("1260 tasks");
    expect(await screen.findByText("1 result for “1260 tasks”")).toBeTruthy();
    expect(screen.queryByText("1 result for “calibration”")).toBeNull();
  });
});

describe("SearchPage address-bar announcement", () => {
  // The header search box knows only that the address bar moved through
  // `history.pushState`/`replaceState`, which fires no event of its own. The
  // page announces each `/search` rewrite on `window` so the header can follow
  // a search typed in the page's own box. The bug: a page-box search moved the
  // results but never told the header, which kept showing the query the page
  // was loaded with (or nothing).
  const EVENT = "scholium:search-url-changed";

  function listen(): { readings: string[]; stop: () => void } {
    const readings: string[] = [];
    const listener = (): void => {
      // Read at dispatch time: the URL must already be the new one.
      readings.push(window.location.search);
    };
    window.addEventListener(EVENT, listener);
    return {
      readings,
      stop: () => window.removeEventListener(EVENT, listener),
    };
  }

  it("announces a page-box search once, after the URL is rewritten", async () => {
    window.history.replaceState(null, "", "/search?q=calibration");
    const { readings, stop } = listen();
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);
    try {
      render(
        <SearchPage
          initialState={state({ q: "calibration" })}
          initialResult={RESULT}
          loadKeyword={loadKeyword}
        />,
      );

      fireEvent.change(screen.getByLabelText("Search papers"), {
        target: { value: "Rafael Silva" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      await waitFor(() => expect(readings).toEqual(["?q=Rafael+Silva"]));
    } finally {
      stop();
    }
  });

  it("announces a filter change (replace) once", async () => {
    window.history.replaceState(null, "", "/search?q=pulsar");
    const { readings, stop } = listen();
    try {
      render(
        <SearchPage
          initialState={state()}
          initialResult={RESULT}
          loadKeyword={vi.fn(async (_next: SearchState) => RESULT)}
        />,
      );

      fireEvent.click(screen.getByRole("checkbox", { name: /cs\.LG/ }));

      await waitFor(() => expect(readings).toHaveLength(1));
      expect(readings[0]).toContain("category=cs.LG");
    } finally {
      stop();
    }
  });

  it("stays quiet when the search URL would not change", () => {
    window.history.replaceState(null, "", "/search?q=pulsar");
    const { readings, stop } = listen();
    try {
      render(
        <SearchPage
          initialState={state()}
          initialResult={RESULT}
          loadKeyword={vi.fn(async (_next: SearchState) => RESULT)}
        />,
      );

      // Same term as the one already in the URL: no rewrite, so no event.
      // `apply()` rewrites (and would announce) synchronously on submit.
      fireEvent.change(screen.getByLabelText("Search papers"), {
        target: { value: "pulsar" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(readings).toEqual([]);
      expect(window.location.search).toBe("?q=pulsar");
    } finally {
      stop();
    }
  });
});

describe("SearchPage semantic toggle", () => {
  it("calls GET /v1/search/semantic through the semantic loader", async () => {
    const updateUrl = vi.fn();
    const loadSemantic = vi.fn(async (_next: SearchState) => SEMANTIC);
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state()}
        initialResult={RESULT}
        updateUrl={updateUrl}
        loadSemantic={loadSemantic}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Semantic" }));

    await waitFor(() => expect(loadSemantic).toHaveBeenCalledTimes(1));
    expect(loadKeyword).not.toHaveBeenCalled();
    expect(loadSemantic.mock.calls[0][0]).toMatchObject({
      q: "pulsar",
      mode: "semantic",
    });

    expect(updateUrl).toHaveBeenCalledWith(
      expect.stringContaining("semantic=1"),
      "push",
    );
    expect(await screen.findByText(/results by meaning/)).toBeTruthy();
    expect(screen.getByText(/Semantic match/)).toBeTruthy();
  });

  it("links each author of a semantic result to their profile", () => {
    render(
      <SearchPage
        initialState={state({ mode: "semantic" })}
        initialResult={SEMANTIC}
        updateUrl={vi.fn()}
      />,
    );

    const row = screen
      .getByRole("heading", { level: 2, name: HIT.title })
      .closest("li") as HTMLElement;
    expect(
      within(row).getByRole("link", { name: "A. Okafor" }).getAttribute("href"),
    ).toBe("/u/did%3Akey%3Az6MkOka");
  });

  it("disables the facet filters in semantic mode and says why", () => {
    render(
      <SearchPage
        initialState={state({ mode: "semantic" })}
        initialResult={SEMANTIC}
        updateUrl={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Facet filters apply to keyword search."),
    ).toBeTruthy();
    // A semantic answer carries no facets, so the status group lists no
    // values; the group itself is what is disabled.
    expect(
      screen.getByRole("group", { name: "Status" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("group", { name: "Category" }).hasAttribute("disabled"),
    ).toBe(true);
    expect((screen.getByLabelText("From") as HTMLInputElement).closest("fieldset")?.hasAttribute("disabled")).toBe(true);
  });

  it("switches back to keyword search", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state({ mode: "semantic" })}
        initialResult={SEMANTIC}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keyword" }));

    await waitFor(() => expect(loadKeyword).toHaveBeenCalledTimes(1));
    expect(loadKeyword.mock.calls[0][0]).toMatchObject({ mode: "keyword" });
  });
});

describe("SearchPage submit and failures", () => {
  it("submits a new term into the URL", () => {
    const updateUrl = vi.fn();

    render(
      <SearchPage initialState={EMPTY_SEARCH_STATE} updateUrl={updateUrl} />,
    );

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "  gravitational waves " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(updateUrl).toHaveBeenCalledWith(
      "/search?q=gravitational+waves",
      "push",
    );
  });

  it("shows a retryable error and loads again on Try again", async () => {
    const loadKeyword = vi
      .fn<SearchPageLoader>()
      .mockRejectedValueOnce(new Error("The API is down."))
      .mockResolvedValueOnce(RESULT);

    render(
      <SearchPage
        initialState={state()}
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The API is down.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(HIT.title)).toBeTruthy();
    expect(loadKeyword).toHaveBeenCalledTimes(2);
  });

  it("shows the server's error without fetching again on mount", async () => {
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={state()}
        initialError="Couldn’t reach the API. Check your connection and try again."
        updateUrl={vi.fn()}
        loadKeyword={loadKeyword}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Couldn’t reach the API");
    expect(loadKeyword).not.toHaveBeenCalled();
  });
});

describe("SearchPage with a sch: id", () => {
  it("goes to the paper page instead of searching when an id is submitted", () => {
    const updateUrl = vi.fn();
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={EMPTY_SEARCH_STATE}
        updateUrl={updateUrl}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "  sch:k3f9-q2xz-7mwd/v2 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(updateUrl).toHaveBeenCalledWith(
      "/p/sch%3Ak3f9-q2xz-7mwd/v2",
      "push",
    );
    expect(loadKeyword).not.toHaveBeenCalled();
  });

  it("follows a sch: id that arrived in the URL", () => {
    const updateUrl = vi.fn();

    render(
      <SearchPage
        initialState={state({ q: "sch:abcd-efgh-jklm" })}
        updateUrl={updateUrl}
      />,
    );

    expect(updateUrl).toHaveBeenCalledWith(
      "/p/sch%3Aabcd-efgh-jklm",
      "replace",
    );
    const link = screen.getByRole("link", { name: "the paper" });
    expect(link.getAttribute("href")).toBe("/p/sch%3Aabcd-efgh-jklm");
  });

  it("still searches for a term that merely mentions sch:", () => {
    const updateUrl = vi.fn();
    const loadKeyword = vi.fn(async (_next: SearchState) => RESULT);

    render(
      <SearchPage
        initialState={EMPTY_SEARCH_STATE}
        updateUrl={updateUrl}
        loadKeyword={loadKeyword}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search papers"), {
      target: { value: "sch: ids in papers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(updateUrl).toHaveBeenCalledWith(
      "/search?q=sch%3A+ids+in+papers",
      "push",
    );
  });
});

type SearchPageLoader = (state: SearchState) => Promise<SearchResult>;
