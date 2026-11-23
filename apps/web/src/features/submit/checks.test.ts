import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, tokenStore } from "../../lib/api";
import {
  SIMILARITY_HIGH_PCT,
  SIMILARITY_NOTICE_PCT,
  checkItems,
  checksAreRunning,
  checksBlockers,
  checksErrorMessage,
  checksFinished,
  checksPendingReason,
  checksSummary,
  checksWarnings,
  describeFailedCheck,
  fetchVersionChecks,
  fileProblem,
  formatPercent,
  normalizeVersionChecks,
  referencesResolved,
  type ChecksVersionRef,
  type FileSafety,
  type VersionChecks,
} from "./checks";

const REF: ChecksVersionRef = { paper: "sch:abcd-efgh-ijkl", version: 1 };

const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const ZIP = "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy";

function file(overrides: Partial<FileSafety> = {}): FileSafety {
  return {
    path: "paper.pdf",
    cid: PDF,
    role: "pdf",
    status: "passed",
    failedChecks: [],
    detail: null,
    ...overrides,
  };
}

function checks(overrides: Partial<VersionChecks> = {}): VersionChecks {
  return {
    paper: REF.paper,
    version: REF.version,
    versionCid: "bafyreiexample",
    state: "moderation",
    checksRan: true,
    files: [file()],
    referencesTotal: 10,
    referencesUnresolved: 0,
    similarityPct: 4.2,
    metadataMatch: true,
    signedTitle: "Sparse Probing of Reward Models",
    firstPageTitle: null,
    checkedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeVersionChecks", () => {
  it("reads the nested camelCase response", () => {
    const report = normalizeVersionChecks(
      {
        paper: "sch:abcd-efgh-ijkl",
        version: 2,
        versionCid: "bafyreiversion",
        state: "scanning",
        files: [
          {
            path: "paper.pdf",
            cid: PDF,
            role: "pdf",
            scan: "failed",
            checks: ["javascript", "hidden_text"],
            detail: "JavaScript action at /OpenAction",
          },
          { path: "code.zip", cid: ZIP, scan: { result: "scanning" } },
          { path: "data.csv", cid: "bafkreidata", scan_status: "passed" },
        ],
        references: { total: 42, unresolved: 3 },
        similarity: { pct: 17.25 },
        metadata: { match: false, signedTitle: "A Study of Widgets" },
        checkedAt: "2026-11-15T12:00:00Z",
      },
      REF,
    );

    expect(report).toMatchObject({
      paper: "sch:abcd-efgh-ijkl",
      version: 2,
      versionCid: "bafyreiversion",
      state: "scanning",
      referencesTotal: 42,
      referencesUnresolved: 3,
      similarityPct: 17.25,
      metadataMatch: false,
      signedTitle: "A Study of Widgets",
      checkedAt: "2026-11-15T12:00:00Z",
    });
    expect(report.files.map((entry) => [entry.path, entry.status])).toEqual([
      ["paper.pdf", "failed"],
      ["code.zip", "scanning"],
      ["data.csv", "passed"],
    ]);
    expect(report.files[0].failedChecks).toEqual(["javascript", "hidden_text"]);
    expect(report.files[0].detail).toBe("JavaScript action at /OpenAction");
  });

  it("reads the flat snake_case spelling of the check_results columns", () => {
    const report = normalizeVersionChecks(
      {
        version_cid: "bafyreiversion",
        state: "moderation",
        files: [{ path: "paper.pdf", cid: PDF, scan_status: "passed" }],
        references_total: 4,
        references_unresolved: 0,
        similarity_pct: 3,
        metadata_match: true,
      },
      { paper: REF.paper, version: 7 },
    );

    expect(report).toMatchObject({
      paper: REF.paper,
      version: 7,
      versionCid: "bafyreiversion",
      referencesTotal: 4,
      referencesUnresolved: 0,
      similarityPct: 3,
      metadataMatch: true,
    });
    expect(report.files[0].status).toBe("passed");
  });

  it("leaves a check that has not run as null, never as passing", () => {
    const report = normalizeVersionChecks({ state: "awaiting_consent" }, REF);
    expect(report.referencesTotal).toBeNull();
    expect(report.referencesUnresolved).toBeNull();
    expect(report.similarityPct).toBeNull();
    expect(report.metadataMatch).toBeNull();
    expect(report.files).toEqual([]);
    expect(report.paper).toBe(REF.paper);
    expect(report.version).toBe(REF.version);
  });

  it("clamps similarity to 0-100 and understands string booleans", () => {
    expect(normalizeVersionChecks({ similarity_pct: 130, metadata_match: "false" }, REF)).toMatchObject({
      similarityPct: 100,
      metadataMatch: false,
    });
    expect(normalizeVersionChecks({ similarity_pct: -4, metadata_match: "passed" }, REF)).toMatchObject({
      similarityPct: 0,
      metadataMatch: true,
    });
  });

  it("refuses a response that is not a JSON object", () => {
    expect(() => normalizeVersionChecks("<html>gateway</html>", REF)).toThrow(
      "The node's check report was not an object.",
    );
  });

  it("reads checks that are objects, and ignores the ones that passed", () => {
    const report = normalizeVersionChecks(
      {
        files: [
          {
            path: "paper.pdf",
            cid: PDF,
            scan: "failed",
            checks: [
              { name: "javascript", result: "failed" },
              { name: "hidden_text", result: "passed" },
            ],
          },
        ],
      },
      REF,
    );
    expect(report.files[0].failedChecks).toEqual(["javascript"]);
  });

  it("drops a file entry with no path rather than showing an unnamed row", () => {
    const report = normalizeVersionChecks({ files: [{ cid: PDF }, { path: "paper.pdf" }] }, REF);
    expect(report.files.map((entry) => entry.path)).toEqual(["paper.pdf"]);
  });

  it("reads checksRan, and treats an older report without it as having run", () => {
    expect(normalizeVersionChecks({ state: "moderation" }, REF).checksRan).toBe(true);
    expect(normalizeVersionChecks({ checksRan: true }, REF).checksRan).toBe(true);
    expect(normalizeVersionChecks({ checksRan: false }, REF).checksRan).toBe(false);
    expect(normalizeVersionChecks({ checks_ran: false }, REF).checksRan).toBe(false);
    expect(normalizeVersionChecks({ checks_ran: "false" }, REF).checksRan).toBe(false);
  });
});

