import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError } from "../web-auth";

import {
  ENDORSE_MIN_TIER,
  MY_ENDORSEMENTS_ENDPOINT,
  NO_ENDORSE_OFFER,
  EndorseInputError,
  WrongEndorsementRecordError,
  describeEndorseError,
  endorseActionLabel,
  endorsedActionLabel,
  endorseChoices,
  endorseOffer,
  endorseResearcher,
  categoriesEndorsedBy,
  endorserLabel,
  formatEndorsementDate,
  groupEndorsementsByCategory,
  loadProfileEndorsements,
  parseProfileEndorsements,
  parseViewerEndorsements,
  profileEndorsementsEndpoint,
  viewerFromAccessToken,
  type ProfileEndorsement,
} from "./endorse";

// The journeys run east of UTC (GMT+11 in November); pin the zone so the
// reader's-zone dates asserted here are deterministic on any machine.
process.env.TZ = "Australia/Sydney";

/** A signed record as `web-auth`'s signer returns one. */
function signedRecord(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "endorsement",
    id: "bafyreiendorse",
    author: "did:key:z6MkViewer",
    created: "2026-11-17T00:00:00Z",
    prev: null,
    body: { endorsee: "did:key:z6MkNewcomer", category: "cs.AI" },
    proofs: [],
    sig: "sig",
    ...overrides,
  };
}

