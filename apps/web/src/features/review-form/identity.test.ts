import { describe, expect, it } from "vitest";

import {
  COMMIT_NOTE_ANONYMOUS,
  COMMIT_NOTE_SIGNED,
  SEALED_SIGNED_NOTE,
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
  STYLOMETRY_TIP,
} from "./identity";

describe("the design's words (docs/design.md §5.5)", () => {
  it("names the option exactly as the design does", () => {
    expect(SIGN_WITH_NAME_LABEL).toBe("Sign with my name instead");
  });

  it("gives the stylometry tip exactly as the design does", () => {
    expect(STYLOMETRY_TIP).toBe("Tip: avoid phrases that identify you or your lab.");
  });
});

describe("what signing means", () => {
  it("says the review is credited by name and listed on the profile", () => {
    for (const detail of [SIGNED_DETAIL, SIGNED_SEALED_DETAIL]) {
      expect(detail).toMatch(/credited to you by name/);
      expect(detail).toMatch(/public profile/);
    }
  });

  it("says before committing that the choice is sealed with the review", () => {
    expect(SIGNED_DETAIL).toMatch(/sealed with your review/);
    expect(SIGNED_DETAIL).toMatch(/before you commit/);
    expect(SIGNED_SEALED_DETAIL).toMatch(/was sealed with your review/);
  });

  it("never promises anonymity to a reviewer who is signing", () => {
    for (const words of [SIGNED_HEADLINE, SIGNED_DETAIL, SIGNED_SEALED_DETAIL]) {
      expect(words).not.toMatch(/anonym|hidden/i);
    }
  });

  it("offers a way back that names what it goes back to", () => {
    expect(STAY_ANONYMOUS_LABEL).toBe("Stay anonymous instead");
  });

  it("adds to the commit note, not replaces it, when signing", () => {
    expect(COMMIT_NOTE_SIGNED.startsWith(COMMIT_NOTE_ANONYMOUS)).toBe(true);
    expect(COMMIT_NOTE_SIGNED).toMatch(/carry your name/);
    expect(SEALED_SIGNED_NOTE).toMatch(/carry your name/);
  });
});
