// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

import { SaveSearchButton } from "./save-search-button";
import { EMPTY_SEARCH_STATE, type SearchState } from "./search";

function state(overrides: Partial<SearchState> = {}): SearchState {
  return { ...EMPTY_SEARCH_STATE, q: "reward models", ...overrides };
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

describe("SaveSearchButton: signed out", () => {
  it("offers a sign-in link that returns to this search", () => {
    render(<SaveSearchButton state={state()} signedIn={false} />);

    const link = screen.getByRole("link", { name: "Save this search" });
    expect(link.getAttribute("href")).toBe(
      "/signin?next=%2Fsearch%3Fq%3Dreward%2Bmodels",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("upgrades once a session is restored after mount", async () => {
    const save = vi.fn().mockResolvedValue({ id: "ss_1", query: {} });
    render(<SaveSearchButton state={state()} save={save} />);

    expect(screen.getByRole("link", { name: "Save this search" })).toBeTruthy();

    act(() => tokenStore.set({ accessToken: "access" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save this search" }),
      ).toBeTruthy(),
    );
  });
});

describe("SaveSearchButton: nothing to save", () => {
  it("does not render for an empty search", () => {
    const { container } = render(
      <SaveSearchButton state={EMPTY_SEARCH_STATE} signedIn />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("still saves a search made only of filters", () => {
    render(
      <SaveSearchButton
        state={{ ...EMPTY_SEARCH_STATE, categories: ["cs.LG"] }}
        signedIn
        save={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Save this search" }),
    ).toBeTruthy();
  });
});

describe("SaveSearchButton: saving", () => {
  it("saves the current query and filters", async () => {
    const save = vi.fn().mockResolvedValue({ id: "ss_1", query: {} });
    render(
      <SaveSearchButton
        state={state({
          categories: ["cs.LG"],
          statuses: ["reviewed"],
          hasCode: true,
          dateFrom: "2026-01-01",
        })}
        signedIn
        save={save}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      q: "reward models",
      categories: ["cs.LG"],
      statuses: ["reviewed"],
      hasCode: true,
      dateFrom: "2026-01-01",
    });
    expect(save.mock.calls[0][1]).toEqual({ digest: false });
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });

  it("passes the optional daily-digest choice", async () => {
    const save = vi.fn().mockResolvedValue({ id: "ss_1", query: {} });
    render(<SaveSearchButton state={state()} signedIn save={save} />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: /daily digest/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toEqual({ digest: true });
  });

  it("says why when the save fails and lets the reader try again", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("The API is down."))
      .mockResolvedValueOnce({ id: "ss_1", query: {} });
    render(<SaveSearchButton state={state()} signedIn save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The API is down.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends one request for a double click", async () => {
    let finish: () => void = () => {};
    const save = vi.fn(
      (_state: SearchState, _options: { readonly digest: boolean }) =>
        new Promise<{ id: string; query: Record<string, never> }>((resolve) => {
          finish = () => resolve({ id: "ss_1", query: {} });
        }),
    );
    render(<SaveSearchButton state={state()} signedIn save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this search" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Save this search" })
        .getAttribute("aria-busy"),
    ).toBe("true");

    await act(async () => finish());
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });
});
