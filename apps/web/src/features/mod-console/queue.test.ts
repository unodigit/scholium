import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  MODERATOR_TIER,
  QUEUE_ENDPOINT,
  QueueListError,
  SIGNIN_HREF,
  accountSignal,
  classifyQueueError,
  formatAge,
  formatCategories,
  formatSimilarity,
  loadQueue,
  parseQueue,
  parseScanResult,
  referencesSignal,
  scanSignal,
  similaritySignal,
} from "./queue";

/** One entry exactly as `GET /v1/moderation/queue` emits it today. */
const WIRE_ENTRY = {
  version_cid: "bafy-version-1",
  cid: "bafy-version-1",
  paper_cid: "bafy-paper-1",
  short_id: "sch:k3f9-q2xz-7mwd",
  title: "Sparse attention without the quadratic cost",
  category: "cs.AI",
  categories: ["cs.AI", "cs.LG"],
  age_hours: 5.4,
  similarity_pct: 42.5,
  references_unresolved: 3,
  scan_result: "passed",
  scan_status: "passed",
  scan: "passed",
  new_account: true,
  is_new_account: true,
};

function wire(overrides: Record<string, unknown> = {}) {
  return { ...WIRE_ENTRY, ...overrides };
}

describe("parseQueue", () => {
  it("maps the wire fields onto a queue entry", () => {
    expect(parseQueue([WIRE_ENTRY])).toEqual([
      {
        versionCid: "bafy-version-1",
        paperCid: "bafy-paper-1",
        shortId: "sch:k3f9-q2xz-7mwd",
        title: "Sparse attention without the quadratic cost",
        categories: ["cs.AI", "cs.LG"],
        ageHours: 5.4,
        similarityPct: 42.5,
        referencesUnresolved: 3,
        scan: "passed",
        newAccount: true,
      },
    ]);
  });

  it("returns an empty list for an empty queue", () => {
    expect(parseQueue([])).toEqual([]);
  });

  it("puts the oldest version first and unknown ages last", () => {
    const entries = parseQueue([
      wire({ version_cid: "young", age_hours: 2 }),
      wire({ version_cid: "unknown", age_hours: null }),
      wire({ version_cid: "old", age_hours: 70 }),
      wire({ version_cid: "middle", age_hours: 30 }),
    ]);
    expect(entries.map((entry) => entry.versionCid)).toEqual([
      "old",
      "middle",
      "young",
      "unknown",
    ]);
  });

  it("keeps the API order between versions of the same age", () => {
    const entries = parseQueue([
      wire({ version_cid: "a", age_hours: 4 }),
      wire({ version_cid: "b", age_hours: 4 }),
      wire({ version_cid: "c", age_hours: 4 }),
    ]);
    expect(entries.map((entry) => entry.versionCid)).toEqual(["a", "b", "c"]);
  });

  it("rejects a payload that is not a list instead of showing an empty queue", () => {
    expect(() => parseQueue({ items: [WIRE_ENTRY] })).toThrow(QueueListError);
    expect(() => parseQueue(null)).toThrow(QueueListError);
    expect(() => parseQueue("queue")).toThrow(/did not return a moderation queue/);
  });

  it("rejects an entry that is not an object or has no version id", () => {
    expect(() => parseQueue(["nope"])).toThrow(/Queue entry 1 is not an object/);
    expect(() => parseQueue([WIRE_ENTRY, wire({ version_cid: " ", cid: undefined })])).toThrow(
      /Queue entry 2 has no version id/,
    );
  });

  it("falls back to `cid` when `version_cid` is absent", () => {
    const [entry] = parseQueue([wire({ version_cid: undefined, cid: "bafy-cid" })]);
    expect(entry.versionCid).toBe("bafy-cid");
  });

  it("shows a version listed twice once", () => {
    expect(parseQueue([WIRE_ENTRY, WIRE_ENTRY])).toHaveLength(1);
  });

  it("keeps a paper in the queue when its details are missing", () => {
    const [entry] = parseQueue([{ version_cid: "bafy-bare" }]);
    expect(entry).toEqual({
      versionCid: "bafy-bare",
      paperCid: null,
      shortId: null,
      title: "Untitled",
      categories: [],
      ageHours: null,
      similarityPct: null,
      referencesUnresolved: null,
      scan: "unknown",
      newAccount: null,
    });
  });

  it("uses the single category when the list is missing or empty", () => {
    expect(parseQueue([wire({ categories: undefined })])[0].categories).toEqual(["cs.AI"]);
    expect(parseQueue([wire({ categories: [] })])[0].categories).toEqual(["cs.AI"]);
    expect(
      parseQueue([wire({ categories: undefined, category: null })])[0].categories,
    ).toEqual([]);
  });

  it("ignores values of the wrong type instead of guessing", () => {
    const [entry] = parseQueue([
      wire({
        similarity_pct: "42",
        references_unresolved: -1,
        age_hours: "5",
        new_account: "yes",
        is_new_account: 1,
      }),
    ]);
    expect(entry.similarityPct).toBeNull();
    expect(entry.referencesUnresolved).toBeNull();
    expect(entry.ageHours).toBeNull();
    expect(entry.newAccount).toBeNull();
    expect(parseQueue([wire({ references_unresolved: 1.5 })])[0].referencesUnresolved).toBeNull();
  });

  it("keeps a similarity of zero and an unresolved count of zero", () => {
    const [entry] = parseQueue([wire({ similarity_pct: 0, references_unresolved: 0 })]);
    expect(entry.similarityPct).toBe(0);
    expect(entry.referencesUnresolved).toBe(0);
  });

  it("clamps a negative age to zero", () => {
    expect(parseQueue([wire({ age_hours: -3 })])[0].ageHours).toBe(0);
  });

  it("reads the flag and scan from their alternative names", () => {
    const [entry] = parseQueue([
      wire({
        scan_result: undefined,
        scan_status: "failed",
        new_account: undefined,
        is_new_account: false,
      }),
    ]);
    expect(entry.scan).toBe("failed");
    expect(entry.newAccount).toBe(false);
  });
});

