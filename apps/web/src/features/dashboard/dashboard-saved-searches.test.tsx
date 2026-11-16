// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

import { DashboardPage } from "./dashboard-page";
import type { DashboardData } from "./dashboard";
import type { SavedSearch } from "./saved-searches";

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

/** A dashboard with nothing in it: only the cards' own chrome renders. */
const DATA: DashboardData = {
  did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  needs_attention: {
    count: 0,
    consents_to_sign: [],
    review_invitations: [],
    author_replies: [],
    moderation_outcomes: [],
    items: [],
  },
  my_papers: [],
  my_reviews: [],
};

const SEARCH: SavedSearch = { id: "ss_1", query: { q: "pulsar timing", category: ["cs.CR"] } };

describe("/me saved searches card", () => {
  it("is one of the dashboard cards, between My reviews and Credentials", async () => {
    render(
      <DashboardPage
        initialDashboard={DATA}
        signedIn
        loadSavedSearches={vi.fn().mockResolvedValue([SEARCH])}
      />,
    );
    await screen.findByText("pulsar timing");

    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([
      "Needs your attention",
      "My papers",
      "My reviews",
      "Saved searches",
      "Credentials",
      "Security",
      "Notifications",
    ]);
  });

  it("lists the injected searches and deletes through the injected call", async () => {
    const load = vi.fn().mockResolvedValue([SEARCH]);
    const remove = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardPage
        initialDashboard={DATA}
        signedIn
        loadSavedSearches={load}
        deleteSavedSearch={remove}
      />,
    );
    await screen.findByText("pulsar timing");

    fireEvent.click(screen.getByRole("button", { name: "Delete saved search pulsar timing" }));
    await waitFor(() => expect(screen.queryByText("pulsar timing")).toBeNull());
    expect(remove).toHaveBeenCalledExactlyOnceWith("ss_1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fails on its own: the rest of the dashboard stays when the list cannot load", async () => {
    render(
      <DashboardPage
        initialDashboard={DATA}
        signedIn
        loadSavedSearches={vi.fn().mockRejectedValue(new Error("saved searches are down"))}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("saved searches are down");
    expect(screen.getByRole("heading", { name: "My papers" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Credentials" })).toBeTruthy();
  });

  it("does not load, or show, anyone's saved searches to a signed-out reader", () => {
    const load = vi.fn();
    render(<DashboardPage initialDashboard={DATA} signedIn={false} loadSavedSearches={load} />);
    expect(screen.queryByRole("heading", { name: "Saved searches" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
