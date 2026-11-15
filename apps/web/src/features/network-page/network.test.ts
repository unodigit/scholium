import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";

import {
  ANCHOR_STATUS_PENDING,
  LOCAL_STANDING,
  NETWORK_ENDPOINT,
  NETWORK_PATH,
  NETWORK_TITLE,
  NetworkStatusError,
  anchorSpec,
  describeNetworkError,
  loadNetworkStatus,
  moderationCountLine,
  parseNetworkStatus,
  replicaSegments,
  standingSpec,
  type NetworkClient,
} from "./network";

/** A client whose only method is `get`, returning `payload`. */
function clientReturning(payload: unknown) {
  const get = vi.fn(async () => payload);
  return { client: { get } as unknown as NetworkClient, get };
}

/** The documented `GET /v1/network` body (feature 127's docstring), verbatim. */
const DOCUMENT = {
  node_did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  standing: "local",
  log_head: { seq: 41, entry_hash: "9f86d081884c7d659a2feaa0c55ad015" },
  last_anchor: { status: "pending" },
  replicas: { have: 1, of: 1, local: true, summary: "1 of 1 local" },
  moderation: { total: 3, by_clause: { "MOD-01": 2, "MOD-04": 1 } },
};

describe("parseNetworkStatus", () => {
  it("keeps every field of a well-formed document", () => {
    expect(parseNetworkStatus(DOCUMENT)).toEqual(DOCUMENT);
  });

  it("trims surrounding whitespace and ignores extra fields", () => {
    expect(
      parseNetworkStatus({
        ...DOCUMENT,
        node_did: ` ${DOCUMENT.node_did} `,
        standing: " local ",
        log_head: { seq: 7, entry_hash: " abc ", extra: true },
        probes: { pass_rate: 1 },
      }),
    ).toEqual({
      ...DOCUMENT,
      node_did: DOCUMENT.node_did,
      standing: "local",
      log_head: { seq: 7, entry_hash: "abc" },
    });
  });

  it("keeps the API's clause order", () => {
    const parsed = parseNetworkStatus({
      ...DOCUMENT,
      moderation: { total: 6, by_clause: { "MOD-10": 1, "MOD-02": 3, "MOD-04": 2 } },
    });

    expect(Object.keys(parsed.moderation.by_clause)).toEqual([
      "MOD-10",
      "MOD-02",
      "MOD-04",
    ]);
  });

  it("accepts an empty log: seq 0 and the genesis hash are facts, not errors", () => {
    const parsed = parseNetworkStatus({
      ...DOCUMENT,
      log_head: { seq: 0, entry_hash: "0".repeat(64) },
      moderation: { total: 0, by_clause: {} },
    });

    expect(parsed.log_head.seq).toBe(0);
    expect(parsed.moderation.total).toBe(0);
    expect(parsed.moderation.by_clause).toEqual({});
  });

  it("rejects a payload that is not a document", () => {
    expect(() => parseNetworkStatus([DOCUMENT])).toThrow(NetworkStatusError);
    expect(() => parseNetworkStatus(null)).toThrow(
      /did not return a network status document/,
    );
  });

  it.each(["node_did", "standing"] as const)(
    "rejects a missing or blank %s",
    (field) => {
      const broken: Record<string, unknown> = { ...DOCUMENT, [field]: "  " };
      expect(() => parseNetworkStatus(broken)).toThrow(NetworkStatusError);
      delete broken[field];
      expect(() => parseNetworkStatus(broken)).toThrow(
        new RegExp(`has no usable ${field}`),
      );
    },
  );

  it.each(["log_head", "last_anchor", "replicas", "moderation"] as const)(
    "rejects a %s that is not an object",
    (field) => {
      expect(() =>
        parseNetworkStatus({ ...DOCUMENT, [field]: "nope" }),
      ).toThrow(new RegExp(`has no usable ${field}`));
    },
  );

  it("rejects a log head without a whole-number seq or a usable hash", () => {
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, log_head: { seq: 1.5, entry_hash: "ab" } }),
    ).toThrow(/has no usable seq/);
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, log_head: { seq: -1, entry_hash: "ab" } }),
    ).toThrow(/has no usable seq/);
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, log_head: { seq: 3, entry_hash: "" } }),
    ).toThrow(/has no usable entry_hash/);
  });

  it("rejects an anchor without a status", () => {
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, last_anchor: {} }),
    ).toThrow(/has no usable status/);
  });

  it("rejects a replica summary that is not a pair of whole numbers and a flag", () => {
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, replicas: { ...DOCUMENT.replicas, have: 1.5 } }),
    ).toThrow(/has no usable have/);
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, replicas: { ...DOCUMENT.replicas, of: 0 } }),
    ).toThrow(/has no usable of/);
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, replicas: { ...DOCUMENT.replicas, local: "yes" } }),
    ).toThrow(/has no usable local flag/);
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, replicas: { ...DOCUMENT.replicas, summary: "" } }),
    ).toThrow(/has no usable summary/);
  });

  it("rejects moderation counts that are not whole numbers", () => {
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        moderation: { total: 2, by_clause: { "MOD-01": 1.5 } },
      }),
    ).toThrow(/is not a whole number/);
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        moderation: { total: 2, by_clause: { "MOD-01": -1 } },
      }),
    ).toThrow(/is not a whole number/);
  });

  it("rejects a by_clause that is not an object", () => {
    expect(() =>
      parseNetworkStatus({ ...DOCUMENT, moderation: { total: 1, by_clause: [] } }),
    ).toThrow(/has no usable by_clause/);
  });

  it("rejects a blank clause id and duplicate ids that differ only in whitespace", () => {
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        moderation: { total: 1, by_clause: { "  ": 1 } },
      }),
    ).toThrow(/blank id/);
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        moderation: { total: 2, by_clause: { "MOD-01": 1, " MOD-01 ": 1 } },
      }),
    ).toThrow(/appears twice/);
  });
});