describe("fetchVersionChecks", () => {
  afterEach(() => {
    tokenStore.clear();
    vi.unstubAllGlobals();
  });

  /** A `fetch` that answers every request with the given body and records the calls. */
  function stubFetch(body: unknown = { state: "moderation", similarity_pct: 2 }) {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks the version's checks route and normalizes the answer", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ state: "moderation", similarity_pct: 2 });
    const controller = new AbortController();

    const report = await fetchVersionChecks(REF, controller.signal);

    expect(get).toHaveBeenCalledWith("/papers/sch%3Aabcd-efgh-ijkl/v/1/checks", {
      signal: controller.signal,
    });
    expect(report.similarityPct).toBe(2);
  });

  it("sends the signed-in author's bearer token (an unlisted version's checks are 404 without it)", async () => {
    tokenStore.set({ accessToken: "author-access-token" });
    const fetchMock = stubFetch();

    const report = await fetchVersionChecks(REF);

    expect(report.state).toBe("moderation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/papers/sch%3Aabcd-efgh-ijkl/v/1/checks");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer author-access-token");
  });

  it("still reads anonymously when nobody is signed in (a listed paper's checks)", async () => {
    const fetchMock = stubFetch();

    const report = await fetchVersionChecks(REF);

    expect(report.similarityPct).toBe(2);
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });
});

describe("file safety", () => {
  it("names what failed in the author's words", () => {
    const failed = file({ status: "failed", failedChecks: ["javascript", "embedded_files"] });
    expect(fileProblem(failed)).toBe("paper.pdf failed the safety scan: JavaScript and embedded files.");
    expect(describeFailedCheck("path_traversal")).toBe("a path that escapes the archive");
    expect(describeFailedCheck("some_new_check")).toBe("some new check");
  });
});

