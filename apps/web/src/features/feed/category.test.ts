import { describe, expect, it } from "vitest";

import {
  CATEGORY_MAX_CHARS,
  categoryDescription,
  categoryEmptySentence,
  categoryFeedHref,
  categoryFeedPath,
  categoryFeedState,
  categoryLabel,
  categoryLede,
  categoryPageHref,
  normalizeCategory,
} from "./category";

describe("normalizeCategory", () => {
  it("trims a category and keeps the API's own spelling", () => {
    expect(normalizeCategory("  cs.AI  ")).toBe("cs.AI");
  });

  it("takes the first value of a repeated parameter", () => {
    expect(normalizeCategory(["cs.LG", "cs.AI"])).toBe("cs.LG");
  });

  it("accepts a category exactly at the API's limit", () => {
    const category = "x".repeat(CATEGORY_MAX_CHARS);
    expect(normalizeCategory(category)).toBe(category);
  });

  it("rejects a missing, blank or over-long category", () => {
    expect(normalizeCategory(undefined)).toBe("");
    expect(normalizeCategory(null)).toBe("");
    expect(normalizeCategory("   ")).toBe("");
    expect(normalizeCategory("x".repeat(CATEGORY_MAX_CHARS + 1))).toBe("");
  });
});

describe("category labels", () => {
  it("names a launch category and falls back to the id otherwise", () => {
    expect(categoryLabel("cs.AI")).toBe("Artificial Intelligence");
    expect(categoryLabel("astro-ph.HE")).toBeNull();
  });

  it("writes the lede and the description from the taxonomy", () => {
    expect(categoryLede("cs.AI")).toContain("Artificial Intelligence");
    expect(categoryLede("cs.AI")).toContain("cs.AI");
    expect(categoryLede("astro-ph.HE")).toContain("astro-ph.HE");
    expect(categoryDescription("cs.LG")).toContain("Machine Learning");
    expect(categoryDescription("astro-ph.HE")).toContain("astro-ph.HE");
  });
});

describe("category URLs", () => {
  it("is the latest tab narrowed to the category, newest first", () => {
    expect(categoryFeedState("cs.AI")).toEqual({
      tab: "latest",
      category: "cs.AI",
      sort: "newest",
    });
  });

  it("points the page at /c/{category}", () => {
    expect(categoryPageHref("cs.AI")).toBe("/c/cs.AI");
  });

  it("points the Atom link at the API feed, percentage-encoded", () => {
    expect(categoryFeedPath("cs.AI")).toBe("/v1/feeds/cs.AI");
    expect(categoryFeedPath("a/b")).toBe("/v1/feeds/a%2Fb");
  });

  it("makes the Atom URL absolute against the API base", () => {
    expect(categoryFeedHref("cs.AI", "https://api.example.org/")).toBe(
      "https://api.example.org/v1/feeds/cs.AI",
    );
  });

  it("says one sentence when the category has no papers", () => {
    expect(categoryEmptySentence("cs.AI")).toBe("No papers are listed in cs.AI yet.");
  });
});
