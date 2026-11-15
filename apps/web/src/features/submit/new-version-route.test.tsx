// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import NewVersionRoute, { metadata } from "../../app/(submit)/submit/new-version/[ref]/page";
import { NewVersionLink } from "./new-version-link";

/**
 * `/submit/new-version/[ref]` is a server component that only reads the URL.
 * Loading the paper, the passkey prompt and signing all happen in the author's
 * browser, so the first HTML can only say it is loading — never a form it has
 * not checked, and never a sign button.
 */

const REF = "sch%3Aabcd-efgh-ijkl";

const render = async (ref: string) =>
  renderToStaticMarkup(await NewVersionRoute({ params: Promise.resolve({ ref }) }));

describe("/submit/new-version/[ref] route (server render)", () => {
  it("renders the page header, still loading the paper", async () => {
    const html = await render(REF);
    expect(html).toContain("<h1");
    expect(html).toContain("Submit a new version");
    expect(html).toContain("scholium / submit / new version / sch:abcd-efgh-ijkl");
    expect(html).toContain("Loading the paper…");
    expect(html).toContain('aria-busy="true"');
  });

  it("never offers to sign before the browser has loaded and checked the paper", async () => {
    const html = await render(REF);
    expect(html).not.toContain("Sign and submit");
    expect(html).not.toContain("Change note");
  });

  it("says a link that cannot name a paper is not one, instead of loading", async () => {
    const html = await render("not%20a%20paper");
    expect(html).toContain("does not name a paper");
    expect(html).not.toContain("Loading the paper");
  });

  it("names the page for the tab, and describes it for a share", () => {
    expect(metadata.title).toBe("Submit a new version · Scholium");
    expect(metadata.description).toContain("change note");
  });
});

describe("NewVersionLink (the paper page's way in)", () => {
  it("renders server-side as a plain link to the form, with the paper id encoded", () => {
    // The paper page is a server component, so the link must render to static
    // markup — this is exactly what the paper page's edit puts on it.
    const html = renderToStaticMarkup(<NewVersionLink paper="sch:abcd-efgh-ijkl" />);
    expect(html).toContain(">Submit a new version</a>");
    expect(html).toContain('href="/submit/new-version/sch%3Aabcd-efgh-ijkl"');
  });

  it("carries an override label for layouts that need a shorter one", () => {
    const html = renderToStaticMarkup(<NewVersionLink paper="sch:abcd-efgh-ijkl" label="New version" />);
    expect(html).toContain(">New version</a>");
  });
});
