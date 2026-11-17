// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, tokenStore } from "../../lib/api";

// The page module the `/u/{did}` route renders — the bug is on that page.
import { ProfilePage } from "./profile-page";
import { EndorseSection } from "./endorse-button";
import type {
  EndorseResult,
  ProfileEndorsement,
  ViewerEndorsement,
  ViewerIdentity,
} from "./endorse";

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
  it("shows Endorse in cs.AI to a tier-3 viewer endorsed in cs.AI (ID-5)", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 3 }) });
    stubMyEndorsements(endorsedInCsAi());

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    expect(
      await screen.findByRole("button", { name: "Endorse in cs.AI" }),
    ).toBeInstanceOf(HTMLElement);
  });

  it("hides Endorse from a tier-2 viewer endorsed in cs.AI, which the API refuses (regression)", async () => {
    // Reproduce: as a tier-2 user open another member's `/u/{did}`. The UI
    // offered "Endorse in cs.AI" from the viewer's own cs.AI endorsement and
    // the API answered 403 insufficient-tier. The profile must apply the
    // API's endorser-tier rule and offer nothing.
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 2 }) });
    stubMyEndorsements(endorsedInCsAi());

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });

  it("signs and posts the endorsement, then reflects the newcomer's new tier", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 3 }) });
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

    expect(screen.getByText("Tier 1 · Member")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));

    // The done state replaces the action…
    expect(
      await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" }),
    ).toBeInstanceOf(HTMLElement);
    expect(endorse).toHaveBeenCalledExactlyOnceWith(NEWCOMER, "cs.AI");

    // …and the page reads the profile back, so the tier in the header shows
    // the grant. (The route handed the page its initial profile, so this one
    // call is the post-endorsement refresh.)
    await waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Tier 2 · Author")).toBeTruthy());
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
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 3 }) });
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
  const viewer: ViewerIdentity = { signedIn: true, did: MEI, tier: 3 };

  const props = {
    did: NEWCOMER,
    viewer,
    loadEndorsements: () => Promise.resolve(endorsedInCsAi()),
  };

  it("hides the section from a tier-2 viewer endorsed in cs.AI (regression)", async () => {
    // The API accepts an endorsement only from a tier-3+ author
    // (`handle_endorsement`). Offering "Endorse in cs.AI" to a tier-2 viewer
    // endorsed there made every click a 403 insufficient-tier refusal.
    render(
      <EndorseSection
        {...props}
        viewer={{ signedIn: true, did: MEI, tier: 2 }}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });

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

/** The viewer's own endorsement in `category`, as `GET /v1/me/endorsements` lists it. */
function standingIn(category: string, viewer: string = "did:key:z6MkOkafor"): ViewerEndorsement {
  return {
    recordCid: `bafyreiStanding${category.replace(/\W/g, "")}`,
    endorserDid: "did:key:z6MkPriya",
    endorseeDid: viewer,
    category,
    expiresAt: null,
  };
}

describe("EndorseSection: an endorser may only endorse in categories they are endorsed in", () => {
  const reviewer: ViewerIdentity = { signedIn: true, did: "did:key:z6MkOkafor", tier: 3 };
  const moderator: ViewerIdentity = { signedIn: true, did: "did:key:z6MkPriya", tier: 4 };

  it("lists in the dropdown only the categories a tier-3 viewer is endorsed in (journey 14)", async () => {
    // Reproduce: okafor (tier 3, endorsed in cs.AI and cs.MA) opened a profile
    // and the Endorse dropdown offered every category in the taxonomy.
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI"), standingIn("cs.MA")])}
      />,
    );

    const picker = await screen.findByLabelText("Category");
    const options = within(picker)
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"));
    expect(options).toEqual(["", "cs.AI", "cs.MA"]);
    expect(within(picker).getByRole("option", { name: "Artificial intelligence (cs.AI)" })).toBeTruthy();
    expect(within(picker).queryByRole("option", { name: "Machine learning (cs.LG)" })).toBeNull();
    expect(within(picker).queryByRole("option", { name: /stat\.ML/ })).toBeNull();
  });

  it("offers a tier-3 viewer who is endorsed nowhere nothing to endorse in", async () => {
    render(
      <EndorseSection did={NEWCOMER} viewer={reviewer} loadEndorsements={() => Promise.resolve([])} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });

  it("lists every category for a tier-4 viewer", async () => {
    render(
      <EndorseSection did={NEWCOMER} viewer={moderator} loadEndorsements={() => Promise.resolve([])} />,
    );

    const select = await screen.findByLabelText("Category");
    expect(select).toBeInstanceOf(HTMLElement);
    expect(screen.queryByRole("button", { name: "Endorse in cs.AI" })).toBeNull();

    // The taxonomy the submit wizard uses, grouped as arXiv groups them.
    expect(screen.getByRole("group", { name: "Computer science" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Artificial intelligence (cs.AI)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Machine learning (cs.LG)" })).toBeTruthy();
  });

  it("endorses in the chosen category on submit", async () => {
    const endorse = vi
      .fn()
      .mockResolvedValue({ recordCid: "bafyreiPick", category: "cs.MA", state: "accepted" });
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI"), standingIn("cs.MA")])}
        endorse={endorse}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Category"), {
      target: { value: "cs.MA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Endorse" }));

    expect(await screen.findByRole("button", { name: "✓ Endorsed in cs.MA" })).toBeTruthy();
    expect(endorse).toHaveBeenCalledExactlyOnceWith(NEWCOMER, "cs.MA");
  });

  it("lets a tier-4 viewer endorse in a category they hold no endorsement in", async () => {
    const endorse = vi
      .fn()
      .mockResolvedValue({ recordCid: "bafyreiPick", category: "stat.ML", state: "accepted" });
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={moderator}
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
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI")])}
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

/* ------------------------------------------------------------------------- */
/* Bug: endorsements were not shown, and the button forgot it had been used. */
/* ------------------------------------------------------------------------- */

const OKAFOR = "did:key:z6MkOkafor";

/** One row of `GET /v1/profiles/{did}/endorsements`, in the API's shape. */
function heldRow(overrides: Record<string, unknown> = {}) {
  return {
    record_cid: "bafyreiOkafor1",
    endorser_did: OKAFOR,
    endorser_name: "Tunde Okafor",
    endorsee_did: NEWCOMER,
    category: "cs.AI",
    endorsed_at: "2026-11-17T09:30:00Z",
    expires_at: null,
    ...overrides,
  };
}

/** The same row as the parsed type the section's seam takes. */
function heldEndorsement(overrides: Partial<ProfileEndorsement> = {}): ProfileEndorsement {
  return {
    recordCid: "bafyreiOkafor1",
    endorserDid: OKAFOR,
    endorserName: "Tunde Okafor",
    endorseeDid: NEWCOMER,
    category: "cs.AI",
    endorsedAt: "2026-11-17T09:30:00Z",
    expiresAt: null,
    ...overrides,
  };
}

/**
 * Stubs both reads the profile makes: the viewer's own endorsements and the
 * public list of what the profile's person holds. `held` is a function so a
 * test can change the answer between the page load and the read-back.
 */
function stubEndorsementApi(options: {
  mine?: ViewerEndorsement[];
  held: () => unknown[];
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v1/me/endorsements") {
      return json(
        (options.mine ?? []).map((row) => ({
          record_cid: row.recordCid,
          endorser_did: row.endorserDid,
          endorsee_did: row.endorseeDid,
          category: row.category,
          expires_at: row.expiresAt,
          expiry: row.expiresAt,
        })),
      );
    }
    if (url.pathname === `/v1/profiles/${encodeURIComponent(NEWCOMER)}/endorsements`) {
      return json(options.held());
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ProfilePage: the Endorse button remembers an endorsement (bug: duplicates)", () => {
  it("after a reload shows Endorsed in cs.AI and offers only categories not yet endorsed", async () => {
    // Reproduce: okafor endorses a newcomer in cs.AI and reloads /u/{did}.
    // The page starts over, so everything it knows must come from the API.
    tokenStore.set({ accessToken: accessJwt({ sub: OKAFOR, tier: 3 }) });
    stubEndorsementApi({
      mine: [{ ...endorsedInCsAi()[0], endorseeDid: OKAFOR }],
      held: () => [heldRow()],
    });
    const endorse = vi.fn();

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} endorse={endorse} />);

    const done = await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(done);
    expect(endorse).not.toHaveBeenCalled();
    // The default action is gone, not shown beside the done state.
    expect(screen.queryByRole("button", { name: "Endorse in cs.AI" })).toBeNull();

    // The picker no longer offers cs.AI, and still offers the rest.
    const picker = screen.queryByLabelText("Category");
    // okafor is endorsed in cs.AI only, and that is used: nothing is left to pick.
    expect(picker).toBeNull();
  });

  it("does not hold another reviewer's endorsement against the viewer", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: MEI, tier: 3 }) });
    // endorsed by okafor, not by mei; mei is endorsed in cs.AI herself
    stubEndorsementApi({ mine: endorsedInCsAi(), held: () => [heldRow()] });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    const picker = await screen.findByLabelText("Category");
    expect(
      within(picker).getByRole("option", { name: "Artificial intelligence (cs.AI)" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /✓ Endorsed/ })).toBeNull();
  });

  it("lets an endorsement the viewer gave join the list as soon as it is accepted", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: OKAFOR, tier: 3 }) });
    let held: unknown[] = [];
    stubEndorsementApi({
      mine: [{ ...endorsedInCsAi()[0], endorseeDid: OKAFOR }],
      held: () => held,
    });
    const endorse = vi.fn(async (): Promise<EndorseResult> => {
      held = [heldRow()]; // the accepted record, as the API now lists it
      return { recordCid: "bafyreiOkafor1", category: "cs.AI", state: "accepted" };
    });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} endorse={endorse} />);

    fireEvent.click(await screen.findByRole("button", { name: "Endorse in cs.AI" }));

    expect(await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Tunde Okafor" })).toBeTruthy();
  });
});

