import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  SUBMIT_MIN_TIER,
  describeBlocker,
  endorsementHelpHref,
  fetchEligibility,
  findBlockers,
  formatAllowedAt,
  submissionProblemMessage,
  type EligibilityFacts,
} from "./eligibility";

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** Noon UTC on a Tuesday, so every viewer's calendar agrees on which week it is. */
const NEXT = new Date("2026-11-24T12:00:00Z");

const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  tier: 2,
  endorsedCategories: ["cs.AI", "cs.LG"],
  nextAllowedAt: null,
  name: "Mei Chen",
  ...over,
});

describe("findBlockers", () => {
  it("finds nothing for an Author endorsed in the chosen categories", () => {
    expect(findBlockers(facts(), ["cs.AI"])).toEqual([]);
    expect(findBlockers(facts(), [])).toEqual([]);
  });

  it("blocks a viewer below tier 2, and says nothing more about categories", () => {
    expect(SUBMIT_MIN_TIER).toBe(2);
    const blockers = findBlockers(facts({ tier: 1, endorsedCategories: [] }), ["cs.AI"]);
    expect(blockers).toEqual([{ kind: "tier", tier: 1 }]);
  });

  it("blocks an Author who holds no endorsement at all", () => {
    expect(findBlockers(facts({ endorsedCategories: [] }), [])).toEqual([{ kind: "no-endorsement" }]);
  });

  it("names every chosen category the viewer is not endorsed in, in the order chosen", () => {
    expect(findBlockers(facts(), ["cs.CL", "cs.AI", "math.CO"])).toEqual([
      { kind: "categories", missing: ["cs.CL", "math.CO"], endorsed: ["cs.AI", "cs.LG"] },
    ]);
  });

  it("blocks on the weekly limit while the next allowed moment is in the future", () => {
    const now = new Date("2026-11-20T09:00:00Z");
    expect(findBlockers(facts({ nextAllowedAt: NEXT }), ["cs.AI"], now)).toEqual([
      { kind: "weekly-limit", nextAllowedAt: NEXT },
    ]);
    // Once the window has passed it is no longer a blocker.
    expect(findBlockers(facts({ nextAllowedAt: NEXT }), ["cs.AI"], new Date("2026-11-25T00:00:00Z"))).toEqual([]);
  });

  it("reports more than one problem at once, so the viewer fixes them together", () => {
    const now = new Date("2026-11-20T09:00:00Z");
    const kinds = findBlockers(facts({ nextAllowedAt: NEXT }), ["cs.CL"], now).map((b) => b.kind);
    expect(kinds).toEqual(["categories", "weekly-limit"]);
  });

  it("does not guess: facts the API could not give are not blockers", () => {
    const unknown = facts({ tier: null, endorsedCategories: null });
    expect(findBlockers(unknown, ["cs.AI"])).toEqual([]);
  });
});

describe("formatAllowedAt", () => {
  it("writes the date in the viewer's locale, not as an ISO string", () => {
    const gb = formatAllowedAt(NEXT, { locale: "en-GB", timeZone: "UTC" });
    const us = formatAllowedAt(NEXT, { locale: "en-US", timeZone: "UTC" });
    expect(gb).toContain("24 November 2026");
    expect(gb).toContain("Tuesday");
    expect(us).toContain("November 24, 2026");
    for (const text of [gb, us]) {
      expect(text).not.toMatch(/T\d\d:\d\d/);
      expect(text).not.toContain("2026-11-24");
    }
  });
});

describe("describeBlocker", () => {
  const opts = { locale: "en-GB", timeZone: "UTC", did: ME } as const;

  it("explains the tier rule in plain words and points at how to get endorsed", () => {
    const message = describeBlocker({ kind: "tier", tier: 1 }, opts);
    expect(message.title).toMatch(/Author account/);
    expect(message.body).toMatch(/Member/);
    expect(message.body).toMatch(/endorse/i);
    expect(message.help).toEqual({ href: `/u/${encodeURIComponent(ME)}`, label: "How to get endorsed" });
  });

  it("names the categories the viewer is not endorsed in, and the ones they are", () => {
    const message = describeBlocker(
      { kind: "categories", missing: ["cs.CL", "math.CO"], endorsed: ["cs.AI"] },
      opts,
    );
    expect(message.title).toMatch(/not endorsed in cs\.CL and math\.CO/);
    expect(message.body).toMatch(/cs\.AI/);
    expect(message.help?.label).toBe("How to get endorsed");
  });

  it("uses the singular for one category and the plural for several", () => {
    const one = describeBlocker({ kind: "categories", missing: ["cs.CL"], endorsed: [] }, opts);
    const many = describeBlocker({ kind: "categories", missing: ["cs.CL", "cs.CV"], endorsed: [] }, opts);
    expect(one.body).toMatch(/this category/);
    expect(many.body).toMatch(/these categories/);
  });

  it("says when the next paper can be started, in the viewer's locale", () => {
    const message = describeBlocker({ kind: "weekly-limit", nextAllowedAt: NEXT }, opts);
    expect(message.title).toMatch(/one new paper a week/i);
    expect(message.body).toContain("24 November 2026");
    expect(message.help).toBeNull();
  });

  it("never shows a record type or an ISO timestamp", () => {
    const blockers = [
      { kind: "tier", tier: 0 },
      { kind: "no-endorsement" },
      { kind: "categories", missing: ["cs.CL"], endorsed: [] },
      { kind: "weekly-limit", nextAllowedAt: NEXT },
    ] as const;
    for (const blocker of blockers) {
      const { title, body } = describeBlocker(blocker, opts);
      expect(`${title} ${body}`).not.toMatch(/paper\.genesis|paper\.version|\d{4}-\d\d-\d\dT/);
    }
  });

  it("falls back to the profile page when no DID is known", () => {
    expect(endorsementHelpHref(null)).toBe("/me");
    expect(endorsementHelpHref(ME)).toBe(`/u/${encodeURIComponent(ME)}`);
  });
});

