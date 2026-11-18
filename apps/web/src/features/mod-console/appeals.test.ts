import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  AppealsLoadError,
  LOG_PAGE_SIZE,
  MAX_LOG_PAGES,
  actionLabel,
  buildAppealCases,
  describeAppealsError,
  enrichAppealCases,
  isAppealOpen,
  loadAppealCases,
  outcomeLabel,
  readLogEntry,
  type LogEntry,
} from "./appeals";

// A real-looking genesis id: the paper's short id is derived from it.
const PAPER = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soitae";
const VERSION = "bafy-version-1";
const DECISION = "bafy-decision-1";
const APPEAL = "bafy-appeal-1";
const VERDICT = "bafy-verdict-1";

let seq = 0;
function entry(type: string, cid: string, body: Record<string, unknown>, extra: Partial<LogEntry> = {}): LogEntry {
  seq += 1;
  return {
    seq,
    cid,
    type,
    authorDid: "did:key:z6MkAuthor",
    body,
    receivedAt: "2027-05-04T09:30:00Z",
    ...extra,
  };
}

function versionEntry(): LogEntry {
  return entry("paper.version", VERSION, {
    paper: PAPER,
    n: 1,
    title: "Sparse attention without the quadratic cost",
    abstract: "We show it.",
    authors: ["did:key:z6MkAuthor"],
  });
}

function decisionEntry(overrides: Record<string, unknown> = {}): LogEntry {
  return entry(
    "moderation.decision",
    DECISION,
    { target: VERSION, action: "reject", clause: "MOD-01", reason: "Out of scope.", ...overrides },
    { authorDid: "did:key:z6MkModerator" },
  );
}

function appealEntry(cid = APPEAL, target = DECISION, grounds = "It is in scope."): LogEntry {
  return entry("appeal", cid, { target, grounds });
}

function verdictEntry(appealCid = APPEAL, cid = VERDICT, body: Record<string, unknown> = {}): LogEntry {
  return entry(
    "appeal.decision",
    cid,
    {
      target: appealCid,
      appeal: appealCid,
      outcome: "overturned",
      reasons: ["It is in scope of MOD-01."],
      votes: [
        { did: "did:key:z6MkA", outcome: "overturned", reasons: ["It is in scope of MOD-01."] },
        { did: "did:key:z6MkB", outcome: "overturned", reasons: [] },
        { did: "did:key:z6MkC", outcome: "upheld", reasons: ["Not convinced."] },
      ],
      ...body,
    },
    { authorDid: "did:key:z6MkNode", receivedAt: "2027-05-09T10:00:00Z" },
  );
}

describe("readLogEntry", () => {
  const wire = {
    seq: 7,
    record_cid: "bafy-1",
    record_type: "appeal",
    author_did: "did:key:z6MkA",
    body: { target: "x", grounds: "y" },
    raw: "AAAA",
    received_at: "2027-05-04T09:30:12Z",
  };

  it("reads the columns GET /v1/sync/range serves", () => {
    expect(readLogEntry(wire)).toEqual({
      seq: 7,
      cid: "bafy-1",
      type: "appeal",
      authorDid: "did:key:z6MkA",
      body: { target: "x", grounds: "y" },
      receivedAt: "2027-05-04T09:30:12Z",
    });
  });

  it.each([
    ["a missing seq", { ...wire, seq: undefined }],
    ["a fractional seq", { ...wire, seq: 1.5 }],
    ["a missing cid", { ...wire, record_cid: "" }],
    ["a missing type", { ...wire, record_type: undefined }],
    ["a body that is not an object", { ...wire, body: "x" }],
    ["not an object", "entry"],
  ])("skips an entry with %s so it cannot hide its neighbours", (_name, item) => {
    expect(readLogEntry(item)).toBeNull();
  });
});

