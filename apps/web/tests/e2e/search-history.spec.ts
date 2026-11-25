/**
 * Search history journeys (`npm run test:e2e`).
 *
 * The search page has two search boxes: its own, which records a search with
 * `history.pushState`, and the global header's, which goes through the Next
 * router and re-renders the page with the route's `initialState`. Those two
 * paths produce different props on a Back/Forward, and the bug this journey
 * guards against was that the router's props — the search the page was first
 * loaded with — overwrote the search in the address bar.
 *
 * Every query below matches no seeded paper on purpose: the journey is about
 * which query the page describes, not about what it finds, so it stays true
 * whatever the seed contains.
 */

import { expect, test, type Page } from "@playwright/test";

/** Typed in the page's own box; needs no seeded paper. */
const PAGE_BOX_TERM = "zzz page box counterexample";
/** Typed in the header's box; needs no seeded paper. */
const HEADER_TERM = "zzz header counterexample";
/** A full load that starts the second journey on a query of its own. */
const START_TERM = "zzz calibration counterexample";

/** The query in the address bar, decoded. */
function urlQuery(page: Page): string | null {
  return new URL(page.url()).searchParams.get("q");
}

/**
 * The page box, the results heading and the result area all describe `term` —
 * the same as a full load of that URL — and the idle prompt is gone.
 */
async function expectSearchFor(page: Page, term: string): Promise<void> {
  await expect.poll(() => urlQuery(page)).toBe(term);
  await expect(page.locator("#sp-q")).toHaveValue(term);
  await expect(page.locator(".sp-summary")).toContainText(`for “${term}”`);
  await expect(page.locator(".sp-empty")).toBeVisible();
  await expect(
    page.getByText("Enter a term above to search the listed papers."),
  ).toHaveCount(0);
}

/** Open a page and wait until it has hydrated, so a keypress reaches React. */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
}

/** Search from the page's own box: one new history entry. */
async function searchFromPageBox(page: Page, term: string): Promise<void> {
  const box = page.locator("#sp-q");
  await box.fill(term);
  await box.press("Enter");
  await expectSearchFor(page, term);
}

/** Search from the header's box: a router navigation with new route props. */
async function searchFromHeader(page: Page, term: string): Promise<void> {
  const box = page.getByLabel("Search papers, authors and sch: IDs", {
    exact: true,
  });
  await box.fill(term);
  await box.press("Enter");
  await expectSearchFor(page, term);
}

test.describe("search history", () => {
  test("Back to a page-box search after a header search shows that search, and Forward returns", async ({
    page,
  }) => {
    await visit(page, "/search");
    await expect(
      page.getByText("Enter a term above to search the listed papers."),
    ).toBeVisible();

    await searchFromPageBox(page, PAGE_BOX_TERM);
    await searchFromHeader(page, HEADER_TERM);

    // Back: the URL is the page-box search. The router hands down the empty
    // search the page was first loaded with; the URL must win.
    await page.goBack();
    await expectSearchFor(page, PAGE_BOX_TERM);

    // Forward: the header search comes back the same way.
    await page.goForward();
    await expectSearchFor(page, HEADER_TERM);
  });

  test("after a full load with a query, Back shows the page-box search rather than the first load's", async ({
    page,
  }) => {
    await visit(page, `/search?q=${encodeURIComponent(START_TERM)}`);
    await expectSearchFor(page, START_TERM);

    await searchFromPageBox(page, PAGE_BOX_TERM);
    await searchFromHeader(page, HEADER_TERM);

    // Back: the URL is the page-box search, not the query the page was first
    // loaded with (the reported variant: it showed START_TERM).
    await page.goBack();
    await expectSearchFor(page, PAGE_BOX_TERM);

    await page.goForward();
    await expectSearchFor(page, HEADER_TERM);

    // Two more Backs reach the original full load, still describing its URL.
    await page.goBack();
    await page.goBack();
    await expectSearchFor(page, START_TERM);
  });
});
