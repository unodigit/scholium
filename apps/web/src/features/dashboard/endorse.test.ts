import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError } from "../web-auth";

import {
  ENDORSE_MIN_TIER,
  MY_ENDORSEMENTS_ENDPOINT,
  EndorseInputError,
  WrongEndorsementRecordError,
  describeEndorseError,
  endorseActionLabel,
  endorsedActionLabel,
  endorseOffer,
  endorseResearcher,
  parseViewerEndorsements,
  viewerFromAccessToken,
} from "./endorse";

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
  it("offers exactly the categories of the viewer's active endorsements", () => {
    const offer = endorseOffer(
      2,
      parseViewerEndorsements([
        { record_cid: "bafyrei1", category: "cs.MA" },
        { record_cid: "bafyrei2", category: "cs.AI" },
        { record_cid: "bafyrei3", category: "cs.AI" },
      ]),
    );
    expect(offer.categories).toEqual(["cs.AI", "cs.MA"]);
    expect(offer.anyCategory).toBe(false);
  });

  it("lets a tier-3 viewer endorse in any category (the API's rule for endorsers)", () => {
    expect(endorseOffer(3, []).anyCategory).toBe(true);
    expect(endorseOffer(4, []).anyCategory).toBe(true);
  });

  it("lets an unknown tier through to the API, which decides", () => {
    expect(endorseOffer(null, []).anyCategory).toBe(true);
  });

  it("offers a viewer below the endorser tier nothing but their endorsed categories", () => {
    expect(endorseOffer(1, []).anyCategory).toBe(false);
    expect(endorseOffer(0, []).anyCategory).toBe(false);
    expect(ENDORSE_MIN_TIER).toBe(3);
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