describe("buildAppealCases", () => {
  it("joins an appeal with its decision, its paper and, once decided, the panel's verdict", () => {
    const cases = buildAppealCases([
      versionEntry(),
      decisionEntry(),
      appealEntry(),
      verdictEntry(),
    ]);

    expect(cases).toHaveLength(1);
    const [appeal] = cases;
    expect(appeal).toMatchObject({
      appealCid: APPEAL,
      decisionCid: DECISION,
      grounds: "It is in scope.",
      appellantDid: "did:key:z6MkAuthor",
      filedAt: "2027-05-04T09:30:00Z",
      original: {
        action: "reject",
        clause: "MOD-01",
        reason: "Out of scope.",
        moderatorDid: "did:key:z6MkModerator",
        versionCid: VERSION,
      },
      paper: { title: "Sparse attention without the quadratic cost", versionCid: VERSION },
      verdict: {
        cid: VERDICT,
        outcome: "overturned",
        reasons: ["It is in scope of MOD-01."],
        decidedAt: "2027-05-09T10:00:00Z",
      },
    });
    expect(appeal?.paper?.versionId).toMatch(/^sch:[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\/v1$/);
    expect(appeal?.verdict?.votes).toEqual([
      { did: "did:key:z6MkA", outcome: "overturned", reasons: ["It is in scope of MOD-01."] },
      { did: "did:key:z6MkB", outcome: "overturned", reasons: [] },
      { did: "did:key:z6MkC", outcome: "upheld", reasons: ["Not convinced."] },
    ]);
  });

  it("calls an appeal with no appeal.decision open", () => {
    const [appeal] = buildAppealCases([versionEntry(), decisionEntry(), appealEntry()]);
    expect(appeal?.verdict).toBeNull();
    expect(isAppealOpen(appeal!)).toBe(true);
  });

  it("does not depend on the order entries arrive in", () => {
    const entries = [verdictEntry(), appealEntry(), decisionEntry(), versionEntry()];
    const [appeal] = buildAppealCases(entries);
    expect(appeal?.verdict?.outcome).toBe("overturned");
    expect(appeal?.paper?.title).toBe("Sparse attention without the quadratic cost");
  });

  it("keeps an appeal whose decision or paper this log lacks, with those parts null", () => {
    const [noDecision] = buildAppealCases([appealEntry()]);
    expect(noDecision).toMatchObject({ original: null, paper: null });

    const [noPaper] = buildAppealCases([decisionEntry(), appealEntry()]);
    expect(noPaper?.original?.action).toBe("reject");
    expect(noPaper?.paper).toBeNull();
  });

  it("keeps an appeal whose version record cannot be read, instead of hiding it", () => {
    const broken = entry("paper.version", VERSION, { title: "x" }, { type: "endorsement" });
    const [appeal] = buildAppealCases([broken, decisionEntry(), appealEntry()]);
    expect(appeal?.paper).toBeNull();
  });

  it("drops an appeal that names no decision: nothing can be done with it", () => {
    const orphan = entry("appeal", "bafy-orphan", { grounds: "why" });
    expect(buildAppealCases([orphan])).toEqual([]);
  });

  it("falls back to the decision field when the appeal has no target", () => {
    const viaDecision = entry("appeal", APPEAL, { decision: DECISION, grounds: "g" });
    expect(buildAppealCases([viaDecision])[0]?.decisionCid).toBe(DECISION);
  });

  it("uses the first appeal.decision that targets an appeal: a panel decides once", () => {
    const first = verdictEntry(APPEAL, "bafy-verdict-a", { outcome: "upheld" });
    const second = verdictEntry(APPEAL, "bafy-verdict-b", { outcome: "overturned" });
    const [appeal] = buildAppealCases([appealEntry(), first, second]);
    expect(appeal?.verdict).toMatchObject({ cid: "bafy-verdict-a", outcome: "upheld" });
  });

  it("reads reasons given as one string, or under the singular field", () => {
    const [one] = buildAppealCases([
      appealEntry(),
      verdictEntry(APPEAL, VERDICT, { reasons: undefined, reason: "Because." }),
    ]);
    expect(one?.verdict?.reasons).toEqual(["Because."]);
  });

  it("lists open appeals oldest first, then decided ones, latest decision first", () => {
    const decided1 = appealEntry("a-decided-1");
    const decided2 = appealEntry("a-decided-2");
    const open1 = appealEntry("a-open-1");
    const open2 = appealEntry("a-open-2");
    const cases = buildAppealCases([
      decided1,
      open1,
      decided2,
      open2,
      verdictEntry("a-decided-1", "v1"),
      verdictEntry("a-decided-2", "v2"),
    ]);
    expect(cases.map((appeal) => appeal.appealCid)).toEqual([
      "a-open-1",
      "a-open-2",
      "a-decided-2",
      "a-decided-1",
    ]);
  });

  it("shows an appeal repeated in the log once", () => {
    const one = appealEntry();
    expect(buildAppealCases([one, { ...one, seq: one.seq + 100 }])).toHaveLength(1);
  });

  it("returns nothing for a log with no appeals", () => {
    expect(buildAppealCases([versionEntry(), decisionEntry()])).toEqual([]);
  });
});

/** A page of the log as the API serves it. */
function wire(entries: LogEntry[]) {
  return entries.map((item) => ({
    seq: item.seq,
    record_cid: item.cid,
    record_type: item.type,
    author_did: item.authorDid,
    body: item.body,
    raw: "AAAA",
    received_at: item.receivedAt,
  }));
}

function filler(from: number, count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    seq: from + index + 1,
    record_cid: `bafy-filler-${from + index + 1}`,
    record_type: "discussion.post",
    author_did: "did:key:z6MkX",
    body: {},
    raw: "AAAA",
    received_at: "2027-05-04T09:30:00Z",
  }));
}