describe("referencesResolved", () => {
  it("is total minus unresolved, and null until both are known", () => {
    expect(referencesResolved(10, 3)).toBe(7);
    expect(referencesResolved(0, 0)).toBe(0);
    expect(referencesResolved(10, null)).toBeNull();
    expect(referencesResolved(null, 0)).toBeNull();
    expect(referencesResolved(2, 5)).toBe(0);
  });
});

describe("formatPercent", () => {
  it("drops a trailing .0 and keeps one decimal otherwise", () => {
    expect(formatPercent(12)).toBe("12%");
    expect(formatPercent(7.44)).toBe("7.4%");
    expect(formatPercent(7.46)).toBe("7.5%");
  });
});

describe("checkItems", () => {
  it("shows all four checks as not run before a version exists", () => {
    const items = checkItems(null, [{ path: "paper.pdf" }]);
    expect(items.map((item) => [item.id, item.title, item.state, item.label])).toEqual([
      ["files", "File safety", "pending", "Not run yet"],
      ["references", "References", "pending", "Not run yet"],
      ["similarity", "Similarity", "pending", "Not run yet"],
      ["metadata", "Metadata match", "pending", "Not run yet"],
    ]);
    expect(items[0].summary).toBe("1 of 1 file has not been scanned yet");
    expect(items[0].detail).toContain("once the version is signed");
  });

  it("reports an all-clear version with a word for every verdict", () => {
    const items = checkItems(checks());
    expect(items.map((item) => [item.state, item.label])).toEqual([
      ["passed", "Passed"],
      ["passed", "Resolved"],
      ["passed", "Low overlap"],
      ["passed", "Matched"],
    ]);
    expect(items[0].summary).toBe("The file passed the safety scan");
    expect(items[1].summary).toBe("10 of 10 references resolved");
    expect(items[2].summary).toBe("Low overlap: 4.2%");
    expect(items[3].summary).toBe("Title found on page 1");
    expect(checksSummary(items)).toBe("All 4 checks passed.");
  });

  it("offers the place to fix a failed file and a missing title", () => {
    const items = checkItems(
      checks({
        state: "held",
        files: [file({ status: "failed", failedChecks: ["javascript"] })],
        metadataMatch: false,
        signedTitle: "Sparse Probing of Reward Models",
      }),
    );
    expect(items[0]).toMatchObject({ state: "attention", label: "Needs fixing", fix: "files" });
    expect(items[0].summary).toBe("The file failed the safety scan");
    expect(items[0].detail).toContain("Replace it in Files");
    expect(items[3]).toMatchObject({ state: "attention", label: "Needs fixing", fix: "details" });
    expect(items[3].detail).toContain('"Sparse Probing of Reward Models"');
    expect(items[3].detail).toContain("Edit the title or replace the PDF");
  });

  it("shows what page 1 actually begins with when the title is missing", () => {
    const items = checkItems(
      checks({
        metadataMatch: false,
        signedTitle: "A Title",
        firstPageTitle: "  A   Different\nTitle by Someone Else  ",
      }),
    );
    expect(items[3].detail).toContain('Page 1 begins: "A Different Title by Someone Else".');
  });

  it("cuts a long page-one excerpt short", () => {
    const items = checkItems(
      checks({ metadataMatch: false, firstPageTitle: "word ".repeat(100) }),
    );
    const detail = items[3].detail;
    expect(detail).toContain("…");
    expect(detail.length).toBeLessThan(400);
  });

  it("treats unresolved references as a signal, not a failure to fix elsewhere", () => {
    const items = checkItems(checks({ referencesTotal: 10, referencesUnresolved: 4 }));
    expect(items[1]).toMatchObject({ state: "attention", label: "Unresolved", fix: null });
    expect(items[1].summary).toBe("6 of 10 references resolved");
    expect(items[1].detail).toContain("Unresolved references do not stop submission");
  });

  it("says so when the text had no reference list at all", () => {
    const items = checkItems(checks({ referencesTotal: 0, referencesUnresolved: 0 }));
    expect(items[1]).toMatchObject({ state: "passed", label: "Nothing to resolve" });
  });

  it("calls overlap worth a look at the notice threshold", () => {
    const low = checkItems(checks({ similarityPct: SIMILARITY_NOTICE_PCT - 0.1 }))[2];
    const some = checkItems(checks({ similarityPct: SIMILARITY_NOTICE_PCT }))[2];
    const high = checkItems(checks({ similarityPct: SIMILARITY_HIGH_PCT }))[2];
    expect(low).toMatchObject({ state: "passed", label: "Low overlap" });
    expect(some).toMatchObject({ state: "attention", label: "Worth a look" });
    expect(some.summary).toBe("Some overlap: 15%");
    expect(high.summary).toBe("High overlap: 30%");
  });

  it("says the advisory checks did not run when the safety scan held the version", () => {
    const items = checkItems(
      checks({
        state: "held",
        checksRan: false,
        files: [
          file({
            path: "code.zip",
            cid: ZIP,
            role: "code",
            status: "failed",
            failedChecks: ["av_unavailable"],
          }),
        ],
        referencesTotal: null,
        referencesUnresolved: null,
        similarityPct: null,
        metadataMatch: null,
      }),
    );
    // The file verdict is the scan's result and is shown as the failure it is.
    expect(items[0]).toMatchObject({ state: "attention", label: "Needs fixing", fix: "files" });
    // The advisory checks never ran; they are not waiting to run.
    expect(items.slice(1).map((item) => [item.state, item.label, item.summary])).toEqual([
      ["pending", "Not run", "Not run: the version was held at the safety scan"],
      ["pending", "Not run", "Not run: the version was held at the safety scan"],
      ["pending", "Not run", "Not run: the version was held at the safety scan"],
    ]);
  });

  it("shows a scan in progress and every file's own verdict", () => {
    const items = checkItems(
      checks({
        state: "scanning",
        files: [file(), file({ path: "code.zip", cid: ZIP, status: "scanning" })],
      }),
    );
    expect(items[0]).toMatchObject({ state: "running", label: "Scanning" });
    expect(items[0].summary).toBe("Scanning 1 of 2 files…");
    expect(items[0].detail).toBe("Results appear here as each file finishes.");
  });
});