describe("standingSpec", () => {
  it("gives the local standing its word and its calm sentence", () => {
    const spec = standingSpec(LOCAL_STANDING);

    expect(spec.label).toBe("Local");
    expect(spec.meaning).toMatch(/no federation yet/);
    expect(spec.tone).toBe("neutral");
  });

  it("keeps an unknown standing honest: the raw word, a neutral chip", () => {
    const spec = standingSpec("federated");

    expect(spec.label).toBe("federated");
    expect(spec.tone).toBe("neutral");
  });

  it("never shows an empty word", () => {
    expect(standingSpec("   ").label).toBe("Unknown");
  });
});

describe("anchorSpec", () => {
  it("gives pending its word and the calm public-timestamp sentence", () => {
    const spec = anchorSpec(ANCHOR_STATUS_PENDING);

    expect(spec.label).toBe("Anchor pending");
    expect(spec.meaning).toMatch(/public timestamp will be added/);
    expect(spec.tone).toBe("pending");
  });

  it("keeps an unknown status honest: the raw word, a neutral chip", () => {
    const spec = anchorSpec("anchored");

    expect(spec.label).toBe("Anchor anchored");
    expect(spec.tone).toBe("neutral");
  });
});

describe("replicaSegments", () => {
  it("fills the segments the node holds: 1 of 1 local is one filled bar", () => {
    expect(replicaSegments(DOCUMENT.replicas)).toEqual([true]);
  });

  it("marks missing replicas as unfilled: 3 of 5", () => {
    expect(replicaSegments({ have: 3, of: 5, local: false, summary: "3 of 5" })).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("never draws more filled segments than the meter has", () => {
    expect(replicaSegments({ have: 7, of: 2, local: true, summary: "7 of 2" })).toEqual([
      true,
      true,
    ]);
  });

  it("shows an empty meter when the node holds none of its copies", () => {
    expect(replicaSegments({ have: 0, of: 2, local: true, summary: "0 of 2" })).toEqual([
      false,
      false,
    ]);
  });
});

describe("moderationCountLine", () => {
  it("is singular for one decision", () => {
    expect(moderationCountLine(1)).toBe(
      "1 accepted decision, counted by the policy clause it cites.",
    );
  });

  it("is plural for any other count, including zero", () => {
    expect(moderationCountLine(3)).toBe(
      "3 accepted decisions, counted by the policy clause each cites.",
    );
    expect(moderationCountLine(0)).toBe(
      "0 accepted decisions, counted by the policy clause each cites.",
    );
  });
});

describe("loadNetworkStatus", () => {
  it("calls GET /v1/network anonymously and uncached", async () => {
    const { client, get } = clientReturning(DOCUMENT);

    await expect(loadNetworkStatus(client)).resolves.toEqual(DOCUMENT);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(NETWORK_ENDPOINT, {
      auth: false,
      cache: "no-store",
    });
    expect(NETWORK_ENDPOINT).toBe("/network");
    expect(NETWORK_PATH).toBe("/network");
    expect(NETWORK_TITLE).toBe("Network");
  });

  it("surfaces a malformed body as a NetworkStatusError", async () => {
    const { client } = clientReturning({ node_did: "did:key:zPartial" });

    await expect(loadNetworkStatus(client)).rejects.toBeInstanceOf(
      NetworkStatusError,
    );
  });
});

describe("describeNetworkError", () => {
  it("explains an unreachable API in plain language", () => {
    expect(describeNetworkError(new NetworkError("http://localhost:8000"))).toMatch(
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
    expect(describeNetworkError(error)).toBe("The node is starting up.");
  });

  it("falls back to the problem title when there is no detail", () => {
    const error = new ApiError(500, {
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
    });
    expect(describeNetworkError(error)).toBe("Internal Server Error");
  });

  it("passes through a malformed-payload message", () => {
    expect(
      describeNetworkError(
        new NetworkStatusError("The API did not return a network status document."),
      ),
    ).toBe("The API did not return a network status document.");
  });

  it("has a fallback for values that are not errors", () => {
    expect(describeNetworkError("nope")).toBe(
      "The network status could not be loaded.",
    );
  });
});
