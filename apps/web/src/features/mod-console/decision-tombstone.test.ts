import { describe, expect, it } from "vitest";

import {
  DECISION_ACTIONS,
  EMPTY_DECISION_DRAFT,
  TOMBSTONE_ACTION,
  TOMBSTONE_MIN_TIER,
  actionOptionLabel,
  authorPreview,
  buildDecisionBody,
  canTombstone,
  isDecisionAction,
  isSignableAction,
  offeredActions,
  validateDecisionDraft,
  type DecisionDraft,
} from "./decision";

/**
 * Tombstone is the legal takedown (policy MOD-05): the API deletes the
 * version's files and denylists their ids, and accepts it from tier 4 only.
 * The form offers it to tier 4 alone, and asks for the legal reason.
 */

const CLAUSES = [{ id: "MOD-05", title: "Legal takedown", text: "Content is removed on a legal order." }];

const draft = (overrides: Partial<DecisionDraft> = {}): DecisionDraft => ({
  ...EMPTY_DECISION_DRAFT,
  action: "tombstone",
  clause: "MOD-05",
  reason: "Court order 2026/114: the figures infringe a third party's copyright.",
  ...overrides,
});

describe("the tombstone action", () => {
  it("is an action the form can sign, with a label, apart from the five any moderator may choose", () => {
    expect(TOMBSTONE_ACTION).toBe("tombstone");
    expect(isSignableAction("tombstone")).toBe(true);
    expect(isSignableAction("list")).toBe(true);
    expect(isSignableAction("banish")).toBe(false);
    expect(actionOptionLabel("tombstone")).toMatch(/legal takedown/i);
    expect(actionOptionLabel("reject")).toBe("Reject the paper");
    // The five stay the five: other views (appeals) word only those.
    expect(DECISION_ACTIONS).not.toContain("tombstone");
    expect(isDecisionAction("tombstone")).toBe(false);
  });

  it("is offered to tier 4 and to nobody else", () => {
    expect(TOMBSTONE_MIN_TIER).toBe(4);
    expect(canTombstone(4)).toBe(true);
    expect(canTombstone(3)).toBe(false);
    expect(canTombstone(0)).toBe(false);
    // A tier nobody could read from the token is not enough to offer it.
    expect(canTombstone(null)).toBe(false);
  });

  it("is the last action of the list a tier-4 moderator sees, and absent otherwise", () => {
    // Dismiss settles the flag without moving the paper; it comes before the
    // legal takedown, which only tier 4 may issue.
    expect(offeredActions(4)).toEqual([...DECISION_ACTIONS, "dismiss", "tombstone"]);
    expect(offeredActions(3)).toEqual([...DECISION_ACTIONS, "dismiss"]);
    expect(offeredActions(null)).toEqual([...DECISION_ACTIONS, "dismiss"]);
  });
});

describe("dismissing a paper flag", () => {
  it("is offered to every moderator and reads as settling the flag", () => {
    expect(offeredActions(null)).toContain("dismiss");
    expect(actionOptionLabel("dismiss")).toMatch(/dismiss the flag/i);
    expect(
      authorPreview(draft({ action: "dismiss", clause: "MOD-01" }), CLAUSES)
        ?.headline,
    ).toMatch(/nothing changes/i);
  });
});

describe("a tombstone draft", () => {
  it("is complete with a clause and a legal reason", () => {
    expect(validateDecisionDraft(draft())).toEqual({});
  });

  it("requires the legal reason, in words that name it", () => {
    for (const reason of ["", "   \n "]) {
      expect(validateDecisionDraft(draft({ reason })).reason).toMatch(/legal reason/i);
    }
  });

  it("still requires a policy clause", () => {
    expect(validateDecisionDraft(draft({ clause: "" })).clause).toBeTruthy();
  });

  it("builds the body the API accepts: the version as target, no category", () => {
    expect(buildDecisionBody("bafyversion", draft({ reason: "  Court order 114.  " }))).toEqual({
      target: "bafyversion",
      action: "tombstone",
      clause: "MOD-05",
      reason: "Court order 114.",
    });
  });

  it("refuses to build a body with no legal reason", () => {
    expect(() => buildDecisionBody("bafyversion", draft({ reason: " " }))).toThrow(/legal reason/i);
  });
});

describe("the author preview of a tombstone", () => {
  it("says the files were removed for legal reasons, and quotes the reason and clause", () => {
    const preview = authorPreview(draft(), CLAUSES);

    expect(preview?.headline).toMatch(/removed/i);
    expect(preview?.headline).toMatch(/legal/i);
    expect(preview?.reason).toBe(
      "Court order 2026/114: the figures infringe a third party's copyright.",
    );
    expect(preview?.clause?.id).toBe("MOD-05");
  });
});
