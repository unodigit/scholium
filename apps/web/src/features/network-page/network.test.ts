import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";

import {
  ANCHOR_STATUS_PENDING,
  EXPORT_ARCHIVE_PATH,
  EXPORT_REBUILD_COMMAND,
  EXPORT_VERIFY_COMMAND,
  LOCAL_STANDING,
  NETWORK_ENDPOINT,
  NETWORK_PATH,
  NETWORK_TITLE,
  NetworkStatusError,
  anchorSpec,
  archiveExportHref,
  describeNetworkError,
  incidentDate,
  listedPapersLine,
  loadNetworkStatus,
  moderationCountLine,
  parseNetworkStatus,
  policyTargetSentence,
  probeSummary,
  replicaHealthSegments,
  replicaHealthSpec,
  replicaSegments,
  standingSpec,
  type NetworkClient,
} from "./network";

// The journeys run east of UTC (GMT+11 in November); pin the zone so the
// reader's-zone dates asserted here are deterministic on any machine.
process.env.TZ = "Australia/Sydney";

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
  operator: "NextGenius",
  software_version: "0.1.0",
  probes: { window_hours: 24, runs: 0, passed: 0, pass_rate: null },
  incidents: [],
  replication_policy: { replicas: 5, operators: 3, jurisdictions: 2 },
  papers_by_replica_health: { meets_policy: 0, below_policy: 0, single_copy: 12 },
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
        future_field: { anything: true },
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

  it.each(["node_did", "standing", "operator", "software_version"] as const)(
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

  it.each([
    "log_head",
    "last_anchor",
    "replicas",
    "moderation",
    "probes",
    "replication_policy",
    "papers_by_replica_health",
  ] as const)(
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

describe("parseNetworkStatus: operator, probes, incidents and replication", () => {
  it("trims the operator name and the software version", () => {
    const parsed = parseNetworkStatus({
      ...DOCUMENT,
      operator: "  Example University Library ",
      software_version: " 1.2.3 ",
    });

    expect(parsed.operator).toBe("Example University Library");
    expect(parsed.software_version).toBe("1.2.3");
  });

  it("keeps 'no probes run yet' as a null pass rate, not zero", () => {
    expect(parseNetworkStatus(DOCUMENT).probes).toEqual({
      window_hours: 24,
      runs: 0,
      passed: 0,
      pass_rate: null,
    });
  });

  it("accepts a measured pass rate, including a rate of exactly zero", () => {
    const probes = { window_hours: 24, runs: 4, passed: 0, pass_rate: 0 };

    expect(parseNetworkStatus({ ...DOCUMENT, probes }).probes).toEqual(probes);
  });

  it.each([
    ["a pass rate above 1", { window_hours: 24, runs: 4, passed: 4, pass_rate: 1.5 }, /pass_rate/],
    ["a negative pass rate", { window_hours: 24, runs: 4, passed: 0, pass_rate: -0.1 }, /pass_rate/],
    ["a text pass rate", { window_hours: 24, runs: 4, passed: 4, pass_rate: "100%" }, /pass_rate/],
    ["a missing pass rate", { window_hours: 24, runs: 0, passed: 0 }, /pass_rate/],
    ["fractional runs", { window_hours: 24, runs: 1.5, passed: 1, pass_rate: 1 }, /runs/],
    ["more passes than runs", { window_hours: 24, runs: 2, passed: 3, pass_rate: 1 }, /passed/],
    ["a zero-hour window", { window_hours: 0, runs: 0, passed: 0, pass_rate: null }, /window_hours/],
  ])("rejects %s", (_name, probes, message) => {
    expect(() => parseNetworkStatus({ ...DOCUMENT, probes })).toThrow(message);
  });

  it("accepts an empty incident log and keeps entries in the API's order", () => {
    const incidents = [
      { occurred_at: "2027-05-04T09:30:00Z", title: "Disk full", detail: "Writes paused for 12 minutes." },
      { occurred_at: "2027-04-01T00:00:00Z", title: "Key rotated", detail: "Planned rotation." },
    ];

    expect(parseNetworkStatus(DOCUMENT).incidents).toEqual([]);
    expect(parseNetworkStatus({ ...DOCUMENT, incidents }).incidents).toEqual(incidents);
  });

  it("rejects an incident log that is not a list of complete entries", () => {
    expect(() => parseNetworkStatus({ ...DOCUMENT, incidents: "none" })).toThrow(
      /has no usable incidents/,
    );
    expect(() => parseNetworkStatus({ ...DOCUMENT, incidents: ["Disk full"] })).toThrow(
      /Incident 1 is not an incident entry/,
    );
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        incidents: [{ occurred_at: "2027-05-04T09:30:00Z", title: "", detail: "x" }],
      }),
    ).toThrow(/has no usable title/);
  });

  it("rejects a replication policy without positive whole numbers", () => {
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        replication_policy: { replicas: 5, operators: 0, jurisdictions: 2 },
      }),
    ).toThrow(/has no usable operators/);
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        replication_policy: { replicas: 5, operators: 3 },
      }),
    ).toThrow(/has no usable jurisdictions/);
  });

  it("rejects replica-health counts that are missing or not whole numbers", () => {
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        papers_by_replica_health: { meets_policy: 0, below_policy: 0 },
      }),
    ).toThrow(/has no usable single_copy/);
    expect(() =>
      parseNetworkStatus({
        ...DOCUMENT,
        papers_by_replica_health: { meets_policy: 0, below_policy: 1.5, single_copy: 1 },
      }),
    ).toThrow(/has no usable below_policy/);
  });
});

