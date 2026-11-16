// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, tokenStore } from "../../lib/api";

// The page module the `/u/{did}` route renders — the bug is on that page.
import { ProfilePage } from "./profile-page";
import { EndorseSection } from "./endorse-button";
import type { EndorseResult, ViewerEndorsement, ViewerIdentity } from "./endorse";

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

const NEWCOMER = "did:key:z6MkNewcomer";
const MEI = "did:key:z6MkMei";

/** `GET /v1/profiles/{did}` for a tier-1 member, as the route hands the page. */
function tierOneProfile(did: string = NEWCOMER) {
  return {
    did,
    name: "Sam Rivera",
    affiliation: "Independent researcher",
    email: null,
    orcid: null,
    tier: 1,
    erased: false,
    reviews: [],
  };
}

/** A JWT-shaped access token whose payload carries the API's `sub`/`tier` claims. */
function accessJwt(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "none" })}.${segment(claims)}.signature`;
}

/** The viewer the token store will name, with their active endorsements. */
function endorsedInCsAi(): ViewerEndorsement[] {
  return [
    {
      recordCid: "bafyreiMei1",
      endorserDid: "did:key:z6MkOkafor",
      endorseeDid: MEI,
      category: "cs.AI",
      expiresAt: null,
    },
  ];
}

function signedEndorsement(category: string) {
  return {
    v: 1,
    type: "endorsement",
    id: `bafyrei${category.replace(/\W/g, "")}`,
    author: MEI,
    created: "2026-11-17T00:00:00Z",
    prev: null,
    body: { endorsee: NEWCOMER, category },
    proofs: [],
    sig: "sig",
  };
}

/** Stubs `GET /v1/me/endorsements` for the signed-in viewer. */
function stubMyEndorsements(rows: ViewerEndorsement[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me/endorsements") {
      return new Response(
        JSON.stringify(
          rows.map((row) => ({
            record_cid: row.recordCid,
            endorser_did: row.endorserDid,
            endorsee_did: row.endorseeDid,
            category: row.category,
            expires_at: row.expiresAt,
            expiry: row.expiresAt,
          })),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/* ------------------------------------------------------------------------- */
/* The reported bug, at the page level: no Endorse action on `/u/{did}`.     */
/* ------------------------------------------------------------------------- */

describe("ProfilePage: the Endorse action (bug: no UI to endorse a researcher)", () => {
  it("shows Endorse in cs.AI to a tier-2 viewer endorsed in cs.AI (ID-5 reproduce)", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 2 }) });
    stubMyEndorsements(endorsedInCsAi());

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    expect(
      await screen.findByRole("button", { name: "Endorse in cs.AI" }),
    ).toBeInstanceOf(HTMLElement);
  });

  it("signs and posts the endorsement, then reflects the newcomer's new tier", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 2 }) });
    stubMyEndorsements(endorsedInCsAi());

    let tierNow = 1;
    const loadProfile = vi.fn(async () => ({
      ...tierOneProfile(),
      tier: tierNow,
    }));
    const endorse = vi.fn(async (): Promise<EndorseResult> => {
      tierNow = 2; // the accepted record grants tier 2 server-side
      return { recordCid: "bafyreiCsAI", category: "cs.AI", state: "accepted" };
    });

    render(
      <ProfilePage
        did={NEWCOMER}
        initialProfile={tierOneProfile()}
        loadProfile={loadProfile}
        endorse={endorse}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));

    // The done state replaces the action…
    expect(
      await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" }),
    ).toBeInstanceOf(HTMLElement);
    expect(endorse).toHaveBeenCalledExactlyOnceWith(NEWCOMER, "cs.AI");

    // …and the page reads the profile back, so the Tier fact shows the grant.
    // (The route handed the page its initial profile, so this one call is the
    // post-endorsement refresh.)
    await waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/^Tier$/).parentElement?.textContent).toContain("2"),
    );
  });

  it("hides the Endorse action from a signed-out reader", async () => {
    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);
    // Give any mistaken read a chance to surface before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });

  it("hides the Endorse action from a signed-in viewer with nothing to endorse in", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 1 }) });
    stubMyEndorsements([]);

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
  });

  it("never offers a viewer the chance to endorse themselves", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 2 }) });
    stubMyEndorsements(endorsedInCsAi());

    render(<ProfilePage did={MEI} initialProfile={{ ...tierOneProfile(MEI), tier: 2 }} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* The section on its own, with seams.                                       */
/* ------------------------------------------------------------------------- */

describe("EndorseSection", () => {
  const viewer: ViewerIdentity = { signedIn: true, did: MEI, tier: 2 };

  const props = {
    did: NEWCOMER,
    viewer,
    loadEndorsements: () => Promise.resolve(endorsedInCsAi()),
  };

  it("offers one action per category the viewer may endorse in", async () => {
    render(
      <EndorseSection
        {...props}
        loadEndorsements={() =>
          Promise.resolve([...endorsedInCsAi(), { ...endorsedInCsAi()[0], category: "cs.MA", recordCid: "bafyreiMei2" }])
        }
      />,
    );
    expect(await screen.findByRole("button", { name: "Endorse in cs.AI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Endorse in cs.MA" })).toBeTruthy();
  });

  it("sends one endorsement for a double click, signalling busy meanwhile", async () => {
    let finish: ((value: EndorseResult) => void) | null = null;
    const endorse = vi.fn(
      () => new Promise<EndorseResult>((resolve) => (finish = resolve)),
    );
    render(<EndorseSection {...props} endorse={endorse} />);

    const button = await screen.findByRole("button", { name: "Endorse in cs.AI" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(endorse).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    await waitFor(() => expect(finish).not.toBeNull());
    fireEvent.click(button); // still one: the first has not settled
    expect(endorse).toHaveBeenCalledTimes(1);
  });

  it("keeps the action and says why when the API refuses the endorsement", async () => {
    const refusal =
      "An endorsement may only be issued by tier 3 (Reviewer) or higher; the endorser did:key:z6MkMei is tier 2 (Author).";
    const endorse = vi.fn().mockRejectedValue(new ApiError(403, { detail: refusal }));
    render(<EndorseSection {...props} endorse={endorse} />);

    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));

    expect((await screen.findByRole("alert")).textContent).toContain("tier 3 (Reviewer)");
    expect(screen.getByRole("button", { name: "Endorse in cs.AI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /✓ Endorsed/ })).toBeNull();
  });

  it("reports a dismissed passkey prompt as a no-op, not a failure of the record", async () => {
    const { PasskeyCancelledError } = await import("../web-auth");
    const endorse = vi.fn().mockRejectedValue(new PasskeyCancelledError());
    render(<EndorseSection {...props} endorse={endorse} />);

    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was endorsed.");
  });

  it("clears the error on the next attempt", async () => {
    const endorse = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, { detail: "Try later." }))
      .mockResolvedValueOnce({ recordCid: "bafyreiCsAI", category: "cs.AI", state: "accepted" });
    render(<EndorseSection {...props} endorse={endorse} />);

    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Endorse in cs.AI" }));
    await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("EndorseSection: a tier-3 viewer may endorse in any category", () => {
  const reviewer: ViewerIdentity = { signedIn: true, did: "did:key:z6MkOkafor", tier: 3 };

  it("offers a category choice instead of nothing", async () => {
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([])}
      />,
    );

    const select = await screen.findByLabelText("Category");
    expect(select).toBeInstanceOf(HTMLElement);
    expect(screen.queryByRole("button", { name: "Endorse in cs.AI" })).toBeNull();

    // The taxonomy the submit wizard uses, grouped as arXiv groups them.
    expect(screen.getByRole("group", { name: "Computer science" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Artificial intelligence (cs.AI)" }),
    ).toBeTruthy();
  });

  it("endorses in the chosen category on submit", async () => {
    const endorse = vi
      .fn()
      .mockResolvedValue({ recordCid: "bafyreiPick", category: "stat.ML", state: "accepted" });
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([])}
        endorse={endorse}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Category"), {
      target: { value: "stat.ML" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Endorse" }));

    expect(await screen.findByRole("button", { name: "✓ Endorsed in stat.ML" })).toBeTruthy();
    expect(endorse).toHaveBeenCalledExactlyOnceWith(NEWCOMER, "stat.ML");
  });

  it("does not submit without a chosen category", async () => {
    const endorse = vi.fn();
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([])}
        endorse={endorse}
      />,
    );

    const select = await screen.findByLabelText("Category");
    const form = select.closest("form");
    expect(form).not.toBeNull();
    // Native validation: the placeholder option is empty, so the form refuses.
    expect(form?.checkValidity()).toBe(false);
    expect(endorse).not.toHaveBeenCalled();
  });
});
