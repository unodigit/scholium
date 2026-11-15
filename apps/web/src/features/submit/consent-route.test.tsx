// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ConsentRoute, { metadata } from "../../app/(submit)/consent/[version]/page";

/**
 * `/consent/[version]` is a server component that only reads the URL. Loading
 * the version, the passkey prompt and signing all happen in the author's
 * browser, so the first HTML can only say it is loading: never a version it
 * has not checked, and never a decision button.
 */

const VERSION = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";

const render = async (version: string) =>
  renderToStaticMarkup(await ConsentRoute({ params: Promise.resolve({ version }) }));

describe("/consent/[version] route (server render)", () => {
  it("renders the page header, still loading the version", async () => {
    const html = await render(VERSION);
    expect(html).toContain("<h1");
    expect(html).toContain("Review and sign");
    expect(html).toContain("scholium / consent / bafyreiversi…wlkm");
    expect(html).toContain("Loading the version…");
    expect(html).toContain('aria-busy="true"');
  });

  it("never offers a decision before the browser has loaded and checked the version", async () => {
    const html = await render(VERSION);
    expect(html).not.toContain("Accept authorship");
    expect(html).not.toContain("Decline authorship");
    expect(html).not.toContain("Your decision");
  });

  it("says a link that cannot name a version is not one, instead of loading", async () => {
    const html = await render("not%20a%20version");
    expect(html).toContain("not a paper version");
    expect(html).not.toContain("Loading the version");
  });

  it("is a personal invitation, so it asks search engines to leave it out", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Review and sign · Scholium");
  });
});