describe("policyTargetSentence", () => {
  it("states the replication target in one sentence", () => {
    expect(policyTargetSentence(DOCUMENT.replication_policy)).toBe(
      "Policy target: 5 replicas, 3 operators, 2 jurisdictions.",
    );
  });
});

describe("replicaHealthSpec", () => {
  it("gives each health a word and a plain sentence", () => {
    expect(replicaHealthSpec("meets_policy").label).toBe("Meets policy");
    expect(replicaHealthSpec("below_policy").label).toBe("Below policy");
    expect(replicaHealthSpec("single_copy").label).toBe("Single copy");
    expect(replicaHealthSpec("single_copy").meaning).toMatch(/one copy/i);
  });
});

describe("replicaHealthSegments", () => {
  it("lists the healths that have papers, in policy order, with their counts", () => {
    expect(
      replicaHealthSegments({ meets_policy: 2, below_policy: 0, single_copy: 10 }),
    ).toEqual([
      { health: "meets_policy", count: 2 },
      { health: "single_copy", count: 10 },
    ]);
  });

  it("draws no segment when nothing is listed", () => {
    expect(
      replicaHealthSegments({ meets_policy: 0, below_policy: 0, single_copy: 0 }),
    ).toEqual([]);
  });
});

describe("listedPapersLine", () => {
  it("counts the listed papers across every health", () => {
    expect(listedPapersLine({ meets_policy: 2, below_policy: 1, single_copy: 9 })).toBe(
      "12 listed papers, by replica health.",
    );
    expect(listedPapersLine({ meets_policy: 0, below_policy: 0, single_copy: 1 })).toBe(
      "1 listed paper, by replica health.",
    );
  });

  it("says so when no paper is listed yet", () => {
    expect(listedPapersLine({ meets_policy: 0, below_policy: 0, single_copy: 0 })).toBe(
      "No papers are listed yet.",
    );
  });
});

describe("probeSummary", () => {
  it("says 'No probes run yet' when none ran, instead of 0%", () => {
    const summary = probeSummary(DOCUMENT.probes);

    expect(summary.figure).toBe("No probes run yet");
    expect(summary.detail).not.toMatch(/%/);
  });

  it("shows the pass rate and the counts behind it", () => {
    const summary = probeSummary({ window_hours: 24, runs: 8, passed: 6, pass_rate: 0.75 });

    expect(summary.figure).toBe("75%");
    expect(summary.detail).toBe("6 of 8 probes passed in the last 24 hours.");
  });

  it("never rounds a rate with failures up to 100%", () => {
    expect(
      probeSummary({ window_hours: 24, runs: 500, passed: 499, pass_rate: 0.998 }).figure,
    ).toBe("99%");
  });

  it("never rounds a rate with passes down to 0%", () => {
    expect(
      probeSummary({ window_hours: 24, runs: 500, passed: 1, pass_rate: 0.002 }).figure,
    ).toBe("1%");
  });

  it("shows a run of failures as 0%", () => {
    expect(
      probeSummary({ window_hours: 24, runs: 3, passed: 0, pass_rate: 0 }).figure,
    ).toBe("0%");
  });
});

describe("incidentDate", () => {
  it("writes the date the way the site does, in the reader's own time zone", () => {
    // 18:30 UTC is 05:30 the next day in Sydney (GMT+11), and that is the day
    // the reader sees on the paper, the profile and this page.
    expect(incidentDate("2027-05-04T18:30:00Z")).toBe("5 May 2027");
    expect(incidentDate("2027-05-04T09:00:00Z")).toBe("4 May 2027");
  });

  it("keeps an unreadable date as it was sent", () => {
    expect(incidentDate("sometime in May")).toBe("sometime in May");
  });
});

describe("public export", () => {
  it("names the archive route and the two commands that check and rebuild it", () => {
    expect(EXPORT_ARCHIVE_PATH).toBe("/v1/export/archive.car");
    expect(EXPORT_VERIFY_COMMAND).toBe("scholium verify archive.car");
    expect(EXPORT_REBUILD_COMMAND).toBe("scholium rebuild archive.car --db rebuilt.db");
  });

  it("links the API's origin, not the web app's", () => {
    expect(archiveExportHref("https://api.example.org/")).toBe(
      "https://api.example.org/v1/export/archive.car",
    );
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
    expect(spec.meaning).toMatch(/Anchoring is not enabled on this node yet/);
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