describe("loadAppealCases", () => {
  it("replays the public log from the start, uncached and without a token", async () => {
    const get = vi.fn(async () => wire([versionEntry(), decisionEntry(), appealEntry()]));
    const load = await loadAppealCases({ get } as never);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/sync/range", {
      auth: false,
      cache: "no-store",
      query: { from: 0, limit: LOG_PAGE_SIZE },
    });
    expect(load.truncated).toBe(false);
    expect(load.cases).toHaveLength(1);
  });

  it("reads page after page until a short page, resuming after the last seq", async () => {
    const first = [...filler(0, LOG_PAGE_SIZE - 1), ...wire([appealEntry("late", DECISION)])].map(
      (item, index) => ({ ...item, seq: index + 1 }),
    );
    const second = wire([verdictEntry("late", "v-late")]).map((item) => ({
      ...item,
      seq: LOG_PAGE_SIZE + 1,
    }));
    const get = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const load = await loadAppealCases({ get } as never);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[1]).toMatchObject({ query: { from: LOG_PAGE_SIZE, limit: LOG_PAGE_SIZE } });
    expect(load.cases[0]).toMatchObject({ appealCid: "late" });
    expect(load.cases[0]?.verdict?.outcome).toBe("overturned");
  });

  it("keeps only the record types it joins, so a long log does not pile up in memory", async () => {
    const get = vi.fn(async () => [
      ...filler(0, 50),
      ...wire([appealEntry()]),
    ]);
    const load = await loadAppealCases({ get } as never);
    expect(load.cases).toHaveLength(1);
  });

  it("reports a log longer than it will read rather than silently dropping appeals", async () => {
    let from = 0;
    const get = vi.fn(async () => {
      const page = filler(from, LOG_PAGE_SIZE);
      from += LOG_PAGE_SIZE;
      return page;
    });

    const load = await loadAppealCases({ get } as never);

    expect(get).toHaveBeenCalledTimes(MAX_LOG_PAGES);
    expect(load.truncated).toBe(true);
  });

  it("refuses a full page that does not advance, instead of looping for ever", async () => {
    const stuck = filler(0, LOG_PAGE_SIZE).map((item) => ({ ...item, seq: 0 }));
    const get = vi.fn(async () => stuck);
    await expect(loadAppealCases({ get } as never)).rejects.toThrow(/did not advance/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that is not a page of the log", async () => {
    const get = vi.fn(async () => ({ entries: [] }));
    await expect(loadAppealCases({ get } as never)).rejects.toBeInstanceOf(AppealsLoadError);
  });

  it("passes a transport failure through for the section to word", async () => {
    const get = vi.fn(async () => {
      throw new NetworkError("offline");
    });
    await expect(loadAppealCases({ get } as never)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("the viewer's own recorded vote", () => {
  function oneAppeal() {
    const [appeal] = buildAppealCases([
      versionEntry(),
      decisionEntry(),
      appealEntry(),
    ]);
    return appeal!;
  }

  it("reads the reasons the detail returns to this seated member", async () => {
    const get = vi.fn(async () => ({
      viewer_on_panel: true,
      viewer_vote: "upheld",
      viewer_voted_at: "2026-11-18T09:30:00Z",
      viewer_reasons: ["The ruling matches MOD-01.", "The clause is clear."],
      votes_cast: 1,
    }));

    const [enriched] = await enrichAppealCases([oneAppeal()], { get } as never);

    // One string for the textarea: the reasons the member gave, in order.
    expect(enriched?.viewerReasons).toBe(
      "The ruling matches MOD-01.\n\nThe clause is clear.",
    );
  });

  it("has no reasons when the API returns none", async () => {
    const get = vi.fn(async () => ({
      viewer_on_panel: true,
      viewer_vote: "upheld",
      viewer_voted_at: "2026-11-18T09:30:00Z",
      viewer_reasons: null,
      votes_cast: 1,
    }));

    const [enriched] = await enrichAppealCases([oneAppeal()], { get } as never);

    expect(enriched?.viewerReasons).toBeNull();
  });
});

describe("appeal wording", () => {
  it("words every outcome the panel can reach, and shows an unknown one as sent", () => {
    expect(outcomeLabel("overturned")).toBe("Decision overturned");
    expect(outcomeLabel("upheld")).toBe("Decision upheld");
    expect(outcomeLabel("remanded")).toBe("Sent back to the moderators");
    expect(outcomeLabel("grant")).toBe("Appeal granted");
    expect(outcomeLabel("mystery")).toBe("mystery");
  });

  it("words a moderation action, and shows an unknown one as sent", () => {
    expect(actionLabel("reject")).toBe("Reject the paper");
    expect(actionLabel("tombstone")).toBe("tombstone");
  });

  it("says one plain sentence for each way the log can fail to load", () => {
    expect(
      describeAppealsError(new ApiError(500, { status: 500, detail: "The log is locked." })),
    ).toBe("The log is locked.");
    expect(describeAppealsError(new NetworkError("offline"))).toContain("could not reach");
    expect(describeAppealsError(new AppealsLoadError("Not a page."))).toBe("Not a page.");
    expect(describeAppealsError(undefined)).toBe("The appeals could not be loaded.");
  });
});
