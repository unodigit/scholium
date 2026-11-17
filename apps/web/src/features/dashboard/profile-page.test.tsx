// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

import { ProfilePage } from "./profile-page";
import type { MemberPapers, ProfileData } from "./profile";

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

/** A JWT-shaped access token whose payload carries the API's `sub`/`tier` claims. */
function accessJwt(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "none" })}.${segment(claims)}.signature`;
}

const NO_PAPERS: MemberPapers = { papers: [], truncated: false };
const noPapers = async () => NO_PAPERS;

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe("ProfilePage: a styled profile header", () => {
  const FULL: ProfileData = {
    ...PROFILE,
    orcid: "0000-0002-1825-0097",
    tier: 3,
  };

  it("leads with the name as the heading, then affiliation, ORCID, tier and the short DID", () => {
    render(<ProfilePage did={DID} initialProfile={FULL} signedIn={false} loadPapers={noPapers} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ada Lovelace");
    expect(screen.getByText("Analytical Engine Institute")).toBeTruthy();

    const orcid = screen.getByRole("link", { name: /0000-0002-1825-0097/ });
    expect(orcid.getAttribute("href")).toBe("https://orcid.org/0000-0002-1825-0097");

    expect(screen.getByText("Tier 3 · Reviewer")).toBeTruthy();

    // The short DID, not the full one, is what is on the page.
    expect(screen.getByText("z6MkpT…vktH")).toBeTruthy();
    expect(screen.queryByText(DID)).toBeNull();
    // The old generic heading and the DID kicker are gone.
    expect(screen.queryByRole("heading", { level: 1, name: "Profile" })).toBeNull();
    expect(screen.queryByText(/scholium \/ u \//)).toBeNull();
  });

  it("uses the short pseudonymous DID as the heading when the member has no name", () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={{ ...PROFILE, name: null, affiliation: null, tier: 1 }}
        signedIn={false}
        loadPapers={noPapers}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("z6MkpT…vktH");
    // Nothing is invented for what the member did not share.
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText(/ORCID/)).toBeNull();
  });

  it("says so when the profile has been erased", () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={{ ...PROFILE, name: null, affiliation: null, erased: true }}
        signedIn={false}
        loadPapers={noPapers}
      />,
    );

    expect(screen.getByText("This profile has been erased.")).toBeTruthy();
  });

  it("copies the full DID from the short one, and says it did", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ProfilePage did={DID} initialProfile={FULL} signedIn={false} loadPapers={noPapers} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(DID);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied"));
  });

  it("says when the DID could not be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ProfilePage did={DID} initialProfile={FULL} signedIn={false} loadPapers={noPapers} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copy failed"));
  });
});

describe("ProfilePage: cards for papers and signed reviews", () => {
  const PAPER = {
    shortId: "sch:k3f9-q2xz-7mwd",
    paperCid: "bafy-paper-1",
    versionCid: "bafy-version-2",
    n: 2,
    title: "Can a Meta-Agent Choose the Safer Branch?",
    abstract: "",
    authors: [{ did: DID, name: null, position: 1 }],
    categories: ["cs.AI", "cs.MA"],
    status: "reviewed",
    listedAt: "2026-11-13T09:00:00",
    updatedAt: "2026-11-15T09:00:00",
  };

  it("lists the member's papers, each linking to its page", async () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={PROFILE}
        signedIn={false}
        loadPapers={async () => ({ papers: [PAPER], truncated: false })}
      />,
    );

    const heading = await screen.findByRole("heading", { name: "Papers" });
    const card = heading.closest("section") as HTMLElement;
    const link = await within(card).findByRole("link", { name: PAPER.title });
    expect(link.getAttribute("href")).toBe("/p/k3f9-q2xz-7mwd");
    expect(within(card).getByText("cs.AI")).toBeTruthy();
  });

  it("says there are no papers rather than showing an empty card", async () => {
    render(<ProfilePage did={DID} initialProfile={PROFILE} signedIn={false} loadPapers={noPapers} />);

    expect(await screen.findByText("No papers listed yet.")).toBeTruthy();
  });

  it("admits when it only looked through the newest listed papers", async () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={PROFILE}
        signedIn={false}
        loadPapers={async () => ({ papers: [PAPER], truncated: true })}
      />,
    );

    expect(await screen.findByText(/newest listed papers/)).toBeTruthy();
  });

  it("keeps the rest of the profile when the papers cannot be read, and can retry", async () => {
    const loadPapers = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ papers: [PAPER], truncated: false });
    render(<ProfilePage did={DID} initialProfile={PROFILE} signedIn={false} loadPapers={loadPapers} />);

    expect(await screen.findByText(/Couldn.t load papers/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: PAPER.title })).toBeTruthy();
  });

  it("shows the signed reviews as a card, with an empty state", () => {
    render(<ProfilePage did={DID} initialProfile={PROFILE} signedIn={false} loadPapers={noPapers} />);

    expect(screen.getByRole("heading", { name: "Signed reviews" })).toBeTruthy();
    expect(screen.getByText("No signed reviews yet.")).toBeTruthy();
  });

  it("lists a signed review with its recommendation and confidence", () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={{
          ...PROFILE,
          reviews: [
            {
              review_cid: "bafyreireview1",
              reviewCid: "bafyreireview1",
              version_cid: "bafyreiversion1",
              versionCid: "bafyreiversion1",
              recommendation: "accept",
              confidence: 4,
              scores: null,
              report_cid: null,
              reportCid: null,
              committed_at: null,
              committedAt: null,
              revealed_at: "2026-11-17T09:30:00Z",
              revealedAt: "2026-11-17T09:30:00Z",
            },
          ],
        }}
        signedIn={false}
        loadPapers={noPapers}
      />,
    );

    expect(screen.getByText("accept")).toBeTruthy();
    expect(screen.getByText(/Confidence 4/)).toBeTruthy();
  });
});

describe("ProfilePage: one's own profile", () => {
  it("offers neither Follow nor Endorse on the viewer's own profile (journey 14)", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: DID, tier: 3 }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
    );

    render(<ProfilePage did={DID} initialProfile={PROFILE} loadPapers={noPapers} />);

    await waitFor(() => expect(screen.queryByRole("link", { name: /Follow/ })).toBeNull());
    expect(screen.queryByRole("button", { name: /Follow/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
  });

  it("still offers Follow on someone else's profile", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: "did:key:z6MkSomeoneElse", tier: 1 }) });

    render(
      <ProfilePage
        did={DID}
        initialProfile={PROFILE}
        loadFollowing={async () => []}
        loadPapers={noPapers}
      />,
    );

    expect(await screen.findByRole("button", { name: "Follow Ada Lovelace" })).toBeTruthy();
  });
});

describe("ProfilePage: avatar initials", () => {
  it("skips a title and uses the first and last name letters", () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={{ ...PROFILE, name: "Dr. Tunde Okafor" }}
        signedIn={false}
        loadPapers={noPapers}
      />,
    );

    expect(document.querySelector(".pp-monogram")?.textContent).toBe("TO");
  });

  it("keeps the mark for a pseudonymous member", () => {
    render(
      <ProfilePage
        did={DID}
        initialProfile={{ ...PROFILE, name: null }}
        signedIn={false}
        loadPapers={noPapers}
      />,
    );

    expect(document.querySelector(".pp-monogram")?.textContent).toBe("#");
  });
});