describe("checksFinished and checksAreRunning", () => {
  it("is finished only when every check has a verdict", () => {
    expect(checksFinished(null)).toBe(false);
    expect(checksFinished(checks())).toBe(true);
    expect(checksFinished(checks({ similarityPct: null }))).toBe(false);
    expect(checksFinished(checks({ files: [file({ status: "scanning" })] }))).toBe(false);
  });

  it("treats a version past scanning with no file rows as final on file safety", () => {
    expect(checksFinished(checks({ files: [], state: "moderation" }))).toBe(true);
    expect(checksFinished(checks({ files: [], state: "scanning" }))).toBe(false);
  });

  it("is running while the version is scanning or a file is", () => {
    expect(checksAreRunning(null)).toBe(false);
    expect(checksAreRunning(checks())).toBe(false);
    expect(checksAreRunning(checks({ state: "scanning" }))).toBe(true);
    expect(checksAreRunning(checks({ files: [file({ status: "scanning" })] }))).toBe(true);
  });
});

describe("checksBlockers", () => {
  it("blocks on a failed file, naming it and where to fix it", () => {
    const blockers = checksBlockers(
      checks({ state: "held", files: [file({ status: "failed", failedChecks: ["javascript"] })] }),
    );
    expect(blockers[0]).toBe(
      "paper.pdf failed the safety scan: JavaScript. Replace it in Files, then run the checks again.",
    );
  });

  it("blocks on a title that is not on page 1", () => {
    const blockers = checksBlockers(checks({ metadataMatch: false }));
    expect(blockers).toEqual([
      "Your title does not appear on page 1 of the PDF. Edit the title or replace the PDF.",
    ]);
  });

  it("blocks until every check has run, with the reason in words", () => {
    expect(checksBlockers(checks({ state: "scanning", similarityPct: null }))).toEqual([
      "Checks are still running. This page updates by itself.",
    ]);
    expect(
      checksBlockers(
        checks({
          state: "awaiting_consent",
          files: [file({ status: "pending" })],
          referencesTotal: null,
          referencesUnresolved: null,
          similarityPct: null,
          metadataMatch: null,
        }),
      ),
    ).toEqual(["Checks start once every co-author has consented."]);
    expect(checksBlockers(null)).toEqual(["Checks have not run yet. They start when the version is signed."]);
  });

  it("does not block on unresolved references or high similarity", () => {
    expect(
      checksBlockers(checks({ referencesTotal: 10, referencesUnresolved: 10, similarityPct: 80 })),
    ).toEqual([]);
    expect(checksWarnings(checks({ referencesUnresolved: 2 }))).toHaveLength(1);
    expect(checksWarnings(checks({ similarityPct: 80 }))).toHaveLength(1);
    expect(checksWarnings(checks())).toEqual([]);
  });
});

