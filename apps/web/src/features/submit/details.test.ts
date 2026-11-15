import { describe, expect, it } from "vitest";

import {
  ABSTRACT_MAX_LENGTH,
  CATEGORIES,
  DEFAULT_LICENCE_ID,
  LICENCES,
  MAX_CATEGORIES,
  TITLE_MAX_LENGTH,
  canContinueDetails,
  detailsBlockers,
  emptyDetails,
  licenceById,
  toggleCategory,
  type DetailsValues,
} from "./details";

const complete: DetailsValues = {
  title: "Sparse Probing of Reward Models",
  abstract: "We study whether sparse linear probes recover the features a reward model relies on.",
  categories: ["cs.LG", "cs.AI"],
  licence: DEFAULT_LICENCE_ID,
};

describe("licences", () => {
  it("defaults to CC BY 4.0, the licence the PRD names", () => {
    expect(DEFAULT_LICENCE_ID).toBe("CC-BY-4.0");
    expect(emptyDetails().licence).toBe(DEFAULT_LICENCE_ID);
    expect(LICENCES[0].id).toBe(DEFAULT_LICENCE_ID);
  });

  it("gives every option a one-line explanation and a journal-compatibility flag", () => {
    for (const licence of LICENCES) {
      expect(licence.label).not.toBe("");
      expect(licence.summary).not.toBe("");
      expect(licence.summary).not.toContain("\n");
      expect(["accepted", "check"]).toContain(licence.journal);
    }
  });

  it("uses the ids the signed record stores", () => {
    expect(LICENCES.map((licence) => licence.id)).toEqual([
      "CC-BY-4.0",
      "CC-BY-SA-4.0",
      "CC-BY-NC-4.0",
      "CC-BY-NC-ND-4.0",
      "CC0-1.0",
    ]);
    expect(licenceById("CC-BY-NC-4.0")?.label).toBe("CC BY-NC 4.0");
    expect(licenceById("not-a-licence")).toBeUndefined();
  });
});

describe("categories", () => {
  it("lists each category once, as a grouped arXiv id with a plain name", () => {
    const ids = CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("cs.AI");
    expect(ids).toContain("stat.ML");
    expect(CATEGORIES.find((category) => category.id === "cs.AI")?.name).toBe("Artificial intelligence");
  });

  it("toggles a category on and off, keeping the order the author picked", () => {
    expect(toggleCategory([], "cs.LG")).toEqual(["cs.LG"]);
    expect(toggleCategory(["cs.LG"], "cs.AI")).toEqual(["cs.LG", "cs.AI"]);
    expect(toggleCategory(["cs.LG", "cs.AI"], "cs.LG")).toEqual(["cs.AI"]);
  });

  it("refuses a fourth category", () => {
    const three = ["cs.LG", "cs.AI", "cs.MA"];
    expect(three).toHaveLength(MAX_CATEGORIES);
    expect(toggleCategory(three, "cs.CR")).toEqual(three);
    // Removing still works at the limit.
    expect(toggleCategory(three, "cs.MA")).toEqual(["cs.LG", "cs.AI"]);
  });
});

describe("detailsBlockers", () => {
  it("accepts a complete step", () => {
    expect(detailsBlockers(complete)).toEqual([]);
    expect(canContinueDetails(complete)).toBe(true);
  });

  it("names every missing part in the order it should be fixed", () => {
    expect(detailsBlockers(emptyDetails())).toEqual([
      "Add a title to continue.",
      "Add an abstract to continue.",
      "Choose at least one category to continue.",
    ]);
  });

  it("treats whitespace as empty", () => {
    const blockers = detailsBlockers({ ...complete, title: "   ", abstract: "\n\t" });
    expect(blockers).toContain("Add a title to continue.");
    expect(blockers).toContain("Add an abstract to continue.");
  });

  it("rejects values past the stated limits", () => {
    const blockers = detailsBlockers({
      ...complete,
      title: "x".repeat(TITLE_MAX_LENGTH + 1),
      abstract: "x".repeat(ABSTRACT_MAX_LENGTH + 1),
    });
    expect(blockers).toEqual([
      `Shorten the title to ${TITLE_MAX_LENGTH} characters or fewer.`,
      `Shorten the abstract to ${ABSTRACT_MAX_LENGTH} characters or fewer.`,
    ]);
  });

  it("rejects a category this release does not list, and more than three", () => {
    expect(detailsBlockers({ ...complete, categories: ["cs.XX"] })).toEqual([
      "Remove the category this release does not list.",
    ]);
    expect(detailsBlockers({ ...complete, categories: ["cs.LG", "cs.AI", "cs.MA", "cs.CR"] })).toEqual([
      `Choose no more than ${MAX_CATEGORIES} categories.`,
    ]);
  });

  it("requires a licence it knows", () => {
    expect(detailsBlockers({ ...complete, licence: "unknown" })).toEqual(["Choose a licence to continue."]);
  });
});
