// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { SavedSearchesCard } from "./saved-searches-card";
import type { SavedSearch } from "./saved-searches";

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

const PULSAR: SavedSearch = {
  id: "ss_pulsar",
  query: {
    q: "pulsar timing",
    category: ["cs.CR"],
    status: ["reviewed"],
    has_code: true,
    from: "2026-03-02",
    to: "2026-04-01",
  },
};
const FILTER_ONLY: SavedSearch = { id: "ss_cs_ai", query: { category: ["cs.AI"] } };
const GRAPHS: SavedSearch = { id: "ss_graphs", query: { q: "graph neural networks" } };

const loaderOf = (...items: SavedSearch[]) => vi.fn().mockResolvedValue(items);

const deleteButton = (title: string) =>
  screen.getByRole("button", { name: `Delete saved search ${title}` });

describe("SavedSearchesCard: loading the list", () => {
  it("is a card titled Saved searches that others can deep-link to", async () => {
    const { container } = render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR)} />);
    expect(screen.getByRole("heading", { name: "Saved searches" })).toBeTruthy();
    expect(container.querySelector("section#saved-searches")).not.toBeNull();
    await screen.findByText("pulsar timing");
  });

  it("says it is loading, then lists each search", async () => {
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, GRAPHS)} />);
    expect(screen.getByText("Loading your saved searches…")).toBeTruthy();
    await screen.findByText("pulsar timing");
    expect(screen.queryByText("Loading your saved searches…")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("links each title to /search with the saved filters, to re-run it", async () => {
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, FILTER_ONLY)} />);
    const run = await screen.findByRole("link", { name: "pulsar timing" });
    const url = new URL(run.getAttribute("href") ?? "", "http://x");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("pulsar timing");
    expect(url.searchParams.getAll("category")).toEqual(["cs.CR"]);
    expect(url.searchParams.get("has_code")).toBe("true");

    // A filter-only search is titled by its filters, and links by them too.
    const filterLink = screen.getByRole("link", { name: "cs.AI" });
    expect(filterLink.getAttribute("href")).toBe("/search?category=cs.AI");
  });

  it("shows the filters beneath a titled search, and nothing extra for a bare one", async () => {
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, GRAPHS)} />);
    expect(await screen.findByText("cs.CR · reviewed · has code · 2026-03-02 – 2026-04-01")).toBeTruthy();
    const [, bare] = screen.getAllByRole("listitem");
    expect(bare.querySelectorAll(".db-saved-meta")).toHaveLength(0);
  });

  it("has an empty state that points at search", async () => {
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf()} />);
    expect(await screen.findByText("You have no saved searches yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Search papers" }).getAttribute("href")).toBe("/search");
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("SavedSearchesCard: a failed load", () => {
  it("says why and retries on request, without claiming the list is empty", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(404, { detail: "Not found." }))
      .mockResolvedValueOnce([PULSAR]);
    render(<SavedSearchesCard signedIn loadSavedSearches={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Not found.");
    expect(screen.queryByText("You have no saved searches yet.")).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("pulsar timing");
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains an unreachable API", async () => {
    const load = vi.fn().mockRejectedValue(new NetworkError("/v1/me/saved-searches"));
    render(<SavedSearchesCard signedIn loadSavedSearches={load} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the API/);
  });
});

