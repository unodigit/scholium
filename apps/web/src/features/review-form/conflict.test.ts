import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  CONFLICT_STATUS_SPECS,
  ConflictReportError,
  conflictEndpoint,
  describeConflictError,
  describeConflictSummary,
  loadConflictCheck,
  parseConflictReport,
  type ConflictReport,
} from "./conflict";

const REPORT = {
  paper: "sch:6sel-2dio-orm6",
  clear: true,
  checked_at: "2026-11-16T09:00:00Z",
  checks: [
    {
      id: "not_author",
      label: "Not an author of this paper",
      status: "pass",
      passed: true,
      detail: "You are not an author of this paper.",
    },
    {
      id: "no_recent_coauthorship",
      label: "No co-authorship with any author in the last 3 years",
      status: "pass",
      passed: true,
      detail: "You share no byline with any author in the last 3 years.",
    },
    {
      id: "different_institution",
      label: "Different institution from all authors",
      status: "pass",
      passed: true,
      detail: "Your affiliation differs from every author's on file.",
    },
  ],
};

describe("parseConflictReport", () => {
  it("reads the three checks and when they were made", () => {
    const report = parseConflictReport(REPORT);

    expect(report.paper).toBe("sch:6sel-2dio-orm6");
    expect(report.clear).toBe(true);
    expect(report.checkedAt).toBe("2026-11-16T09:00:00Z");
    expect(report.checks.map((check) => check.id)).toEqual([
      "not_author",
      "no_recent_coauthorship",
      "different_institution",
    ]);
  });

  it("keeps a conflict as a status, not as a refusal", () => {
    const report = parseConflictReport({
      ...REPORT,
      clear: false,
      checks: [
        {
          id: "not_author",
          label: "Not an author of this paper",
          status: "fail",
          passed: false,
          detail: "You are an author of this paper.",
        },
      ],
    });

    expect(report.clear).toBe(false);
    expect(report.checks[0].status).toBe("fail");
    expect(report.checks[0].passed).toBe(false);
  });

  it("derives a status from passed when the status field is missing", () => {
    const report = parseConflictReport({
      ...REPORT,
      checks: [
        { id: "a", label: "A", passed: true, detail: "" },
        { id: "b", label: "B", passed: false, detail: "" },
      ],
    });

    expect(report.checks.map((check) => check.status)).toEqual(["pass", "fail"]);
  });

  it("treats an unrecognised status as could-not-check, not as a pass", () => {
    const report = parseConflictReport({
      ...REPORT,
      checks: [{ id: "a", label: "A", status: "maybe", passed: true, detail: "" }],
    });

    // `passed: true` still wins when it is all the body carries.
    expect(report.checks[0].status).toBe("pass");

    const unknown = parseConflictReport({
      ...REPORT,
      checks: [{ id: "a", label: "A", status: "maybe", detail: "" }],
    });
    expect(unknown.checks[0].status).toBe("unknown");
  });

  it("refuses an empty report rather than reading it as no conflicts", () => {
    expect(() => parseConflictReport({ ...REPORT, checks: [] })).toThrow(
      ConflictReportError,
    );
    expect(() => parseConflictReport({})).toThrow(ConflictReportError);
  });

  it("drops entries that do not name a check", () => {
    const report = parseConflictReport({
      ...REPORT,
      checks: [
        ...REPORT.checks,
        { status: "pass", passed: true },
        "not a check",
      ],
    });

    expect(report.checks).toHaveLength(3);
  });
});

describe("describeConflictSummary", () => {
  const base = parseConflictReport(REPORT);

  it("says the paper is clear when every check passed", () => {
    expect(describeConflictSummary(base)).toBe(
      "No conflicts found. You can review this paper.",
    );
  });

  it("names a conflict without claiming the commit is refused", () => {
    const report: ConflictReport = {
      ...base,
      clear: false,
      checks: base.checks.map((check, index) =>
        index === 0 ? { ...check, status: "fail", passed: false } : check,
      ),
    };

    const summary = describeConflictSummary(report);
    expect(summary).toContain("One check found a conflict");
    expect(summary).toContain("declared with the review");
  });

  it("says when a check could not be completed", () => {
    const report: ConflictReport = {
      ...base,
      clear: false,
      checks: base.checks.map((check, index) =>
        index === 2 ? { ...check, status: "unknown", passed: false } : check,
      ),
    };

    expect(describeConflictSummary(report)).toContain(
      "One check could not be completed",
    );
  });
});

describe("status words", () => {
  it("gives every status a distinct icon and a word", () => {
    expect(CONFLICT_STATUS_SPECS.pass.icon).toBe("check");
    expect(CONFLICT_STATUS_SPECS.fail.icon).toBe("cross");
    expect(CONFLICT_STATUS_SPECS.unknown.icon).toBe("question");
    expect(CONFLICT_STATUS_SPECS.pass.label).not.toBe(
      CONFLICT_STATUS_SPECS.fail.label,
    );
  });
});

describe("loadConflictCheck", () => {
  it("asks the caller-specific endpoint and parses it", async () => {
    const asked: string[] = [];
    const client = {
      get: async (path: string) => {
        asked.push(path);
        return REPORT;
      },
    };

    const report = await loadConflictCheck("sch:6sel-2dio-orm6", client as never);

    expect(asked).toEqual([
      "/papers/sch%3A6sel-2dio-orm6/coi-check",
    ]);
    expect(conflictEndpoint("sch:6sel-2dio-orm6")).toBe(asked[0]);
    expect(report.clear).toBe(true);
  });
});

describe("describeConflictError", () => {
  it("asks a signed-out caller to sign in", () => {
    const error = new ApiError(401, { detail: "Not authenticated" });
    expect(describeConflictError(error)).toMatch(/session has ended/i);
  });

  it("explains a paper this node does not list", () => {
    const error = new ApiError(404, { detail: "No paper" });
    expect(describeConflictError(error)).toMatch(/cannot be checked/i);
  });

  it("prefers the API's own explanation", () => {
    const error = new ApiError(500, { detail: "The database is offline." });
    expect(describeConflictError(error)).toBe("The database is offline.");
  });

  it("explains an unreachable API", () => {
    expect(describeConflictError(new NetworkError("http://api"))).toMatch(
      /could not reach the API/i,
    );
  });
});
