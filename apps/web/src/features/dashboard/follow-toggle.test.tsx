// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { FollowToggle, FollowedCategoriesCard } from "./follow-toggle";

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

/** The toggle's button; its name is "Follow <category>" in both states. */
function button(category = "cs.AI") {
  return screen.getByRole("button", { name: `Follow ${category}` });
}

const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed");

describe("FollowToggle: signed out", () => {
  it("offers a sign-in link that returns to the category page", () => {
    render(<FollowToggle category="cs.AI" signedIn={false} />);
    const link = screen.getByRole("link", { name: /Follow cs\.AI/ });
    expect(link.getAttribute("href")).toBe("/signin?next=%2Fc%2Fcs.AI");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is also what renders first when the session is not pinned, so server and client agree", () => {
    const loadFollowing = vi.fn();
    const { container } = render(<FollowToggle category="cs.AI" loadFollowing={loadFollowing} />);
    expect(container.querySelector("a")).not.toBeNull();
    expect(loadFollowing).not.toHaveBeenCalled();
  });
});

describe("FollowToggle: signed in", () => {
  it("upgrades to the button when the token store holds a session", async () => {
    tokenStore.set({ accessToken: "a", refreshToken: "r" });
    const loadFollowing = vi.fn().mockResolvedValue(["cs.AI"]);
    render(<FollowToggle category="cs.AI" loadFollowing={loadFollowing} />);
    await waitFor(() => expect(pressed(button())).toBe("true"));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("upgrades once the session is restored after mount, as on a reload", async () => {
    const loadFollowing = vi.fn().mockResolvedValue(["cs.AI"]);
    render(<FollowToggle category="cs.AI" loadFollowing={loadFollowing} />);

    // A page load starts signed out until the session provider's refresh lands.
    expect(screen.getByRole("link", { name: /Follow cs\.AI/ })).toBeTruthy();

    act(() => tokenStore.set({ accessToken: "a" }));

    await waitFor(() => expect(pressed(button())).toBe("true"));
    expect(loadFollowing).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows Following state from the read: pressed when followed, not when not", async () => {
    const loadFollowing = vi.fn().mockResolvedValue(["cs.CR"]);
    render(<FollowToggle category="cs.AI" signedIn loadFollowing={loadFollowing} />);
    await waitFor(() => expect(loadFollowing).toHaveBeenCalledTimes(1));
    expect(pressed(button())).toBe("false");
  });

  it("matches the category after trimming, as the API does", async () => {
    const loadFollowing = vi.fn().mockResolvedValue(["cs.AI"]);
    render(<FollowToggle category=" cs.AI " signedIn loadFollowing={loadFollowing} />);
    await waitFor(() => expect(pressed(screen.getByRole("button"))).toBe("true"));
  });

  it("does not read when the caller already knows the state", () => {
    const loadFollowing = vi.fn();
    render(
      <FollowToggle category="cs.AI" signedIn initialFollowing loadFollowing={loadFollowing} />,
    );
    expect(pressed(button())).toBe("true");
    expect(loadFollowing).not.toHaveBeenCalled();
  });

  it("follows on click, then unfollows on the next, and flips the pressed state each time", async () => {
    const follow = vi.fn().mockResolvedValue(undefined);
    const unfollow = vi.fn().mockResolvedValue(undefined);
    render(
      <FollowToggle
        category="cs.AI"
        signedIn
        initialFollowing={false}
        follow={follow}
        unfollow={unfollow}
      />,
    );

    fireEvent.click(button());
    await waitFor(() => expect(pressed(button())).toBe("true"));
    expect(follow).toHaveBeenCalledExactlyOnceWith("cs.AI");
    expect(unfollow).not.toHaveBeenCalled();

    fireEvent.click(button());
    await waitFor(() => expect(pressed(button())).toBe("false"));
    expect(unfollow).toHaveBeenCalledExactlyOnceWith("cs.AI");
  });

  it("marks the state with a glyph as well as aria-pressed, never colour alone", async () => {
    render(<FollowToggle category="cs.AI" signedIn initialFollowing={false} follow={vi.fn().mockResolvedValue(undefined)} />);
    expect(button().textContent).toContain("+");
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toContain("✓"));
  });
});

describe("FollowToggle: when the state is not known", () => {
  it("still offers Follow if the read fails (the endpoint may not exist yet)", async () => {
    const loadFollowing = vi.fn().mockRejectedValue(new ApiError(404, { detail: "Not found" }));
    const follow = vi.fn().mockResolvedValue(undefined);
    render(
      <FollowToggle category="cs.AI" signedIn loadFollowing={loadFollowing} follow={follow} />,
    );
    await waitFor(() => expect(loadFollowing).toHaveBeenCalled());
    // The failed read is not an error the reader can act on: no alert, button works.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pressed(button())).toBe("false");

    fireEvent.click(button());
    await waitFor(() => expect(pressed(button())).toBe("true"));
    expect(follow).toHaveBeenCalledWith("cs.AI");
  });

  it("does not let a slow read overwrite what the reader just chose", async () => {
    let resolveRead: (value: string[]) => void = () => {};
    const loadFollowing = vi.fn(
      () => new Promise<string[]>((resolve) => (resolveRead = resolve)),
    );
    const follow = vi.fn().mockResolvedValue(undefined);
    render(
      <FollowToggle category="cs.AI" signedIn loadFollowing={loadFollowing} follow={follow} />,
    );

    fireEvent.click(button());
    await waitFor(() => expect(pressed(button())).toBe("true"));

    // The read finally answers "not following"; the reader's follow must win.
    await act(async () => resolveRead([]));
    expect(pressed(button())).toBe("true");
  });
});

describe("FollowedCategoriesCard on /me", () => {
  it("renders nothing for a signed-out reader", () => {
    const { container } = render(<FollowedCategoriesCard signedIn={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists the categories the reader follows, linked to their pages", async () => {
    render(
      <FollowedCategoriesCard
        signedIn
        loadFollows={vi.fn().mockResolvedValue(["cs.AI", "cs.LG"])}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Follows" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "cs.AI" }).getAttribute("href"),
    ).toBe("/c/cs.AI");
    expect(
      screen.getByRole("link", { name: "cs.LG" }).getAttribute("href"),
    ).toBe("/c/cs.LG");
  });

  it("says how to follow when the reader follows none", async () => {
    render(
      <FollowedCategoriesCard signedIn loadFollows={vi.fn().mockResolvedValue([])} />,
    );

    expect((await screen.findByText(/don’t follow any categories/)).textContent).toContain(
      "Follow",
    );
  });

  it("shows a retryable error when the list cannot be read", async () => {
    const loadFollows = vi
      .fn()
      .mockRejectedValueOnce(new Error("The API is down."))
      .mockResolvedValueOnce(["cs.AI"]);
    render(<FollowedCategoriesCard signedIn loadFollows={loadFollows} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The API is down.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "cs.AI" })).toBeTruthy();
  });
});

describe("FollowToggle: failures and double clicks", () => {
  it("keeps the previous state and says why when the follow fails", async () => {
    const follow = vi.fn().mockRejectedValue(new ApiError(422, { detail: "Not a category." }));
    render(
      <FollowToggle category="cs.AI" signedIn initialFollowing={false} follow={follow} />,
    );
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toBe("Not a category.");
    expect(pressed(button())).toBe("false");
  });

  it("keeps Following when the unfollow fails, and names the verb", async () => {
    const unfollow = vi.fn().mockRejectedValue(new NetworkError("/v1/me/follows/cs.AI"));
    render(<FollowToggle category="cs.AI" signedIn initialFollowing unfollow={unfollow} />);
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the API/);
    expect(pressed(button())).toBe("true");
  });

  it("asks an expired session to sign in", async () => {
    const follow = vi.fn().mockRejectedValue(new ApiError(401, { detail: "Token expired." }));
    render(
      <FollowToggle category="cs.AI" signedIn initialFollowing={false} follow={follow} />,
    );
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toBe("Sign in to follow categories.");
  });

  it("clears the error on the next attempt", async () => {
    const follow = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, { detail: "Try later." }))
      .mockResolvedValueOnce(undefined);
    render(
      <FollowToggle category="cs.AI" signedIn initialFollowing={false} follow={follow} />,
    );
    fireEvent.click(button());
    await screen.findByRole("alert");
    fireEvent.click(button());
    await waitFor(() => expect(pressed(button())).toBe("true"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends one request for a double click and signals busy meanwhile", async () => {
    let finish: () => void = () => {};
    const follow = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(
      <FollowToggle category="cs.AI" signedIn initialFollowing={false} follow={follow} />,
    );

    fireEvent.click(button());
    fireEvent.click(button());
    expect(follow).toHaveBeenCalledTimes(1);
    // aria-disabled, not disabled: the button keeps keyboard focus while it works.
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect((button() as HTMLButtonElement).disabled).toBe(false);

    await act(async () => finish());
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(pressed(button())).toBe("true");
  });
});