describe("SavedSearchesCard: Delete", () => {
  it("deletes by id, removes only that row and announces it", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(
      <SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, GRAPHS)} deleteSavedSearch={remove} />,
    );
    await screen.findByText("pulsar timing");

    fireEvent.click(deleteButton("pulsar timing"));
    await waitFor(() => expect(screen.queryByText("pulsar timing")).toBeNull());

    expect(remove).toHaveBeenCalledExactlyOnceWith("ss_pulsar");
    expect(screen.getByText("graph neural networks")).toBeTruthy();
    expect(screen.getAllByRole("status").some((el) => el.textContent === "Deleted saved search “pulsar timing”.")).toBe(true);
  });

  it("gives every Delete a name that says which search it removes", async () => {
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, FILTER_ONLY)} />);
    await screen.findByText("pulsar timing");
    expect(deleteButton("pulsar timing")).toBeTruthy();
    expect(deleteButton("cs.AI")).toBeTruthy();
  });

  it("shows the empty state once the last search is deleted", async () => {
    render(
      <SavedSearchesCard signedIn
        loadSavedSearches={loaderOf(GRAPHS)}
        deleteSavedSearch={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("graph neural networks");
    fireEvent.click(deleteButton("graph neural networks"));
    expect(await screen.findByText("You have no saved searches yet.")).toBeTruthy();
  });

  it("keeps the row and says why on it when the delete fails", async () => {
    const remove = vi.fn().mockRejectedValue(new ApiError(500, { detail: "Try later." }));
    render(
      <SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR, GRAPHS)} deleteSavedSearch={remove} />,
    );
    await screen.findByText("pulsar timing");

    fireEvent.click(deleteButton("pulsar timing"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Try later.");
    // The error belongs to its own row, and the row is still there to retry.
    expect(alert.closest("li")?.textContent).toContain("pulsar timing");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(deleteButton("pulsar timing").getAttribute("aria-busy")).toBe("false");
  });

  it("clears a row's error on its next attempt", async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, { detail: "Try later." }))
      .mockResolvedValueOnce(undefined);
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR)} deleteSavedSearch={remove} />);
    await screen.findByText("pulsar timing");

    fireEvent.click(deleteButton("pulsar timing"));
    await screen.findByRole("alert");
    fireEvent.click(deleteButton("pulsar timing"));
    await waitFor(() => expect(screen.queryByText("pulsar timing")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends one request for a double click and shows it is working", async () => {
    let finish: () => void = () => {};
    const remove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<SavedSearchesCard signedIn loadSavedSearches={loaderOf(PULSAR)} deleteSavedSearch={remove} />);
    await screen.findByText("pulsar timing");

    fireEvent.click(deleteButton("pulsar timing"));
    fireEvent.click(deleteButton("pulsar timing"));
    expect(remove).toHaveBeenCalledTimes(1);
    const busy = deleteButton("pulsar timing");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.textContent).toBe("Deleting…");
    // aria-disabled, not disabled: focus stays on the button while it works.
    expect((busy as HTMLButtonElement).disabled).toBe(false);

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText("pulsar timing")).toBeNull());
  });

  it("moves focus to the next row's Delete, not to the page, after a delete", async () => {
    render(
      <SavedSearchesCard signedIn
        loadSavedSearches={loaderOf(PULSAR, FILTER_ONLY, GRAPHS)}
        deleteSavedSearch={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("pulsar timing");

    const first = deleteButton("pulsar timing");
    first.focus();
    fireEvent.click(first);
    await waitFor(() => expect(screen.queryByText("pulsar timing")).toBeNull());
    expect(document.activeElement).toBe(deleteButton("cs.AI"));
  });

  it("moves focus to the previous row when the last row is deleted", async () => {
    render(
      <SavedSearchesCard signedIn
        loadSavedSearches={loaderOf(PULSAR, GRAPHS)}
        deleteSavedSearch={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("pulsar timing");

    const last = deleteButton("graph neural networks");
    last.focus();
    fireEvent.click(last);
    await waitFor(() => expect(screen.queryByText("graph neural networks")).toBeNull());
    expect(document.activeElement).toBe(deleteButton("pulsar timing"));
  });

  it("moves focus into the card when the list empties, so it is not lost", async () => {
    const { container } = render(
      <SavedSearchesCard signedIn
        loadSavedSearches={loaderOf(GRAPHS)}
        deleteSavedSearch={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("graph neural networks");

    const only = deleteButton("graph neural networks");
    only.focus();
    fireEvent.click(only);
    await screen.findByText("You have no saved searches yet.");
    expect(document.activeElement).toBe(container.querySelector(".db-saved-body"));
  });
});

describe("SavedSearchesCard: sign-in", () => {
  it("never asks the API for a list when there is no session", () => {
    const load = vi.fn();
    render(<SavedSearchesCard loadSavedSearches={load} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("never asks when the sign-in state is pinned off, even with a token", () => {
    tokenStore.set({ accessToken: "a", refreshToken: "r" });
    const load = vi.fn();
    render(<SavedSearchesCard signedIn={false} loadSavedSearches={load} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("reads the session from the token store when it is not pinned", async () => {
    tokenStore.set({ accessToken: "a", refreshToken: "r" });
    render(<SavedSearchesCard loadSavedSearches={loaderOf(PULSAR)} />);
    await screen.findByText("pulsar timing");
  });
});
