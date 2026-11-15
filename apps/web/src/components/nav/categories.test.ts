// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  categoryHref,
  DEFAULT_CATEGORIES,
  type NavCategory,
} from "./categories";
import { countUnread } from "./notifications";

describe("DEFAULT_CATEGORIES", () => {
  it("lists the launch taxonomy from design.md §5.1", () => {
    expect(DEFAULT_CATEGORIES.map((category) => category.id)).toEqual([
      "cs.AI",
      "cs.LG",
      "cs.MA",
    ]);
  });

  it("gives every category a non-empty label", () => {
    for (const category of DEFAULT_CATEGORIES) {
      expect(category.label.trim()).not.toBe("");
    }
  });
});

describe("categoryHref", () => {
  it("builds the /c/{category} path from design.md §4", () => {
    expect(categoryHref({ id: "cs.AI" })).toBe("/c/cs.AI");
  });

  it("keeps ids with reserved characters a single path segment", () => {
    expect(categoryHref({ id: "math/AT" })).toBe("/c/math%2FAT");
  });
});

describe("countUnread", () => {
  it("counts rows with read false", () => {
    const rows: Array<{ read: boolean }> = [
      { read: false },
      { read: true },
      { read: false },
    ];
    expect(countUnread(rows)).toBe(2);
  });

  it("treats a missing read flag as unread", () => {
    expect(countUnread([{ id: 7 }, { read: true }])).toBe(1);
  });

  it("returns 0 for empty lists and non-lists", () => {
    expect(countUnread([])).toBe(0);
    expect(countUnread(null)).toBe(0);
    expect(countUnread({ read: false })).toBe(0);
  });

  it("ignores null and primitive rows", () => {
    expect(countUnread([null, "row", 3, { read: false }])).toBe(1);
  });
});

describe("NavCategory type", () => {
  it("accepts the shape the menu renders", () => {
    const category: NavCategory = { id: "cs.CL", label: "Computation and Language" };
    expect(categoryHref(category)).toBe("/c/cs.CL");
  });
});