describe("submissionProblemMessage", () => {
  const opts = { locale: "en-GB", timeZone: "UTC", did: ME } as const;

  const problem = (status: number, body: Record<string, unknown>): ApiError =>
    new ApiError(status, { status, title: "x", ...body });

  it("turns the weekly-limit refusal into a sentence with the viewer's date", () => {
    const error = problem(429, {
      type: "urn:scholium:problem:genesis-rate-limited",
      detail:
        "A tier-2 account younger than 90 days may start one paper per week; " +
        "the next paper.genesis is allowed at 2026-11-24T12:00:00Z.",
      next_allowed_at: "2026-11-24T12:00:00Z",
      next_allowed_date: "2026-11-24T12:00:00Z",
    });
    const text = submissionProblemMessage(error, opts);
    expect(text).toContain("24 November 2026");
    expect(text).not.toContain("paper.genesis");
    expect(text).not.toContain("2026-11-24T12:00:00Z");
  });

  it("turns a category refusal into the categories to drop or get endorsed for", () => {
    const error = problem(403, {
      type: "urn:scholium:problem:category-not-endorsed",
      detail: "A paper.genesis record needs an active endorsement in every category it lists.",
      unendorsed_categories: ["cs.CL", "cs.CV"],
    });
    const text = submissionProblemMessage(error, opts);
    expect(text).toMatch(/cs\.CL and cs\.CV/);
    expect(text).not.toContain("paper.genesis");
  });

  it("turns a tier refusal into the tier words, not 'tier 1 (Member)' plumbing", () => {
    const error = problem(403, {
      type: "urn:scholium:problem:insufficient-tier",
      detail: "A 'paper.genesis' record may only be submitted by tier 2 (Author) or higher; its author did:key:z6Mk is tier 1 (Member).",
      required_tier: 2,
      author_tier: 1,
    });
    const text = submissionProblemMessage(error, opts);
    expect(text).toMatch(/Author account/);
    expect(text).not.toContain("paper.genesis");
    expect(text).not.toContain("did:key");
  });

  it("scrubs record types and ISO timestamps out of a problem it has no mapping for", () => {
    const error = problem(409, {
      type: "urn:scholium:problem:something-new",
      detail: "The paper.version was refused; try again after 2026-11-24T12:00:00Z.",
    });
    const text = submissionProblemMessage(error, opts);
    expect(text).not.toContain("paper.version");
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    expect(text).toContain("24 November 2026");
  });

  it("keeps an ordinary error's own words, and handles things that are not errors", () => {
    expect(submissionProblemMessage(new Error("Passkey prompt was dismissed."), opts)).toBe(
      "Passkey prompt was dismissed.",
    );
    expect(submissionProblemMessage("boom", opts)).toBe("boom");
    expect(submissionProblemMessage(undefined, opts)).toMatch(/could not be submitted/i);
  });
});

describe("fetchEligibility", () => {
  it("reads the tier and name from the profile and the categories from the endorsements", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/profiles/")) return { did: ME, name: "Mei Chen", tier: 2 };
      if (path === "/me/endorsements") {
        return [
          { category: "cs.AI", expires_at: null },
          { category: "cs.LG", expires_at: "2099-01-01T00:00:00Z" },
        ];
      }
      throw new Error(`unexpected ${path}`);
    });
    const result = await fetchEligibility(ME, { get } as never);
    expect(result).toEqual({
      tier: 2,
      endorsedCategories: ["cs.AI", "cs.LG"],
      nextAllowedAt: null,
      name: "Mei Chen",
    });
    expect(get).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(ME)}`, expect.anything());
  });

  it("leaves what it could not read unknown instead of failing the whole check", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/me/endorsements") return [{ category: "cs.AI" }];
      throw new ApiError(404, { status: 404, title: "Not Found" });
    });
    const result = await fetchEligibility(ME, { get } as never);
    expect(result).toEqual({ tier: null, endorsedCategories: ["cs.AI"], nextAllowedAt: null, name: null });
  });

  it("does not ask for a profile when no DID is known", async () => {
    const get = vi.fn(async () => []);
    const result = await fetchEligibility(null, { get } as never);
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("/profiles/"), expect.anything());
    expect(result.tier).toBeNull();
  });
});
