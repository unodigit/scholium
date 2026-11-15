// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MeRoutePage, { metadata } from "../../app/(dashboard)/me/page";

/**
 * `/me` is a client-fetched screen: the bearer token lives only in the
 * browser, so the route renders the dashboard shell and lets the client load
 * the document after hydration. The first HTML must still name the page and
 * say what is happening, rather than rendering an empty body.
 */

describe("/me route", () => {
  it("renders the dashboard shell and a loading line", () => {
    const html = renderToStaticMarkup(<MeRoutePage />);

    expect(html).toContain("Me");
    expect(html).toContain("scholium / me");
    expect(html).toContain("Loading your dashboard");
  });

  it("names the page in its metadata", () => {
    expect(metadata.title).toBe("Me · Scholium");
    expect(metadata.description).toContain("needs your attention");
  });
});