describe("parseScanResult", () => {
  it.each([
    ["passed", "passed"],
    ["PASS", "passed"],
    ["clean", "passed"],
    ["failed", "failed"],
    ["blocked", "failed"],
    ["infected", "failed"],
    ["pending", "pending"],
    ["scanning", "pending"],
    ["unscanned", "pending"],
    ["strange", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
    [42, "unknown"],
  ])("reads %j as %s", (value, expected) => {
    expect(parseScanResult(value)).toBe(expected);
  });

  it("reads an object that carries the verdict", () => {
    expect(parseScanResult({ result: "failed" })).toBe("failed");
    expect(parseScanResult({ status: "passed", scanned_at: "2026-01-01" })).toBe("passed");
    expect(parseScanResult({ scanned_at: "2026-01-01" })).toBe("unknown");
  });
});

describe("formatAge", () => {
  it.each([
    [0, "<1 h"],
    [0.4, "<1 h"],
    [1, "1 h"],
    [5.9, "5 h"],
    [47.9, "47 h"],
    [48, "2 d"],
    [52.5, "2 d 4 h"],
    [100, "4 d 4 h"],
    [null, "—"],
    [Number.NaN, "—"],
  ])("formats %j as %s", (hours, expected) => {
    expect(formatAge(hours)).toBe(expected);
  });
});

describe("formatSimilarity", () => {
  it.each([
    [0, "0%"],
    [12, "12%"],
    [42.5, "42.5%"],
    [42.449, "42.4%"],
    [99.96, "100%"],
  ])("formats %j as %s", (pct, expected) => {
    expect(formatSimilarity(pct)).toBe(expected);
  });
});

describe("formatCategories", () => {
  it("lists every category, or an em dash when there is none", () => {
    expect(formatCategories(["cs.AI", "cs.LG"])).toBe("cs.AI, cs.LG");
    expect(formatCategories([])).toBe("—");
  });
});

describe("signals", () => {
  it("shows a similarity as a plain number and an unrun check as not checked", () => {
    expect(similaritySignal(42.5)).toEqual({ tone: "none", icon: null, text: "42.5%" });
    expect(similaritySignal(0)).toEqual({ tone: "none", icon: null, text: "0%" });
    expect(similaritySignal(null)).toEqual({
      tone: "unknown",
      icon: "question",
      text: "Not checked",
    });
  });

  it("marks any unresolved reference and passes a clean count", () => {
    expect(referencesSignal(0)).toEqual({ tone: "ok", icon: "check", text: "None unresolved" });
    expect(referencesSignal(3)).toEqual({ tone: "warn", icon: "alert", text: "3 unresolved" });
    expect(referencesSignal(null).text).toBe("Not checked");
  });

  it("draws only a clear pass as a pass", () => {
    expect(scanSignal("passed")).toEqual({ tone: "ok", icon: "check", text: "Passed" });
    expect(scanSignal("failed")).toEqual({ tone: "bad", icon: "cross", text: "Failed" });
    expect(scanSignal("pending")).toEqual({ tone: "unknown", icon: "pending", text: "Pending" });
    expect(scanSignal("unknown")).toEqual({ tone: "unknown", icon: "question", text: "Unknown" });
  });

  it("flags a new account and leaves an established one plain", () => {
    expect(accountSignal(true)).toEqual({ tone: "warn", icon: "alert", text: "New account" });
    expect(accountSignal(false)).toEqual({ tone: "none", icon: null, text: "Established" });
    expect(accountSignal(null)).toEqual({ tone: "unknown", icon: "question", text: "Unknown" });
  });

  it("never leaves a coloured signal without an icon (status is not colour alone)", () => {
    const signals = [
      similaritySignal(null),
      similaritySignal(10),
      referencesSignal(0),
      referencesSignal(2),
      referencesSignal(null),
      scanSignal("passed"),
      scanSignal("failed"),
      scanSignal("pending"),
      scanSignal("unknown"),
      accountSignal(true),
      accountSignal(false),
      accountSignal(null),
    ];
    for (const signal of signals) {
      expect(signal.text).not.toBe("");
      if (signal.tone !== "none") {
        expect(signal.icon).not.toBeNull();
      }
    }
  });
});

describe("classifyQueueError", () => {
  it("reads a 401 as a lost session", () => {
    const failure = classifyQueueError(
      new ApiError(401, { status: 401, detail: "Authentication required." }),
    );
    expect(failure.kind).toBe("signed-out");
    expect(failure.message).toMatch(/session has ended/i);
  });

  it("reads a 403 as not a moderator and repeats the caller's tier", () => {
    const failure = classifyQueueError(
      new ApiError(403, {
        status: 403,
        detail: "Requires trust tier 4 (Moderator); caller is tier 1 (Member).",
        required_tier: 4,
        caller_tier: 1,
      }),
    );
    expect(failure).toEqual({
      kind: "forbidden",
      message: `The moderation console is for moderators (trust tier ${MODERATOR_TIER}).`,
      callerTier: 1,
    });
  });

  it("does not guess a tier the API did not give", () => {
    const failure = classifyQueueError(new ApiError(403, { status: 403 }));
    expect(failure).toMatchObject({ kind: "forbidden", callerTier: null });

    const odd = classifyQueueError(
      new ApiError(403, { status: 403, caller_tier: "one" }),
    );
    expect(odd).toMatchObject({ kind: "forbidden", callerTier: null });
  });

  it("reports other API failures with the API's own words", () => {
    const failure = classifyQueueError(
      new ApiError(500, { status: 500, detail: "The queue index is rebuilding." }),
    );
    expect(failure).toEqual({ kind: "error", message: "The queue index is rebuilding." });
  });

  it("explains a network failure in one plain sentence", () => {
    const failure = classifyQueueError(new NetworkError("http://api.invalid/v1/x"));
    expect(failure.kind).toBe("error");
    expect(failure.message).toMatch(/could not reach the API/);
  });

  it("passes a malformed payload's message through", () => {
    const failure = classifyQueueError(new QueueListError("Queue entry 2 has no version id."));
    expect(failure).toEqual({ kind: "error", message: "Queue entry 2 has no version id." });
  });

  it("falls back to a generic sentence for anything else", () => {
    expect(classifyQueueError(new Error("boom"))).toEqual({ kind: "error", message: "boom" });
    expect(classifyQueueError("???")).toEqual({
      kind: "error",
      message: "The moderation queue could not be loaded.",
    });
  });
});

describe("loadQueue", () => {
  it("requests the queue with the account's token and never from the cache", async () => {
    const get = vi.fn(async () => [WIRE_ENTRY]);

    const entries = await loadQueue({ get } as never);

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = get.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe(QUEUE_ENDPOINT);
    expect(path).toBe("/moderation/queue");
    expect(options.cache).toBe("no-store");
    // Authentication stays on (the client's default): the queue is tier 4 only.
    expect(options.auth).not.toBe(false);
    expect(entries.map((entry) => entry.versionCid)).toEqual(["bafy-version-1"]);
  });

  it("rejects a response that is not a queue", async () => {
    const get = vi.fn(async () => ({ detail: "nope" }));
    await expect(loadQueue({ get } as never)).rejects.toThrow(QueueListError);
  });

  it("lets an API failure through for the page to classify", async () => {
    const forbidden = new ApiError(403, { status: 403, caller_tier: 2 });
    const get = vi.fn(async () => {
      throw forbidden;
    });
    await expect(loadQueue({ get } as never)).rejects.toBe(forbidden);
  });
});

describe("SIGNIN_HREF", () => {
  it("sends a visitor to sign in and back to the console", () => {
    expect(SIGNIN_HREF).toBe("/signin?next=%2Fmod");
  });
});
