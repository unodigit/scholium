import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  FlagReadError,
  classifyFlagsError,
  flagDecisionHref,
  flagSignal,
  formatFlagReason,
  isFlagOpen,
  loadFlag,
  loadFlags,
  parseFlag,
  parseFlags,
  type FlagEntry,
} from "./flags";

/** A flag exactly as `GET /v1/flags/{id}` serialises it (flags/router.py `_to_dict`). */
function wireFlag(overrides: Record<string, unknown> = {}) {
  return {
    id: "flag-1",
    flag_id: "flag-1",
    flagId: "flag-1",
    target_cid: "bafy-target-1",
    targetCid: "bafy-target-1",
    reporter_did: "did:key:z6MkReporter",
    reporter: "did:key:z6MkReporter",
    reason: "spam",
    category: "spam",
    reasonCategory: "spam",
    status: "pending",
    decision_cid: null,
    decisionCid: null,
    ...overrides,
  };
}

describe("parseFlag", () => {
  it("reads the shape the API serves today", () => {
    expect(parseFlag(wireFlag())).toEqual({
      id: "flag-1",
      targetCid: "bafy-target-1",
      reporterDid: "did:key:z6MkReporter",
      reason: "spam",
      status: "pending",
      decisionCid: null,
    });
  });

  it("reads a decided flag with its decision cid", () => {
    const flag = parseFlag(
      wireFlag({ status: "decided", decision_cid: "bafy-decision", decisionCid: "bafy-decision" }),
    );
    expect(flag.status).toBe("decided");
    expect(flag.decisionCid).toBe("bafy-decision");
    expect(isFlagOpen(flag)).toBe(false);
  });

  it("accepts the camelCase or snake_case spelling of each field", () => {
    const flag = parseFlag({
      flagId: "f2",
      targetCid: "bafy-2",
      reasonCategory: "plagiarism",
      status: "pending",
    });
    expect(flag).toMatchObject({ id: "f2", targetCid: "bafy-2", reason: "plagiarism" });
    expect(flag.reporterDid).toBeNull();
  });

  it("treats a missing status as pending rather than decided", () => {
    expect(isFlagOpen(parseFlag({ id: "f", target_cid: "t", reason: "spam" }))).toBe(true);
  });

  it.each([
    ["a string", "flag"],
    ["null", null],
    ["a list", []],
    ["no id", { target_cid: "t" }],
    ["no target", { id: "f" }],
  ])("rejects %s instead of rendering a blank flag", (_name, payload) => {
    expect(() => parseFlag(payload)).toThrow(FlagReadError);
  });
});

describe("parseFlags", () => {
  it("puts open flags before decided ones and keeps the API order within each", () => {
    const flags = parseFlags([
      wireFlag({ id: "d1", status: "decided" }),
      wireFlag({ id: "o1" }),
      wireFlag({ id: "d2", status: "decided" }),
      wireFlag({ id: "o2" }),
    ]);
    expect(flags.map((flag) => flag.id)).toEqual(["o1", "o2", "d1", "d2"]);
  });

  it("shows a flag listed twice once", () => {
    expect(parseFlags([wireFlag(), wireFlag()])).toHaveLength(1);
  });

  it("returns an empty list for an empty list", () => {
    expect(parseFlags([])).toEqual([]);
  });

  it("rejects a body that is not a list: an empty table would claim nothing is flagged", () => {
    expect(() => parseFlags({ flags: [] })).toThrow(FlagReadError);
    expect(() => parseFlags(null)).toThrow(/list of flags/);
  });

  it("names the flag that cannot be read", () => {
    expect(() => parseFlags([wireFlag(), { id: "x" }])).toThrow(/Flag 2/);
  });
});

describe("flag wording", () => {
  it("title-cases the reason category", () => {
    expect(formatFlagReason("spam")).toBe("Spam");
    expect(formatFlagReason("bad_faith")).toBe("Bad faith");
    expect(formatFlagReason("  ")).toBe("No reason given");
    expect(formatFlagReason("")).toBe("No reason given");
  });

  it("marks a status with an icon and words, never colour alone", () => {
    const open: FlagEntry = parseFlag(wireFlag());
    const done: FlagEntry = parseFlag(wireFlag({ status: "decided" }));
    expect(flagSignal(open)).toEqual({
      tone: "warn",
      icon: "pending",
      text: "Waiting for a moderator",
    });
    expect(flagSignal(done)).toEqual({ tone: "ok", icon: "check", text: "Decided" });
  });

  it("links to the decision view of what was flagged, as one path segment", () => {
    const flag = parseFlag(wireFlag({ target_cid: "bafy/odd id" }));
    expect(flagDecisionHref(flag)).toBe("/mod/bafy%2Fodd%20id");
  });
});

describe("loadFlags and loadFlag", () => {
  it("asks for the list uncached with the session's token", async () => {
    const get = vi.fn(async () => [wireFlag()]);
    const flags = await loadFlags({ get } as never);

    expect(flags).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/flags", { cache: "no-store" });
  });

  it("asks for one flag by an encoded, trimmed id", async () => {
    const get = vi.fn(async () => wireFlag());
    await loadFlag("  a/b c  ", { get } as never);

    expect(get).toHaveBeenCalledWith("/flags/a%2Fb%20c", { cache: "no-store" });
  });
});

describe("classifyFlagsError", () => {
  it("sends a 401 to sign in", () => {
    expect(classifyFlagsError(new ApiError(401, { status: 401 })).kind).toBe("signed-out");
  });

  it("names the moderator tier and repeats the caller's tier on a 403", () => {
    const failure = classifyFlagsError(new ApiError(403, { status: 403, caller_tier: 3 }));
    expect(failure).toMatchObject({ kind: "forbidden", callerTier: 3 });
    expect(failure.message).toContain("trust tier 4");
  });

  it("does not invent a tier the API did not send", () => {
    const failure = classifyFlagsError(new ApiError(403, { status: 403 }));
    expect(failure).toMatchObject({ kind: "forbidden", callerTier: null });
  });

  it.each([404, 405])("reads a %i on the list as a server that has no flag list", (status) => {
    const failure = classifyFlagsError(new ApiError(status, { status }), "list");
    expect(failure.kind).toBe("unsupported");
    expect(failure.message).toContain("does not list flags");
  });

  it("reads a 404 on a lookup as no such flag, not as a missing list", () => {
    const failure = classifyFlagsError(new ApiError(404, { status: 404 }), "lookup");
    expect(failure).toMatchObject({
      kind: "not-found",
      message: "No flag with that id is on this server.",
    });
  });

  it("keeps a 405 on a lookup a plain error", () => {
    expect(classifyFlagsError(new ApiError(405, { status: 405 }), "lookup").kind).toBe("error");
  });

  it("says what the API said for a server error", () => {
    const failure = classifyFlagsError(
      new ApiError(500, { status: 500, detail: "The flag table is locked." }),
    );
    expect(failure).toEqual({ kind: "error", message: "The flag table is locked." });
  });

  it("explains an unreachable API, a malformed list and an unknown throw", () => {
    expect(classifyFlagsError(new NetworkError("offline")).message).toContain("could not reach");
    expect(classifyFlagsError(new FlagReadError("Flag 2 has no id.")).message).toBe(
      "Flag 2 has no id.",
    );
    expect(classifyFlagsError("boom").message).toBe("The flags could not be loaded.");
  });
});
