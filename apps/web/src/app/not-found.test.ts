import { describe, expect, it } from "vitest";

import { metadata } from "./not-found";

/**
 * Bug: `/nope` was titled just "Scholium", because the root not-found page
 * carried no title of its own and fell back to the layout's default. The
 * layout's template adds " · Scholium".
 */
describe("the root not-found page's title", () => {
  it("is 'Not found', so the tab reads 'Not found · Scholium'", () => {
    expect(metadata.title).toBe("Not found");
  });
});
