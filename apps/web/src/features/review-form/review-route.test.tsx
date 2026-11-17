// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReviewRoutePage, {
  dynamic,
  generateMetadata,
} from "../../app/(review-form)/review/[id]/page";

/**
 * `/review/[id]` is a server component: the first HTML response must already
 * hold the paper and the whole form, so the page is usable before any
 * JavaScript runs, and a reviewer is never shown a form for a paper that
 * failed to load.
 */

const ID = "sch:6sel-2dio-orm6"; // a real id from the shared vectors

const HEAD = {
  paper: ID,
  shortId: ID,
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "We study how a meta-agent picks between branches.",
  categories: ["cs.AI"],
};

const TEXT = {
  paper: ID,
  version: 2,
  count: 2,
  paragraphs: [
    { paragraph_id: "p1", paragraphId: "p1", position: 0, text: "Multi-agent systems increasingly delegate choices." },
    { paragraph_id: "p2", paragraphId: "p2", position: 1, text: "We define a safety score for each branch." },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": status === 200 ? "application/json" : "application/problem+json",
    },
  });
}

/** Answer the two reads the page makes; either can be overridden. */
function stubApi(
  overrides: { head?: () => Response; text?: () => Response } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/text")) return (overrides.text ?? (() => json(TEXT)))();
    return (overrides.head ?? (() => json(HEAD)))();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const render = async (id: string) =>
  renderToStaticMarkup(await ReviewRoutePage({ params: Promise.resolve({ id }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/review route (server render)", () => {
  it("renders the paper on the left, with its text, in the first HTML", async () => {
    stubApi();

    const html = await render(ID);

    expect(html).toContain("Reviewing: Can a Meta-Agent Choose the Safer Branch? · v2");
    expect(html).toContain("We study how a meta-agent picks between branches.");
    expect(html).toContain("Multi-agent systems increasingly delegate choices.");
    expect(html).toContain('data-paragraph-id="p2"');
    expect(html.indexOf("rf-paper")).toBeLessThan(html.indexOf("rf-side"));
  });

  it("renders the whole rubric form on the right", async () => {
    stubApi();

    const html = await render(ID);

    for (const label of [
      "Soundness of method",
      "Evidence for claims",
      "Reproducibility",
      "Novelty",
      "Clarity",
      "Limitations &amp; ethics",
    ]) {
      expect(html).toContain(label);
    }
    expect(html.match(/type="radio"/g)).toHaveLength(6 * 5 + 3 + 4);
    // Six required justifications, plus the optional written report.
    expect(html.match(/<textarea/g)).toHaveLength(7);
    expect(html.match(/<textarea[^>]*required/g)).toHaveLength(6);
    expect(html).toContain("Written report");
    expect(html).toContain("Confidence");
    expect(html).toContain("Recommendation");
    expect(html).toContain("I used AI assistance in writing this review");
    // Nothing is pre-chosen for the reviewer.
    expect(html).not.toMatch(/checked=""/);
  });

  it("renders the anonymity notice", async () => {
    stubApi();

    const html = await render(ID);

    expect(html).toContain("You are reviewing anonymously.");
    expect(html).toContain("hidden from authors, readers and this node");
    expect(html).toContain("3 of 5 integrity committee members");
  });

  it("renders Sign with my name instead and the stylometry tip, anonymous to begin with", async () => {
    stubApi();

    const html = await render(ID);

    expect(html).toContain("Sign with my name instead");
    expect(html).toContain("Tip: avoid phrases that identify you or your lab.");
    // Nothing is signed until the reviewer chooses: no signed notice, no way back.
    expect(html).not.toContain("You are signing this review with your name.");
    expect(html).not.toContain("Stay anonymous instead");
  });

  it("names every paragraph, and the abstract, as a citation will", async () => {
    stubApi();

    const html = await render(ID);

    expect(html).toContain('data-cite="abstract"');
    expect(html).toContain("data-cite=\"¶ 1 · p1\"");
    expect(html).toContain("data-cite=\"¶ 2 · p2\"");
    // The button itself appears only once words are selected.
    expect(html).not.toContain("Cite in review");
  });

  it("reads the public API, for the newest version's text, without the account", async () => {
    const fetchMock = stubApi();

    await render(ID);

    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/\/v1\/papers\/sch%3A6sel-2dio-orm6$/);
    expect(calls[1]).toMatch(/\/v1\/papers\/sch%3A6sel-2dio-orm6\/v\/2\/text$/);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect((init as RequestInit | undefined)?.cache).toBe("no-store");
    }
  });

  it("accepts the id with no prefix, or with the prefix percent-encoded", async () => {
    stubApi();

    expect(await render("6sel-2dio-orm6")).toContain("Reviewing: Can a Meta-Agent");
    expect(await render("sch%3A6sel-2dio-orm6")).toContain("Reviewing: Can a Meta-Agent");
  });

  it("is rendered fresh on every request", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("/review route failures", () => {
  it("shows a notice, not a form, for an id with a bad checksum, and calls no API", async () => {
    const fetchMock = stubApi();

    const html = await render("6sel-2dio-orm7");

    expect(html).toContain("That is not a paper id");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Try again");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a notice, not a form, for a paper the node does not list", async () => {
    const fetchMock = stubApi({
      head: () => json({ title: "Not Found", status: 404, detail: "No paper." }, 404),
    });

    const html = await render(ID);

    expect(html).toContain("No such paper");
    expect(html).toContain("no listed paper");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Try again");
    // With no paper there is no version to ask for text of.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable notice, not a form, when the API cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

    const html = await render(ID);

    expect(html).toContain("Couldn’t load the paper");
    expect(html).toContain("could not reach the API");
    expect(html).toContain('href="/review/sch%3A6sel-2dio-orm6"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("<form");
  });

  it("shows a notice when the API returns something that is not a paper", async () => {
    stubApi({ head: () => json({ items: [] }) });

    const html = await render(ID);

    expect(html).toContain("The API did not return a paper.");
    expect(html).not.toContain("<form");
  });

  it("still shows the paper's abstract and the form when only the text is missing", async () => {
    stubApi({ text: () => json({ title: "Not Found", status: 404 }, 404) });

    const html = await render(ID);

    expect(html).toContain("We study how a meta-agent picks between branches.");
    expect(html).toContain("full text of this version could not be loaded");
    expect(html).toContain("<form");
    expect(html).toContain("You are reviewing anonymously.");
  });
});

describe("/review metadata", () => {
  it("titles the tab with the paper id", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "6sel-2dio-orm6" }) });
    expect(metadata.title).toBe("Review sch:6sel-2dio-orm6 · Scholium");
  });

  it("falls back to a plain title for a bad id instead of throwing", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "nonsense" }) });
    expect(metadata.title).toBe("Review · Scholium");
  });

  it("keeps a reviewer's workspace out of search engines", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: "6sel-2dio-orm6" }) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
