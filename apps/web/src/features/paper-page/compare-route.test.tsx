// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ComparePage, {
  dynamic,
  generateMetadata,
} from "../../app/(paper-page)/p/[id]/compare/[range]/page";
import {
  BARE_ID,
  COMPARE_BODY,
  HAPPY,
  SHORT_ID,
  json,
  notFound,
  stubApi,
} from "./paper-page-fixtures";
import { NOT_A_COMPARE_ADDRESS, parseCompareAddress } from "./compare-route";

/**
 * `/p/{id}/compare/{from}..{to}` is server-rendered: the first HTML response
 * must already name both versions, carry both change notes and show the
 * paragraph diff the node computed, so a shared link to a comparison reads
 * before JavaScript runs.
 *
 * These tests render the real route file against a stubbed node.
 */

/** Server-render an element and put its HTML in the document to query it. */
function mount(element: ReactElement): void {
  document.body.innerHTML = renderToStaticMarkup(element);
}

const comparePage = async (id: string, range: string) =>
  ComparePage({ params: Promise.resolve({ id, range }) });

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the route file", () => {
  it("reads live data for an id taken from the URL, so nothing is prerendered", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("parseCompareAddress", () => {
  it("reads a bare id and both version numbers", () => {
    expect(parseCompareAddress([BARE_ID, "compare", "1..2"])).toEqual({
      id: SHORT_ID,
      from: 1,
      to: 2,
    });
  });

  it("accepts the prefix and a percent-encoded colon, like paper addresses", () => {
    expect(parseCompareAddress([SHORT_ID, "compare", "2..3"])).not.toBeNull();
    expect(
      parseCompareAddress(["sch%3A6sel-2dio-orm6", "compare", "2..3"]),
    ).toEqual({ id: SHORT_ID, from: 2, to: 3 });
  });

  it("rejects anything that is not two positive whole numbers joined by ..", () => {
    for (const segments of [
      [],
      [BARE_ID, "compare"],
      [BARE_ID, "compare", "0..2"],
      [BARE_ID, "compare", "1..0"],
      [BARE_ID, "compare", "1.2"],
      [BARE_ID, "compare", "v1..v2"],
      [BARE_ID, "compare", "1..2..3"],
      [BARE_ID, "versions", "1..2"],
      ["not an id!", "compare", "1..2"],
    ]) {
      expect(parseCompareAddress(segments)).toBeNull();
    }
  });
});

describe("the comparison", () => {
  it("names both versions and links back to the version on screen", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Compare v1 with v2");
    expect(screen.getByRole("link", { name: /Back to v2/ }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v2",
    );
  });

  it("shows the paper's title, linking to the newer version", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    const title = screen.getByRole("link", {
      name: "Can a Meta-Agent Choose the Safer Branch?",
    });
    expect(title.getAttribute("href")).toBe("/p/6sel-2dio-orm6/v2");
  });

  it("summarises what changed between the two versions", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    expect(
      screen.getByText(
        "1 paragraph changed, 1 paragraph added and 1 paragraph removed between v1 and v2.",
      ),
    ).toBeTruthy();
  });

  it("shows both change notes, with the first version's placeholder when it has none", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    const notes = screen.getByRole("region", { name: "Change notes" });
    expect(notes.textContent).toContain("Version 1");
    expect(notes.textContent).toContain("First version.");
    expect(notes.textContent).toContain("Version 2");
    expect(notes.textContent).toContain("Names the adversarial baseline in section 3.2.");
  });

  it("shows changed paragraphs as old text and new text, in their versions", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    const changed = screen.getByRole("region", { name: /Changed paragraphs/ });
    expect(changed.textContent).toContain("Changed paragraph");
    expect(changed.textContent).toContain("In v1");
    expect(changed.textContent).toContain("In v2");

    const oldText = within(changed).getByText(
      "Multi-agent systems choose between candidate plans.",
    );
    const newText = within(changed).getByText(
      "Multi-agent systems increasingly choose between candidate plans.",
    );
    expect(oldText.tagName).toBe("DEL");
    expect(newText.tagName).toBe("INS");
  });

  it("shows added and removed paragraphs under their own words", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    const added = screen.getByRole("region", { name: /Added in v2/ });
    expect(added.textContent).toContain("Added in v2");
    expect(
      within(added).getByText(
        "Section 3.2 now names the adversarial baseline and its seed.",
      ).tagName,
    ).toBe("INS");

    const removed = screen.getByRole("region", { name: /Removed from v1/ });
    expect(removed.textContent).toContain("Removed from v1");
    expect(
      within(removed).getByText("The baseline was tuned on the test split.").tagName,
    ).toBe("DEL");
  });

  it("offers a way to read either version", async () => {
    stubApi();
    mount(await comparePage(BARE_ID, "1..2"));

    expect(screen.getByRole("link", { name: "Read v1" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v1",
    );
    expect(screen.getByRole("link", { name: "Read v2" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v2",
    );
  });

  it("says so plainly when the two versions have the same paragraphs", async () => {
    stubApi({
      ...HAPPY,
      compare: () =>
        json({
          ...COMPARE_BODY,
          addedParagraphs: [],
          removedParagraphs: [],
          changedParagraphs: [],
        }),
    });
    mount(await comparePage(BARE_ID, "1..2"));

    expect(
      screen.getByText("These two versions have the same paragraphs."),
    ).toBeTruthy();
    expect(screen.getByTestId("ppg-compare-empty").textContent).toBe(
      "Nothing changed between these versions.",
    );
    expect(screen.queryByText(/Changed paragraphs/)).toBeNull();
  });

  it("still shows the comparison when the paper's title cannot be read", async () => {
    stubApi({ ...HAPPY, paper: () => notFound() });
    mount(await comparePage(BARE_ID, "1..2"));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Compare v1 with v2",
    );
    expect(screen.getByRole("region", { name: /Changed paragraphs/ })).toBeTruthy();
    expect(
      screen.queryByRole("link", {
        name: "Can a Meta-Agent Choose the Safer Branch?",
      }),
    ).toBeNull();
  });
});

describe("a comparison that cannot be shown", () => {
  it("reports a malformed address without asking the node", async () => {
    mount(await comparePage(BARE_ID, "1-2"));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Comparison unavailable",
    );
    expect(screen.getByText(NOT_A_COMPARE_ADDRESS)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to search" }).getAttribute("href")).toBe(
      "/search",
    );
  });

  it("says when the node does not hold both versions, with a way back", async () => {
    stubApi({ ...HAPPY, compare: () => notFound() });
    mount(await comparePage(BARE_ID, "1..2"));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "This server does not hold both versions of that paper.",
    );
    expect(screen.getByRole("link", { name: "Back to v2" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v2",
    );
  });
});

describe("metadata", () => {
  it("titles the page with the paper and both versions", async () => {
    stubApi();
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: BARE_ID, range: "1..2" }),
    });
    expect(metadata.title).toBe(
      "Compare v1 with v2 of Can a Meta-Agent Choose the Safer Branch? · Scholium",
    );
    expect(metadata.description).toContain(
      "Paragraph-by-paragraph changes between version 1 and version 2",
    );
  });

  it("keeps a comparison of unknown versions out of search", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: BARE_ID, range: "nope" }),
    });
    expect(metadata.title).toBe("Comparison unavailable · Scholium");
    expect(metadata.robots).toEqual({ index: false });
  });
});