describe("ProfilePage: the endorsements a person holds", () => {
  it("lists them per category with the endorser (a link to their profile) and the date", async () => {
    stubEndorsementApi({
      held: () => [
        heldRow(),
        heldRow({
          record_cid: "bafyreiMei1",
          category: "cs.LG",
          endorser_did: MEI,
          endorser_name: null,
          endorsed_at: "2026-11-18T10:00:00Z",
        }),
      ],
    });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    const heading = await screen.findByRole("heading", { name: "Endorsements" });
    const section = heading.closest("section") as HTMLElement;
    expect(section).not.toBeNull();

    // Category groups, in order, each naming its endorsers.
    const groups = within(section).getAllByRole("heading", { level: 4 });
    expect(groups.map((group) => group.textContent)).toEqual(["cs.AI", "cs.LG"]);

    // The endorser is a link to their own profile: by name, else by DID.
    const named = within(section).getByRole("link", { name: "Tunde Okafor" });
    expect(named.getAttribute("href")).toBe(`/u/${encodeURIComponent(OKAFOR)}`);
    const pseudonymous = within(section).getByRole("link", { name: MEI });
    expect(pseudonymous.getAttribute("href")).toBe(`/u/${encodeURIComponent(MEI)}`);

    // The date, readable and machine-readable.
    const date = within(section).getByText("17 Nov 2026");
    expect(date.tagName).toBe("TIME");
    expect(date.getAttribute("datetime")).toBe("2026-11-17T09:30:00Z");
    expect(within(section).getByText("18 Nov 2026")).toBeTruthy();
  });

  it("shows the list to a signed-out reader, who is offered nothing to do", async () => {
    stubEndorsementApi({ held: () => [heldRow()] });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    expect(await screen.findByRole("link", { name: "Tunde Okafor" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Endorse/ })).toBeNull();
  });

  it("shows the list to the person themself, who may not endorse themself", async () => {
    tokenStore.set({ accessToken: accessJwt({ sub: NEWCOMER, tier: 3 }) });
    stubEndorsementApi({ held: () => [heldRow()] });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    expect(await screen.findByRole("link", { name: "Tunde Okafor" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Endorse" })).toBeNull();
  });

  it("shows no Endorsements section for a person who holds none", async () => {
    stubEndorsementApi({ held: () => [] });

    render(<ProfilePage did={NEWCOMER} initialProfile={tierOneProfile()} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole("heading", { name: "Endorsements" })).toBeNull();
  });
});

describe("EndorseSection: reading what is already endorsed", () => {
  const reviewer: ViewerIdentity = { signedIn: true, did: OKAFOR, tier: 3 };

  it("keeps the offers, and shows no list, when the list cannot be read", async () => {
    // A failed read must not hide what the tier grants; the API still
    // refuses a duplicate (see the 409 case below).
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI", OKAFOR)])}
        loadProfileEndorsements={() => Promise.reject(new Error("offline"))}
      />,
    );

    expect(await screen.findByLabelText("Category")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Endorsements" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers nothing until the list has been read, so a used category is never clickable", async () => {
    let finish: ((rows: ProfileEndorsement[]) => void) | null = null;
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={reviewer}
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI", OKAFOR)])}
        loadProfileEndorsements={() => new Promise((resolve) => (finish = resolve))}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByLabelText("Category")).toBeNull();

    await waitFor(() => expect(finish).not.toBeNull());
    finish!([heldEndorsement()]);
    expect(await screen.findByRole("button", { name: "✓ Endorsed in cs.AI" })).toBeTruthy();
  });

  it("treats the API's 409 as already endorsed: says so and shows the done state", async () => {
    // The viewer's DID is unknown (an opaque token), so the list cannot say
    // they already endorsed; the API's refusal does.
    const refusal = "The endorser did:key:z6MkOkafor has already endorsed did:key:z6MkNewcomer in cs.AI.";
    const endorse = vi.fn().mockRejectedValue(new ApiError(409, { detail: refusal }));
    render(
      <EndorseSection
        did={NEWCOMER}
        viewer={{ signedIn: true, did: null, tier: 3 }}
        loadEndorsements={() => Promise.resolve([standingIn("cs.AI", OKAFOR)])}
        loadProfileEndorsements={() => Promise.resolve([])}
        endorse={endorse}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Category"), { target: { value: "cs.AI" } });
    fireEvent.click(screen.getByRole("button", { name: "Endorse" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already endorsed");
    expect(screen.getByRole("button", { name: "✓ Endorsed in cs.AI" })).toBeTruthy();
  });
});
