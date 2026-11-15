import { describe, expect, it } from "vitest";

import {
  MARGIN_TAB_IDS,
  archiveHref,
  categoryHref,
  citeHref,
  comparePagePath,
  isMarginTabId,
  tabFromHash,
  tabHash,
  versionPagePath,
} from "./paper-links";

/**
 * Where the page's actions and tabs point. The Cite link (what the action is
 * until the page runs, when it becomes the dialog) and the Download archive
 * (the link, and then the menu's item) are the node's endpoints, and every tab
 * answers to a fragment (`#proof` is the one the Verify badge uses).
 */

const NODE = "https://node.example";

describe("tabs", () => {
  it("are the six of docs/design.md §5.2, in order", () => {
    expect(MARGIN_TAB_IDS).toEqual([
      "reviews",
      "ai",
      "discussion",
      "versions",
      "files",
      "proof",
    ]);
  });

  it("are addressed by fragment", () => {
    expect(tabHash("proof")).toBe("#proof");
    expect(tabFromHash("#proof")).toBe("proof");
    expect(tabFromHash("proof")).toBe("proof");
    expect(tabFromHash("#Discussion")).toBe("discussion");
  });

  it("round-trip: every tab's hash names that tab", () => {
    for (const tab of MARGIN_TAB_IDS) {
      expect(tabFromHash(tabHash(tab))).toBe(tab);
    }
  });

  it("leave the panel alone for a fragment that is not a tab", () => {
    expect(tabFromHash("")).toBeNull();
    expect(tabFromHash("#")).toBeNull();
    expect(tabFromHash("#p-abc123")).toBeNull();
    expect(tabFromHash("#reading")).toBeNull();
    expect(isMarginTabId("proofs")).toBe(false);
    expect(isMarginTabId(undefined)).toBe(false);
  });
});

describe("cite and download", () => {
  it("cites the exact version on screen, as BibTeX", () => {
    expect(citeHref("sch:6sel-2dio-orm6", 2, NODE)).toBe(
      `${NODE}/v1/papers/sch%3A6sel-2dio-orm6/v2/cite?format=bibtex`,
    );
  });

  it("downloads the whole paper's archive, not one version", () => {
    expect(archiveHref("sch:6sel-2dio-orm6", NODE)).toBe(
      `${NODE}/v1/export/paper/sch%3A6sel-2dio-orm6.car`,
    );
  });

  it("follows the configured API origin", () => {
    expect(citeHref("sch:6sel-2dio-orm6", 1, `${NODE}/`)).toBe(
      `${NODE}/v1/papers/sch%3A6sel-2dio-orm6/v1/cite?format=bibtex`,
    );
  });
});

describe("page addresses", () => {
  it("writes a version page without the sch: prefix", () => {
    expect(versionPagePath("sch:6sel-2dio-orm6", 2)).toBe("/p/6sel-2dio-orm6/v2");
    expect(versionPagePath("6sel-2dio-orm6", 1)).toBe("/p/6sel-2dio-orm6/v1");
  });

  it("writes a compare page with both versions, older first", () => {
    expect(comparePagePath("sch:6sel-2dio-orm6", 1, 2)).toBe(
      "/p/6sel-2dio-orm6/compare/1..2",
    );
    expect(comparePagePath("6sel-2dio-orm6", 2, 3)).toBe(
      "/p/6sel-2dio-orm6/compare/2..3",
    );
  });

  it("links a category to its page", () => {
    expect(categoryHref("cs.AI")).toBe("/c/cs.AI");
  });
});
