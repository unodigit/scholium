// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    expect(screen.getByText(/ranked by hashing-v1-1024/)).toBeTruthy();
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
    const checkbox = screen.getByRole("checkbox", { name: /Preprint/ });
    expect(checkbox.closest("fieldset")?.hasAttribute("disabled")).toBe(true);
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