describe("checksPendingReason", () => {
  it("names what is being waited on", () => {
    expect(checksPendingReason(null)).toBe("Checks have not run yet. They start when the version is signed.");
    expect(checksPendingReason(checks({ state: "awaiting_consent" }))).toBe(
      "Checks start once every co-author has consented.",
    );
    expect(checksPendingReason(checks({ state: "draft" }))).toContain("once the version is signed");
    expect(checksPendingReason(checks({ state: "scanning" }))).toContain("still running");
  });
});

describe("checksSummary", () => {
  it("counts passed and unfinished checks", () => {
    expect(checksSummary(checkItems(null))).toBe("No check results yet.");
    expect(
      checksSummary(checkItems(checks({ state: "scanning", files: [file({ status: "scanning" })] }))),
    ).toBe("3 of 4 checks passed. Still running.");
    expect(checksSummary(checkItems(checks({ similarityPct: null })))).toBe(
      "3 of 4 checks passed, 1 not run yet.",
    );
    expect(checksSummary(checkItems(checks({ metadataMatch: false })))).toBe(
      "3 of 4 checks passed, 1 to fix or look at.",
    );
  });

  it("names the failed file, and not a wait, when the safety scan held the version", () => {
    const held = checks({
      state: "held",
      checksRan: false,
      files: [
        file({
          path: "code.zip",
          cid: ZIP,
          role: "code",
          status: "failed",
          failedChecks: ["av_unavailable"],
        }),
      ],
      referencesTotal: null,
      referencesUnresolved: null,
      similarityPct: null,
      metadataMatch: null,
    });
    // The three advisory checks never ran and never will: no "yet", no count of passes.
    expect(checksSummary(checkItems(held))).toBe(
      "A file failed the safety scan; the other checks did not run.",
    );
  });

  it("gives the same sentence however many files the safety scan failed", () => {
    const held = checks({
      state: "held",
      checksRan: false,
      files: [
        file({ path: "code.zip", cid: ZIP, role: "code", status: "failed", failedChecks: ["av_unavailable"] }),
        file({ path: "paper.pdf", status: "failed", failedChecks: ["javascript"] }),
      ],
      referencesTotal: null,
      referencesUnresolved: null,
      similarityPct: null,
      metadataMatch: null,
    });
    expect(checksSummary(checkItems(held))).toBe(
      "A file failed the safety scan; the other checks did not run.",
    );
  });

  it("still calls an ordinary report that is waiting on its checks pending", () => {
    // checksRan true (or absent) with the advisory results still null is a wait, not a hold.
    const waiting = {
      referencesTotal: null,
      referencesUnresolved: null,
      similarityPct: null,
      metadataMatch: null,
    };
    expect(checksSummary(checkItems(checks({ ...waiting, checksRan: true })))).toBe(
      "1 of 4 checks passed, 3 not run yet.",
    );
    expect(checksSummary(checkItems(checks({ ...waiting, checksRan: undefined })))).toBe(
      "1 of 4 checks passed, 3 not run yet.",
    );
  });
});

describe("checksErrorMessage", () => {
  it("explains a missing version and an ordinary failure differently", () => {
    const notFound = new ApiError(404, { type: "about:blank", title: "Not found", status: 404 });
    const forbidden = new ApiError(403, { type: "about:blank", title: "Forbidden", status: 403 });
    expect(checksErrorMessage(notFound)).toContain("does not have that version");
    expect(checksErrorMessage(forbidden)).toContain("will not show");
    expect(checksErrorMessage(new Error("offline"))).toBe(
      "Could not check this version. Trying again shortly.",
    );
  });
});
