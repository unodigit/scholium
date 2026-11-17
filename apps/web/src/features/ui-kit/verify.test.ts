import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ICON_SHAPES, type IconShape } from "./icons";
import {
  PROOF_TAB_HREF,
  VERIFY_BADGE_SPECS,
  VERIFY_STATES,
  countedLabel,
  isVerifyState,
  proofTabHref,
  verifyBadgeTitle,
  type VerifyCounts,
} from "./verify";

describe("verify states", () => {
  it("are the five rows of docs/design.md §5.3, in order", () => {
    expect([...VERIFY_STATES]).toEqual([
      "verified",
      "anchor_pending",
      "checking",
      "cannot_verify",
      "failed",
    ]);
  });

  it("have a spec each, keyed by its own state", () => {
    for (const state of VERIFY_STATES) {
      expect(VERIFY_BADGE_SPECS[state].state).toBe(state);
    }
    expect(Object.keys(VERIFY_BADGE_SPECS).sort()).toEqual([...VERIFY_STATES].sort());
  });

  it("use the labels of docs/design.md §5.3, character for character", () => {
    expect(VERIFY_STATES.map((state) => VERIFY_BADGE_SPECS[state].label)).toEqual([
      "Verified",
      // U+00B7 MIDDLE DOT, with a space each side.
      "Signed · anchor pending",
      // One U+2026 HORIZONTAL ELLIPSIS, not three full stops.
      "Checking…",
      "Could not check",
      "Verification failed",
    ]);
  });

  it("use the icon and colour of each row of the table", () => {
    const pick = (state: (typeof VERIFY_STATES)[number]) => {
      const { icon, tone } = VERIFY_BADGE_SPECS[state];
      return [icon, tone];
    };
    expect(pick("verified")).toEqual(["check", "verified"]); // ✓ green
    expect(pick("anchor_pending")).toEqual(["pending", "pending"]); // ◔ amber
    expect(pick("checking")).toEqual(["spinner", "neutral"]); // spinner
    expect(pick("cannot_verify")).toEqual(["question", "neutral"]); // ? grey
    expect(pick("failed")).toEqual(["cross", "critical"]); // ✕ red
  });

  it("never dress a failure to check as a failure, nor a pending anchor as one", () => {
    expect(VERIFY_BADGE_SPECS.cannot_verify.tone).not.toBe("critical");
    expect(VERIFY_BADGE_SPECS.anchor_pending.tone).not.toBe("critical");
    expect(VERIFY_BADGE_SPECS.checking.tone).not.toBe("critical");
    expect(VERIFY_BADGE_SPECS.failed.tone).toBe("critical");
  });

  it("never rely on colour alone: each has its own words AND its own icon shape", () => {
    const specs = VERIFY_STATES.map((state) => VERIFY_BADGE_SPECS[state]);

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

  it("tell the two grey states apart without colour", () => {
    const grey = VERIFY_STATES.map((state) => VERIFY_BADGE_SPECS[state]).filter(
      (spec) => spec.tone === "neutral",
    );
    expect(grey.map((spec) => spec.state)).toEqual(["checking", "cannot_verify"]);
    expect(new Set(grey.map((spec) => spec.icon)).size).toBe(2);
    expect(new Set(grey.map((spec) => spec.label)).size).toBe(2);
  });

  it("explain themselves in one plain sentence, without the jargon design.md bans", () => {
    for (const state of VERIFY_STATES) {
      const { meaning } = VERIFY_BADGE_SPECS[state];
      expect(meaning.trim().length).toBeGreaterThan(0);
      expect(meaning).toMatch(/[.]$/);
      // "node" is allowed: the verify-sweep copy says "on this node" and
      // "the node's public log" by decision (bug_spec_verify4 bug 4), where
      // design.md §8's vocabulary rule used to ask for "server"/"network".
      expect(meaning).not.toMatch(/blockchain|token|hash|CID/i);
    }
  });

  it("never promise a timestamp this node cannot add (phase 1 has no anchoring)", () => {
    expect(VERIFY_BADGE_SPECS.anchor_pending.meaning).toBe(
      "Signed. Anchoring is not enabled on this node yet.",
    );
    for (const state of VERIFY_STATES) {
      expect(VERIFY_BADGE_SPECS[state].meaning).not.toMatch(/within the hour/i);
    }
  });

  it("say what design.md §8 says for the failure state", () => {
    expect(VERIFY_BADGE_SPECS.failed.meaning).toContain(
      "This file does not match what the authors signed. Do not rely on it.",
    );
  });
});

describe("the icons the states draw", () => {
  it("are drawn: the four new shapes exist and have strokes", () => {
    for (const name of ["pending", "spinner", "question", "cross"] as const) {
      expect(ICON_SHAPES[name].length).toBeGreaterThan(0);
      for (const shape of ICON_SHAPES[name]) {
        expect(["path", "circle"]).toContain(shape.tag);
      }
    }
  });

  it("keep every path on the 16 × 16 grid", () => {
    for (const name of ["pending", "spinner", "question", "cross"] as const) {
      for (const shape of ICON_SHAPES[name]) {
        if (shape.tag !== "path") continue;
        // Absolute and relative commands both start from numbers on the grid;
        // checking the absolute `M` start points is enough to catch a slip.
        const start = /^M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(String(shape.attrs.d));
        expect(start, `${name}: ${shape.attrs.d}`).not.toBeNull();
        for (const value of [start![1], start![2]]) {
          expect(Number(value)).toBeGreaterThanOrEqual(0);
          expect(Number(value)).toBeLessThanOrEqual(16);
        }
      }
    }
  });

  it("fill only the ◔ wedge: every other shape is a stroke", () => {
    const filled = Object.entries(ICON_SHAPES).flatMap(([name, shapes]) =>
      (shapes as readonly IconShape[])
        .filter((shape) => "fill" in shape.attrs)
        .map((shape) => [name, shape.attrs.fill]),
    );
    expect(filled).toEqual([["pending", "currentColor"]]);
  });
});

describe("isVerifyState", () => {
  it("accepts the five states", () => {
    for (const state of VERIFY_STATES) expect(isVerifyState(state)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [
      "pending",
      "anchor-pending",
      "Verified",
      "",
      " verified",
      undefined,
      null,
      4,
      {},
      ["verified"],
    ]) {
      expect(isVerifyState(value), String(value)).toBe(false);
    }
  });
});

describe("proofTabHref", () => {
  it("is the Proof tab's fragment on its own", () => {
    expect(PROOF_TAB_HREF).toBe("#proof");
    expect(proofTabHref()).toBe("#proof");
  });

  it("puts the fragment on a paper's path", () => {
    expect(proofTabHref("/p/k3f9-q2xz-7mwd/v2")).toBe("/p/k3f9-q2xz-7mwd/v2#proof");
    expect(proofTabHref("  /p/k3f9-q2xz-7mwd  ")).toBe("/p/k3f9-q2xz-7mwd#proof");
  });

  it("replaces a fragment already on the path: the badge opens the Proof tab, not another", () => {
    expect(proofTabHref("/p/k3f9-q2xz-7mwd#reviews")).toBe("/p/k3f9-q2xz-7mwd#proof");
    expect(proofTabHref("#files")).toBe("#proof");
  });

  it("never returns a link that goes nowhere", () => {
    for (const base of ["", "   ", undefined, null, 4, {}]) {
      expect(proofTabHref(base as never)).toBe("#proof");
    }
  });
});

describe("verifyBadgeTitle", () => {
  it("is the meaning, then what a click does", () => {
    for (const state of VERIFY_STATES) {
      expect(verifyBadgeTitle(state)).toBe(
        `${VERIFY_BADGE_SPECS[state].meaning} Opens the Proof tab.`,
      );
    }
  });
});

describe("countedLabel", () => {
  const counts = (versions: number, signatures: number): VerifyCounts => ({
    versions,
    signatures,
  });

  it("says what the counts are: author signatures across versions", () => {
    expect(countedLabel("verified", counts(3, 4))).toBe(
      "Verified · 4 author signatures across 3 versions",
    );
  });

  it("counts a check that passed but is not anchored the same way", () => {
    expect(countedLabel("anchor_pending", counts(2, 3))).toBe(
      "Verified · 3 author signatures across 2 versions",
    );
  });

  it("pluralises one version and one signature honestly", () => {
    expect(countedLabel("verified", counts(1, 1))).toBe(
      "Verified · 1 author signature across 1 version",
    );
  });

  it("reads naturally for a chain with more signers than its newest version lists", () => {
    // Two versions whose author lists together name four distinct signing
    // authors (PRD journey 3's shape): 4 signatures across 2 versions.
    expect(countedLabel("anchor_pending", counts(2, 4))).toBe(
      "Verified · 4 author signatures across 2 versions",
    );
  });

  it("keeps the state's own label when there is nothing to count", () => {
    for (const state of VERIFY_STATES) {
      expect(countedLabel(state, null)).toBe(VERIFY_BADGE_SPECS[state].label);
    }
  });

  it("never dresses a failure or an unfinished check as Verified", () => {
    for (const state of ["checking", "cannot_verify", "failed"] as const) {
      expect(countedLabel(state, counts(3, 4))).toBe(
        VERIFY_BADGE_SPECS[state].label,
      );
    }
  });

  it("refuses counts that are not whole numbers, rather than printing them", () => {
    for (const bad of [counts(-1, 4), counts(3, 0), counts(1.5, 2)]) {
      expect(countedLabel("verified", bad)).toBe(VERIFY_BADGE_SPECS.verified.label);
    }
  });
});

describe("verify.ts source", () => {
  it("imports no React: it is data and functions only", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "verify.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']react["']/);
  });
});
