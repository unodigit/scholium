import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";

import {
  POLICIES_ENDPOINT,
  POLICIES_PATH,
  PolicyListError,
  describePoliciesError,
  loadPolicies,
  parsePolicyClauses,
  policyAnchorId,
  policyHref,
  type PoliciesClient,
} from "./policies";

/** A client whose only method is `get`, returning `payload`. */
function clientReturning(payload: unknown) {
  const get = vi.fn(async () => payload);
  return { client: { get } as unknown as PoliciesClient, get };
}

const CLAUSES = [
  { id: "MOD-01", title: "Out of scope", text: "Scholarly manuscripts only." },
  {
    id: "MOD-02",
    title: "Plagiarism and unattributed overlap",
    text: "Every source must be attributed.",
  },
];

describe("parsePolicyClauses", () => {
  it("keeps the API's order and the id, title and text", () => {
    expect(parsePolicyClauses(CLAUSES)).toEqual(CLAUSES);
  });

  it("trims surrounding whitespace and ignores extra fields", () => {
    expect(
      parsePolicyClauses([
        { id: " MOD-01 ", title: " Out of scope ", text: " Text. ", note: "x" },
      ]),
    ).toEqual([{ id: "MOD-01", title: "Out of scope", text: "Text." }]);
  });

  it("accepts an empty list — a node may publish no clauses yet", () => {
    expect(parsePolicyClauses([])).toEqual([]);
  });

  it("rejects a payload that is not a list", () => {
    expect(() => parsePolicyClauses({ clauses: CLAUSES })).toThrow(PolicyListError);
    expect(() => parsePolicyClauses(null)).toThrow(PolicyListError);
  });

  it.each(["id", "title", "text"] as const)(
    "rejects a clause with a missing %s",
    (field) => {
      const broken: Record<string, unknown> = { ...CLAUSES[0] };
      delete broken[field];
      expect(() => parsePolicyClauses([broken])).toThrow(PolicyListError);
    },
  );

  it("rejects blank and non-string fields", () => {
    expect(() =>
      parsePolicyClauses([{ id: "MOD-01", title: "  ", text: "Text." }]),
    ).toThrow(PolicyListError);
    expect(() =>
      parsePolicyClauses([{ id: 1, title: "Title", text: "Text." }]),
    ).toThrow(PolicyListError);
  });

  it("rejects duplicate clause ids: one anchor cannot mean two rules", () => {
    expect(() => parsePolicyClauses([CLAUSES[0], CLAUSES[0]])).toThrow(
      /appears twice/,
    );
  });

  it("rejects two ids that slugify to the same anchor", () => {
    expect(() =>
      parsePolicyClauses([
        { id: "A B", title: "First", text: "Text." },
        { id: "A-B", title: "Second", text: "Text." },
      ]),
    ).toThrow(/shares the anchor/);
  });
});

describe("policy anchors", () => {
  it("uses the clause id unchanged, as decision banners expect", () => {
    expect(policyAnchorId("MOD-01")).toBe("MOD-01");
    expect(policyAnchorId("MOD-02")).toBe("MOD-02");
  });

  it("trims and slugifies an id that is not already fragment-safe", () => {
    expect(policyAnchorId("  MOD-03  ")).toBe("MOD-03");
    expect(policyAnchorId("2.1 In scope")).toBe("2.1-In-scope");
    expect(policyAnchorId("a/b")).toBe("a-b");
  });

  it("never returns an empty id", () => {
    expect(policyAnchorId("")).toBe("policy");
    expect(policyAnchorId("   ")).toBe("policy");
    expect(policyAnchorId("!!!")).toBe("policy");
  });

  it("builds the /policies link a decision banner should use", () => {
    expect(policyHref("MOD-02")).toBe("/policies#MOD-02");
    expect(policyHref("2.1 In scope")).toBe("/policies#2.1-In-scope");
    expect(POLICIES_PATH).toBe("/policies");
  });
});

describe("loadPolicies", () => {
  it("calls GET /v1/moderation/policies anonymously and uncached", async () => {
    const { client, get } = clientReturning(CLAUSES);

    await expect(loadPolicies(client)).resolves.toEqual(CLAUSES);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(POLICIES_ENDPOINT, {
      auth: false,
      cache: "no-store",
    });
    expect(POLICIES_ENDPOINT).toBe("/moderation/policies");
  });

  it("surfaces a malformed body as a PolicyListError", async () => {
    const { client } = clientReturning([{ id: "MOD-01" }]);

    await expect(loadPolicies(client)).rejects.toBeInstanceOf(PolicyListError);
  });
});

describe("describePoliciesError", () => {
  it("explains an unreachable API in plain language", () => {
    expect(describePoliciesError(new NetworkError("http://localhost:8000"))).toMatch(
      /could not reach the API/i,
    );
  });

  it("prefers the API's problem detail", () => {
    const error = new ApiError(503, {
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      detail: "The node is starting up.",
    });
    expect(describePoliciesError(error)).toBe("The node is starting up.");
  });

  it("passes through a malformed-payload message", () => {
    expect(
      describePoliciesError(new PolicyListError("The API did not return a policy clause list.")),
    ).toBe("The API did not return a policy clause list.");
  });

  it("has a fallback for values that are not errors", () => {
    expect(describePoliciesError("nope")).toBe("The policy list could not be loaded.");
  });
});
