// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AiPage, { generateMetadata } from "../../app/(paper-ai)/ai/[...ref]/page";
import { ADVISORY_BANNER } from "./ai-report";

/**
 * `/ai/{id}[/v{n}]` is a server component that only reads the URL; the
 * report itself is fetched by the tab in the reader's browser. The first HTML
 * therefore carries the advisory banner — the label qualifies everything the
 * page will show — but never a finding: nothing is claimed before the API
 * has answered.
 */

const PAPER = "6sel-2dio-orm6"; // a real id from the shared vectors

const render = async (ref: string[]) =>
  renderToStaticMarkup(await AiPage({ params: Promise.resolve({ ref }) }));

describe("/ai route (server render)", () => {
  it("renders the page header and the advisory banner, still loading", async () => {
    const html = await render([PAPER, "v2"]);

    expect(html).toContain("scholium / ai / sch:6sel-2dio-orm6/v2");
    expect(html).toContain("<h1");
    expect(html).toContain("AI pre-review");
    expect(html).toContain(ADVISORY_BANNER);
    expect(html).toContain("Loading the AI pre-review…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("never decides anything about the paper");
  });

  it("never claims a finding before the browser has fetched the report", async () => {
    const html = await render([PAPER, "v2"]);

    expect(html).not.toContain("ai-finding");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("Rebut");
  });

  it("accepts a paper id with no version", async () => {
    const html = await render([PAPER]);
    expect(html).toContain("sch:6sel-2dio-orm6<");
    expect(html).toContain(ADVISORY_BANNER);
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
    expect(html).toContain("scholium / ai<");
  });

  it("shows a notice for a path with too many parts", async () => {
    const html = await render([PAPER, "v2", "extra"]);
    expect(html).toContain("That is not a paper id");
    expect(html).toContain("Expected a paper id");
  });

  it("titles the page with the paper being advised", async () => {
    const good = await generateMetadata({ params: Promise.resolve({ ref: [PAPER, "v2"] }) });
    expect(good.title).toBe("AI pre-review of sch:6sel-2dio-orm6/v2 · Scholium");
    expect(good.description).toMatch(/not a peer review/i);

    const bad = await generateMetadata({ params: Promise.resolve({ ref: ["nope"] }) });
    expect(bad.title).toBe("AI pre-review · Scholium");
  });
});
