import { describe, expect, it } from "vitest";

import { ICON_SHAPES } from "./icons";
import {
  PAPER_STATUSES,
  STATUS_CHIP_SPECS,
  isPaperStatus,
  normalizeReviewerCount,
  statusChipLabel,
} from "./status";

describe("paper statuses", () => {
  it("are the six the API's compute_status returns, by wire value", () => {
    expect([...PAPER_STATUSES]).toEqual([
      "preprint",
      "under_review",
      "reviewed",
      "contested",
      "corrected",
      "retracted",
    ]);
  });

  it("have a spec each, keyed by its own status", () => {
    for (const status of PAPER_STATUSES) {
      expect(STATUS_CHIP_SPECS[status].status).toBe(status);
    }
    expect(Object.keys(STATUS_CHIP_SPECS).sort()).toEqual([...PAPER_STATUSES].sort());
  });

  it("use the words from docs/design.md §7", () => {
    expect(PAPER_STATUSES.map((status) => STATUS_CHIP_SPECS[status].label)).toEqual([
      "Preprint",
      "Under review",
      "Reviewed",
      "Contested",
      "Corrected",
      "Retracted",
    ]);
  });

  it("follow the colour roles in docs/design.md §3", () => {
    const tone = (status: (typeof PAPER_STATUSES)[number]) =>
      STATUS_CHIP_SPECS[status].tone;
    expect(tone("reviewed")).toBe("verified");
    expect(tone("under_review")).toBe("pending");
    expect(tone("contested")).toBe("pending");
    expect(tone("retracted")).toBe("critical");
    // Corrected shares the pending colour with the "Corrected" banner (§5.2).
    expect(tone("corrected")).toBe("pending");
    expect(tone("preprint")).toBe("neutral");
  });

  it("never rely on colour alone: each has its own word AND its own icon shape", () => {
    const specs = PAPER_STATUSES.map((status) => STATUS_CHIP_SPECS[status]);

    for (const spec of specs) {
      expect(spec.label.trim()).not.toBe("");
      expect(ICON_SHAPES[spec.icon].length).toBeGreaterThan(0);
    }

    expect(new Set(specs.map((spec) => spec.label)).size).toBe(specs.length);
    expect(new Set(specs.map((spec) => spec.icon)).size).toBe(specs.length);
    expect(
      new Set(specs.map((spec) => JSON.stringify(ICON_SHAPES[spec.icon]))).size,
    ).toBe(specs.length);
  });

  it("tell the three amber statuses apart without colour", () => {
    const amber = PAPER_STATUSES.map((status) => STATUS_CHIP_SPECS[status]).filter(
      (spec) => spec.tone === "pending",
    );
    expect(amber.map((spec) => spec.status)).toEqual([
      "under_review",
      "contested",
      "corrected",
    ]);
    expect(new Set(amber.map((spec) => spec.icon)).size).toBe(3);
    expect(new Set(amber.map((spec) => spec.label)).size).toBe(3);
  });
});

describe("isPaperStatus", () => {
  it.each(PAPER_STATUSES)("accepts %s", (status) => {
    expect(isPaperStatus(status)).toBe(true);
  });

  it.each([
    "withdrawn",
    "under-review",
    "Reviewed",
    "",
    "toString",
    "__proto__",
    undefined,
    null,
    7,
    {},
  ])("rejects %j", (value) => {
    expect(isPaperStatus(value)).toBe(false);
  });
});

describe("normalizeReviewerCount", () => {
  it("keeps whole numbers from zero up", () => {
    expect(normalizeReviewerCount(0)).toBe(0);
    expect(normalizeReviewerCount(3)).toBe(3);
    expect(normalizeReviewerCount(120)).toBe(120);
  });

  it.each([-1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 53, "3", null, undefined, {}])(
    "drops %j instead of printing it",
    (value) => {
      expect(normalizeReviewerCount(value)).toBeUndefined();
    },
  );
});

describe("statusChipLabel", () => {
  it("is the bare word for every status without a count", () => {
    expect(statusChipLabel("preprint")).toBe("Preprint");
    expect(statusChipLabel("under_review")).toBe("Under review");
    expect(statusChipLabel("reviewed")).toBe("Reviewed");
    expect(statusChipLabel("contested")).toBe("Contested");
    expect(statusChipLabel("corrected")).toBe("Corrected");
    expect(statusChipLabel("retracted")).toBe("Retracted");
  });

  it("appends the reviewer count to Under review: Under review (n)", () => {
    expect(statusChipLabel("under_review", 1)).toBe("Under review (1)");
    expect(statusChipLabel("under_review", 3)).toBe("Under review (3)");
    expect(statusChipLabel("under_review", 0)).toBe("Under review (0)");
  });

  it("falls back to the bare word for a count it cannot print", () => {
    expect(statusChipLabel("under_review", Number.NaN)).toBe("Under review");
    expect(statusChipLabel("under_review", -2)).toBe("Under review");
    expect(statusChipLabel("under_review", 2.5)).toBe("Under review");
  });

  it("ignores the count for every other status", () => {
    for (const status of PAPER_STATUSES) {
      if (status === "under_review") continue;
      expect(statusChipLabel(status, 4)).toBe(STATUS_CHIP_SPECS[status].label);
    }
  });
});
