// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ProofPage, {
  generateMetadata,
} from "../../app/(paper-proof)/proof/[...ref]/page";

/**
 * `/proof/{id}[/v{n}]` is a server component that only reads the URL. The
 * verification runs in the browser, so the first HTML response must never say
 * a paper is verified: it can only say it is checking.
 */

const PAPER = "6sel-2dio-orm6"; // a real id from the shared vectors

const render = async (ref: string[]) =>
  renderToStaticMarkup(await ProofPage({ params: Promise.resolve({ ref }) }));

describe("/proof route (server render)", () => {
  it("renders the page header and the tab, still checking", async () => {
    const html = await render([PAPER, "v2"]);

    expect(html).toContain("scholium / proof / sch:6sel-2dio-orm6/v2");
    expect(html).toContain("<h1");
    expect(html).toContain("This check runs in your browser");
    expect(html).toContain("Checking in your browser…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Re-run check");
  });

  it("never claims a verdict before the browser has checked", async () => {
    const html = await render([PAPER, "v2"]);

    expect(html).not.toContain("Verified");
    expect(html).not.toContain("Verification failed");
    expect(html).not.toContain("Could not check");
    expect(html).not.toContain("pt-checklist");
  });

  it("accepts a paper id with no version", async () => {
    const html = await render([PAPER]);
    expect(html).toContain("scholium / proof / sch:6sel-2dio-orm6<");
    expect(html).toContain("Checking in your browser…");
  });

  it("accepts the sch: prefix, plain or percent-encoded", async () => {
    expect(await render(["sch%3A6sel-2dio-orm6", "v1"])).toContain("sch:6sel-2dio-orm6/v1");
    expect(await render(["sch:6sel-2dio-orm6"])).toContain("sch:6sel-2dio-orm6");
  });

  it("shows a notice, not an error page, for an id with a bad checksum", async () => {
    const html = await render(["6sel-2dio-orm7"]);

    expect(html).toContain("That is not a paper id");
    expect(html).toContain("bad checksum");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Checking");
    expect(html).toContain("scholium / proof<");
  });

  it("shows a notice for a path with too many parts", async () => {
    const html = await render([PAPER, "v2", "extra"]);
    expect(html).toContain("That is not a paper id");
    expect(html).toContain("Expected a paper id");
  });

  it("titles the page with the version being checked", async () => {
    const good = await generateMetadata({ params: Promise.resolve({ ref: [PAPER, "v2"] }) });
    expect(good.title).toBe("Proof of sch:6sel-2dio-orm6/v2 · Scholium");
    expect(good.description).toMatch(/signed by all its authors/);

    const bad = await generateMetadata({ params: Promise.resolve({ ref: ["nope"] }) });
    expect(bad.title).toBe("Proof · Scholium");
  });
});
