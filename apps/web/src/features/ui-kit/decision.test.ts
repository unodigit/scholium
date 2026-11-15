import { describe, expect, it } from "vitest";

import { DECISION_KINDS } from "./decision";
import {
  DECISION_BANNER_SPECS,
  decisionDetail,
  decisionPolicyLabel,
  decisionVersionLabel,
  isDecisionKind,
  normalizeClauseId,
} from "./decision";

describe("the decision data", () => {
  it("has the four kinds of docs/design.md §5.2, in its order", () => {
    expect(DECISION_KINDS).toEqual([
      "retracted",
      "corrected",
      "newer_version",
      "removed_legal",
    ]);
  });

  it("renders the four words of docs/design.md §5.2, verbatim", () => {
    expect(DECISION_KINDS.map((kind) => DECISION_BANNER_SPECS[kind].label)).toEqual(
      [
        "Retracted",
        "Corrected",
        "A newer version exists",
        "Content removed for legal reasons",
      ],
    );
  });

  it("gives the kinds the tones docs/design.md §5.2 assigns", () => {
    expect(DECISION_KINDS.map((kind) => DECISION_BANNER_SPECS[kind].tone)).toEqual([
      "critical",
      "pending",
      "neutral",
      "neutral",
    ]);
  });

  it("gives every kind a different icon, so colour is never the only difference", () => {
    const icons = DECISION_KINDS.map((kind) => DECISION_BANNER_SPECS[kind].icon);
    expect(new Set(icons).size).toBe(DECISION_KINDS.length);
  });

  it("keeps the retracted and corrected words in step with the status chips", () => {
    expect(DECISION_BANNER_SPECS.retracted.label).toBe("Retracted");
    expect(DECISION_BANNER_SPECS.retracted.icon).toBe("ban");
    expect(DECISION_BANNER_SPECS.corrected.label).toBe("Corrected");
    expect(DECISION_BANNER_SPECS.corrected.icon).toBe("pencil");
  });

  it("isDecisionKind narrows unknown values", () => {
    for (const kind of DECISION_KINDS) expect(isDecisionKind(kind)).toBe(true);
    for (const value of ["withdrawn", "", "newer-version", undefined, null, 7]) {
      expect(isDecisionKind(value)).toBe(false);
    }
  });
});

describe("normalizeClauseId", () => {
  it("trims a clause id", () => {
    expect(normalizeClauseId("  MOD-05 ")).toBe("MOD-05");
  });

  it("treats a blank or non-string clause as no clause", () => {
    for (const clause of ["", "   ", undefined, null, 5, {}]) {
      expect(normalizeClauseId(clause)).toBeUndefined();
    }
  });
});

describe("decisionDetail", () => {
  it("gives each kind its plain default sentence", () => {
    expect(decisionDetail("retracted")).toBe(
      "A retraction notice is on record. Every version carries it.",
    );
    expect(decisionDetail("corrected")).toBe(
      "A correction notice is on record.",
    );
    expect(decisionDetail("newer_version")).toBe(
      "You are reading an older version of this paper.",
    );
    expect(decisionDetail("removed_legal")).toBe(
      "The record of its existence remains.",
    );
  });

  it("shows a decision's own reason verbatim, closed as a sentence", () => {
    expect(decisionDetail("retracted", { reason: "Data cannot be reproduced." })).toBe(
      "Data cannot be reproduced.",
    );
    expect(decisionDetail("corrected", { reason: " Figure 2 axis mislabelled" })).toBe(
      "Figure 2 axis mislabelled.",
    );
  });

  it("ignores a blank reason rather than emptying the sentence", () => {
    for (const reason of ["", "   ", undefined]) {
      expect(decisionDetail("retracted", { reason })).toBe(
        DECISION_BANNER_SPECS.retracted.detail,
      );
    }
  });

  it("names the newest version when it knows it", () => {
    expect(decisionDetail("newer_version", { versionLabel: "v3" })).toBe(
      "You are reading an older version. The newest is v3.",
    );
    expect(decisionDetail("newer_version", { versionLabel: "  " })).toBe(
      DECISION_BANNER_SPECS.newer_version.detail,
    );
  });

  it("builds the tombstone sentence from the removal date and category", () => {
    expect(
      decisionDetail("removed_legal", {
        removedOn: "4 May 2027",
        category: "Unlawful content",
      }),
    ).toBe(
      "Removed on 4 May 2027 · Unlawful content. The record of its existence remains.",
    );
  });

  it("composes the tombstone from whichever facts it has", () => {
    expect(decisionDetail("removed_legal", { removedOn: "4 May 2027" })).toBe(
      "Removed on 4 May 2027. The record of its existence remains.",
    );
    expect(decisionDetail("removed_legal", { category: "Privacy" })).toBe(
      "Removed · Privacy. The record of its existence remains.",
    );
    expect(
      decisionDetail("removed_legal", { removedOn: " ", category: "  " }),
    ).toBe("The record of its existence remains.");
  });

  it("never drops the tombstone's closing sentence, even with a reason", () => {
    expect(
      decisionDetail("removed_legal", {
        reason: "Unlawful in the node's operating jurisdiction",
      }),
    ).toBe(
      "Unlawful in the node's operating jurisdiction. The record of its existence remains.",
    );
  });
});

describe("link labels", () => {
  it("policy labels follow the anchor contract's example", () => {
    expect(decisionPolicyLabel("MOD-02")).toBe("Policy MOD-02");
    expect(decisionPolicyLabel("MOD-05")).toBe("Policy MOD-05");
  });

  it("version links name the version, or the newest one", () => {
    expect(decisionVersionLabel("v3")).toBe("Go to v3");
    expect(decisionVersionLabel()).toBe("Go to the newest version");
    expect(decisionVersionLabel("   ")).toBe("Go to the newest version");
  });
});