describe("parseViewerEndorsements", () => {
  it("reads the API's endorsement rows: cid, endorser, endorsee, category, expiry", () => {
    const rows = parseViewerEndorsements([
      {
        record_cid: "bafyrei1",
        endorser_did: "did:key:z6MkOkafor",
        endorsee_did: "did:key:z6MkMei",
        category: "cs.AI",
        expires_at: "2030-01-02T03:04:05Z",
        expiry: "2030-01-02T03:04:05Z",
      },
      {
        record_cid: "bafyrei2",
        endorser_did: "did:key:z6MkOkafor",
        endorsee_did: "did:key:z6MkMei",
        category: "cs.MA",
        expires_at: null,
        expiry: null,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      recordCid: "bafyrei1",
      endorserDid: "did:key:z6MkOkafor",
      endorseeDid: "did:key:z6MkMei",
      category: "cs.AI",
      expiresAt: "2030-01-02T03:04:05Z",
    });
    expect(rows[1].category).toBe("cs.MA");
    expect(rows[1].expiresAt).toBeNull();
  });

  it("keeps the rows with a category and skips the ones without, so one bad row hides no rights", () => {
    const rows = parseViewerEndorsements([
      { record_cid: "bafyrei1", category: "cs.AI" },
      { record_cid: "bafyrei2", category: "  " },
      { record_cid: "bafyrei3", category: 7 },
    ]);
    expect(rows.map((row) => row.category)).toEqual(["cs.AI"]);
  });

  it("rejects a payload that is not a list of endorsements", () => {
    expect(() => parseViewerEndorsements({ categories: ["cs.AI"] })).toThrow(EndorseInputError);
    expect(() => parseViewerEndorsements("cs.AI")).toThrow(EndorseInputError);
  });
});

describe("viewerFromAccessToken", () => {
  /** A JWT-shaped token whose payload carries the API's `sub` and `tier` claims. */
  function accessJwt(claims: Record<string, unknown>): string {
    const segment = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${segment({ alg: "none" })}.${segment(claims)}.signature`;
  }

  it("reads the viewer's DID and tier from the token claims", () => {
    const viewer = viewerFromAccessToken(
      accessJwt({ sub: "did:key:z6MkMei", tier: 2 }),
    );
    expect(viewer).toEqual({ signedIn: true, did: "did:key:z6MkMei", tier: 2 });
  });

  it("is signed out without a token", () => {
    expect(viewerFromAccessToken(null)).toEqual({ signedIn: false, did: null, tier: null });
    expect(viewerFromAccessToken("")).toEqual({ signedIn: false, did: null, tier: null });
  });

  it("stays signed in with an unknown DID and tier when the token is opaque", () => {
    expect(viewerFromAccessToken("not-a-jwt")).toEqual({
      signedIn: true,
      did: null,
      tier: null,
    });
  });
});

describe("endorseOffer: which categories the viewer may endorse in", () => {
  it("offers exactly the categories of the viewer's active endorsements, deduped and sorted", () => {
    const offer = endorseOffer(
      3,
      parseViewerEndorsements([
        { record_cid: "bafyrei1", category: "cs.MA" },
        { record_cid: "bafyrei2", category: "cs.AI" },
        { record_cid: "bafyrei3", category: "cs.AI" },
      ]),
    );
    expect(offer.categories).toEqual(["cs.AI", "cs.MA"]);
    // Regression (journey 14: okafor's dropdown offered every category): a
    // reviewer endorses only where they are themself endorsed, so there is no
    // "any category" for tier 3.
    expect(offer.anyCategory).toBe(false);
  });

  it("offers a tier-3 viewer with no endorsement of their own nothing at all", () => {
    // The API refuses (403 category-not-endorsed) an endorsement in a category
    // the endorser holds no endorsement in, so there is nothing to offer.
    expect(endorseOffer(3, [])).toEqual(NO_ENDORSE_OFFER);
  });

  it("lets a tier-4 viewer endorse in any category", () => {
    expect(endorseOffer(4, []).anyCategory).toBe(true);
    expect(endorseOffer(4, parseViewerEndorsements([{ record_cid: "b", category: "cs.AI" }])).categories).toEqual([
      "cs.AI",
    ]);
  });

  it("offers an unknown tier only the categories the viewer is endorsed in; the API decides the rest", () => {
    expect(endorseOffer(null, []).anyCategory).toBe(false);
    expect(endorseOffer(null, parseViewerEndorsements([{ record_cid: "b", category: "cs.AI" }])).categories).toEqual([
      "cs.AI",
    ]);
  });

  it("offers a viewer below the endorser tier nothing at all", () => {
    expect(endorseOffer(1, [])).toEqual(NO_ENDORSE_OFFER);
    expect(endorseOffer(0, [])).toEqual(NO_ENDORSE_OFFER);
    expect(ENDORSE_MIN_TIER).toBe(3);
  });

  it("offers a tier-2 viewer nothing, even in a category they are endorsed in", () => {
    // Regression: the API accepts an endorsement only from an author at tier 3
    // or above (`handle_endorsement`), whatever the category. A tier-2 viewer
    // endorsed in cs.AI may *submit* in cs.AI, not endorse there.
    const endorsed = parseViewerEndorsements([
      { record_cid: "bafyrei1", category: "cs.AI" },
    ]);
    expect(endorseOffer(2, endorsed)).toEqual(NO_ENDORSE_OFFER);
  });
});

describe("endorseChoices: what the Endorse dropdown lists", () => {
  const taxonomy = [
    {
      label: "Computer science",
      categories: [
        { id: "cs.AI", name: "Artificial intelligence" },
        { id: "cs.LG", name: "Machine learning" },
        { id: "cs.MA", name: "Multiagent systems" },
      ],
    },
    { label: "Statistics", categories: [{ id: "stat.ML", name: "Machine learning" }] },
  ];
  const ids = (groups: ReturnType<typeof endorseChoices>) =>
    groups.flatMap((group) => group.categories.map((category) => category.id));

  it("lists only the categories a tier-3 viewer is endorsed in", () => {
    const offer = { categories: ["cs.AI", "cs.MA"], anyCategory: false };
    expect(ids(endorseChoices(offer, taxonomy, []))).toEqual(["cs.AI", "cs.MA"]);
  });

  it("lists every category for a tier-4 viewer", () => {
    const offer = { categories: [], anyCategory: true };
    expect(ids(endorseChoices(offer, taxonomy, []))).toEqual(["cs.AI", "cs.LG", "cs.MA", "stat.ML"]);
  });

  it("leaves out a category already endorsed, and a group left empty", () => {
    const offer = { categories: ["cs.AI", "stat.ML"], anyCategory: false };
    const groups = endorseChoices(offer, taxonomy, ["stat.ML"]);
    expect(ids(groups)).toEqual(["cs.AI"]);
    expect(groups.map((group) => group.label)).toEqual(["Computer science"]);
  });

  it("still lists a category the taxonomy does not name, under its own id", () => {
    const offer = { categories: ["xx.NEW"], anyCategory: false };
    expect(endorseChoices(offer, taxonomy, [])).toEqual([
      { label: "Other", categories: [{ id: "xx.NEW", name: "xx.NEW" }] },
    ]);
  });
});

describe("endorseResearcher", () => {
  const input = { endorseeDid: "did:key:z6MkNewcomer", category: "cs.AI" };

  it("signs an endorsement record and posts it; returns the accepted cid", async () => {
    const sign = vi.fn().mockResolvedValue(signedRecord());
    const submit = vi.fn().mockResolvedValue({ id: "bafyreiendorse", state: "accepted" });

    const result = await endorseResearcher(input, { sign, submit });

    expect(sign).toHaveBeenCalledExactlyOnceWith(
      "endorsement",
      { endorsee: "did:key:z6MkNewcomer", category: "cs.AI" },
      null,
    );
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "bafyreiendorse" }));
    expect(result).toEqual({ recordCid: "bafyreiendorse", category: "cs.AI", state: "accepted" });
  });

  it("reports the signed record's own cid when the answer names none", async () => {
    const result = await endorseResearcher(input, {
      sign: vi.fn().mockResolvedValue(signedRecord()),
      submit: vi.fn().mockResolvedValue({}),
    });
    expect(result.recordCid).toBe("bafyreiendorse");
  });

  it("refuses a malformed input before any prompt is shown", async () => {
    const sign = vi.fn();
    const submit = vi.fn();
    await expect(
      endorseResearcher({ endorseeDid: "newcomer", category: "cs.AI" }, { sign, submit }),
    ).rejects.toBeInstanceOf(EndorseInputError);
    await expect(
      endorseResearcher({ endorseeDid: "did:key:z6MkNewcomer", category: "  " }, { sign, submit }),
    ).rejects.toBeInstanceOf(EndorseInputError);
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a signer that produced another record type", async () => {
    await expect(
      endorseResearcher(input, {
        sign: vi.fn().mockResolvedValue(signedRecord({ type: "flag" })),
        submit: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WrongEndorsementRecordError);
  });
});

describe("describeEndorseError", () => {
  it("says what the API said, verbatim, when it refused the endorsement", () => {
    const error = new ApiError(403, {
      detail:
        "An endorsement may only be issued by tier 3 (Reviewer) or higher; the endorser did:key:z6MkMei is tier 2 (Author).",
    });
    expect(describeEndorseError(error)).toContain("tier 3 (Reviewer) or higher");
  });

  it("asks an expired session to sign in", () => {
    expect(describeEndorseError(new ApiError(401, { detail: "Token expired." }))).toBe(
      "Sign in to endorse researchers.",
    );
  });

  it("explains a dismissed passkey prompt: nothing was endorsed", () => {
    expect(describeEndorseError(new PasskeyCancelledError())).toContain("dismissed");
    expect(describeEndorseError(new PasskeyCancelledError())).toContain("Nothing was endorsed.");
  });

  it("names the network when the API could not be reached", () => {
    expect(describeEndorseError(new NetworkError("/v1/records"))).toMatch(/could not reach/);
  });

  it("passes an input error's own words through", () => {
    expect(describeEndorseError(new EndorseInputError("Name a category."))).toBe(
      "Name a category.",
    );
  });
});

describe("labels", () => {
  it("names the action and its done state after the category", () => {
    expect(endorseActionLabel("cs.AI")).toBe("Endorse in cs.AI");
    // The ✓ mark carries the done state besides colour (docs/design.md §9).
    expect(endorsedActionLabel("cs.AI")).toBe("✓ Endorsed in cs.AI");
  });

  it("exposes the endpoint the viewer's endorsements come from", () => {
    expect(MY_ENDORSEMENTS_ENDPOINT).toBe("/me/endorsements");
  });
});

/* -------------------------------------------------------------------------- */
/* What a profile shows: the endorsements its person holds                     */
/* -------------------------------------------------------------------------- */

function profileRow(overrides: Partial<ProfileEndorsement> = {}): ProfileEndorsement {
  return {
    recordCid: "bafyrei1",
    endorserDid: "did:key:z6MkOkafor",
    endorserName: "Tunde Okafor",
    endorseeDid: "did:key:z6MkNewcomer",
    category: "cs.AI",
    endorsedAt: "2026-11-17T09:30:00Z",
    expiresAt: null,
    ...overrides,
  };
}

describe("profileEndorsementsEndpoint", () => {
  it("names the DID once, percent-encoded, under /profiles", () => {
    expect(profileEndorsementsEndpoint("did:key:z6MkNewcomer")).toBe(
      "/profiles/did%3Akey%3Az6MkNewcomer/endorsements",
    );
  });
});

describe("parseProfileEndorsements", () => {
  it("reads category, endorser (DID and public name) and the date", () => {
    const rows = parseProfileEndorsements([
      {
        record_cid: "bafyrei1",
        endorser_did: "did:key:z6MkOkafor",
        endorser_name: "Tunde Okafor",
        endorsee_did: "did:key:z6MkNewcomer",
        category: "cs.AI",
        endorsed_at: "2026-11-17T09:30:00Z",
        expires_at: null,
      },
    ]);
    expect(rows).toEqual([profileRow()]);
  });

  it("reads an endorser with no public name or date as null, not as an empty string", () => {
    const [row] = parseProfileEndorsements([
      {
        record_cid: "bafyrei2",
        endorser_did: "did:key:z6MkOkafor",
        endorser_name: "  ",
        endorsee_did: "did:key:z6MkNewcomer",
        category: "cs.MA",
        endorsed_at: null,
      },
    ]);
    expect(row.endorserName).toBeNull();
    expect(row.endorsedAt).toBeNull();
  });

  it("skips a row without a category or an endorser, and refuses a payload that is not a list", () => {
    const rows = parseProfileEndorsements([
      { record_cid: "a", endorser_did: "did:key:z6MkOkafor", category: "cs.AI" },
      { record_cid: "b", endorser_did: "did:key:z6MkOkafor", category: " " },
      { record_cid: "c", category: "cs.AI" },
      "cs.AI",
    ]);
    expect(rows.map((row) => row.recordCid)).toEqual(["a"]);
    expect(() => parseProfileEndorsements({ items: [] })).toThrow(EndorseInputError);
  });
});

describe("loadProfileEndorsements", () => {
  it("reads the public list for the DID without a token, fresh every time", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        record_cid: "bafyrei1",
        endorser_did: "did:key:z6MkOkafor",
        endorser_name: "Tunde Okafor",
        endorsee_did: "did:key:z6MkNewcomer",
        category: "cs.AI",
        endorsed_at: "2026-11-17T09:30:00Z",
        expires_at: null,
      },
    ]);

    const rows = await loadProfileEndorsements("did:key:z6MkNewcomer", { get });

    expect(get).toHaveBeenCalledExactlyOnceWith(
      "/profiles/did%3Akey%3Az6MkNewcomer/endorsements",
      { auth: false, cache: "no-store" },
    );
    expect(rows).toEqual([profileRow()]);
  });
});

describe("categoriesEndorsedBy", () => {
  const rows = [
    profileRow({ recordCid: "1", category: "cs.MA" }),
    profileRow({ recordCid: "2", category: "cs.AI" }),
    profileRow({ recordCid: "3", category: "cs.AI", endorserDid: "did:key:z6MkMei" }),
    profileRow({ recordCid: "4", category: "cs.LG", endorserDid: "did:key:z6MkMei" }),
  ];

  it("lists, sorted and once each, the categories this viewer has already endorsed in", () => {
    expect(categoriesEndorsedBy("did:key:z6MkOkafor", rows)).toEqual(["cs.AI", "cs.MA"]);
    expect(categoriesEndorsedBy("did:key:z6MkMei", rows)).toEqual(["cs.AI", "cs.LG"]);
  });

  it("is empty for a viewer who endorsed nobody here, and for a viewer whose DID is unknown", () => {
    expect(categoriesEndorsedBy("did:key:z6MkStranger", rows)).toEqual([]);
    expect(categoriesEndorsedBy(null, rows)).toEqual([]);
  });
});

describe("groupEndorsementsByCategory", () => {
  it("groups by category in category order, keeping each endorser", () => {
    const groups = groupEndorsementsByCategory([
      profileRow({ recordCid: "1", category: "cs.LG" }),
      profileRow({ recordCid: "2", category: "cs.AI" }),
      profileRow({ recordCid: "3", category: "cs.AI", endorserDid: "did:key:z6MkMei" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["cs.AI", "cs.LG"]);
    expect(groups[0].endorsements.map((row) => row.recordCid)).toEqual(["2", "3"]);
  });
});

describe("endorserLabel", () => {
  it("shows the endorser's public name when they have one", () => {
    expect(endorserLabel(profileRow())).toBe("Tunde Okafor");
  });

  it("shows the DID, shortened, when they do not", () => {
    expect(
      endorserLabel(
        profileRow({
          endorserName: null,
          endorserDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
        }),
      ),
    ).toBe("did:key:z6MkpTHR…sdvktH");
  });
});

describe("formatEndorsementDate", () => {
  it("writes the day in the reader's own time zone, as every page does", () => {
    // 23:30 UTC on the 17th is the 18th in Sydney (GMT+11): an endorsement
    // made after local midnight is dated the day it was made.
    expect(formatEndorsementDate("2026-11-17T23:30:00Z")).toBe("18 Nov 2026");
    expect(formatEndorsementDate("2026-11-17T09:30:00Z")).toBe("17 Nov 2026");
    expect(formatEndorsementDate("2026-01-02T00:00:00Z")).toBe("2 Jan 2026");
  });

  it("is null for no date or one that is not a date", () => {
    expect(formatEndorsementDate(null)).toBeNull();
    expect(formatEndorsementDate("soon")).toBeNull();
  });
});
