// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

import { ProfilePage } from "./profile-page";
import type { ProfileData } from "./profile";

const DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const PROFILE: ProfileData = {
  did: DID,
  name: "Ada Lovelace",
  affiliation: "Analytical Engine Institute",
  email: null,
  orcid: null,
  tier: 2,
  erased: false,
  reviews: [],
};

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("ProfilePage: follow this person", () => {
  it("offers a Follow toggle on /u/{did} when signed in", async () => {
    const follow = vi.fn().mockResolvedValue(undefined);
    render(
      <ProfilePage
        did={DID}
        initialProfile={PROFILE}
        signedIn
        loadFollowing={async () => []}
        follow={follow}
      />,
    );

    const button = screen.getByRole("button", { name: "Follow Ada Lovelace" });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Follow Ada Lovelace" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(follow).toHaveBeenCalledWith(DID);
  });

  it("shows the person as already followed when the read says so", async () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={PROFILE}
        signedIn
        loadFollowing={async () => [DID]}
      />,
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Follow Ada Lovelace" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("sends a signed-out reader to sign in, then back to this profile", () => {
    render(<ProfilePage did={DID} initialProfile={PROFILE} signedIn={false} />);

    const link = screen.getByRole("link", { name: /Follow Ada Lovelace/ });
    expect(link.getAttribute("href")).toBe(
      `/signin?next=${encodeURIComponent(`/u/${encodeURIComponent(DID)}`)}`,
    );
  });
});
