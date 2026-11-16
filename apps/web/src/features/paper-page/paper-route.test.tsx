// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import PaperPage, {
  dynamic,
  generateMetadata,
} from "../../app/(paper-page)/p/[id]/page";
import PaperVersionPage, {
  dynamic as versionDynamic,
  generateMetadata as versionMetadata,
} from "../../app/(paper-page)/p/[id]/[version]/page";
import {
  ALICE,
  BARE_ID,
  HAPPY,
  MANIFEST_BODY,
  PAPER_BODY,
  SHORT_ID,
  TEXT_BODY,
  decisionEntry,
  json,
  notFound,
  stubApi,
  versionEntry,
  type Routes,
} from "./paper-page-fixtures";

/**
 * `/p/{id}` and `/p/{id}/v{n}` are server-rendered: the first HTML response
 * must already carry the title, the authors, the status, "v2 of 2", the
 * licence, the four actions, the abstract and text, and the margin panel's tabs
 * with the Reviews tab's content, so the page reads before any JavaScript runs.
 * These tests render the real route files against a stubbed node.
 */

const NODE = "http://localhost:8000";

/** Server-render an element and put its HTML in the document to query it. */
function mount(element: ReactElement): void {
  document.body.innerHTML = renderToStaticMarkup(element);
}

const page = async (id: string) => PaperPage({ params: Promise.resolve({ id }) });
const versionPage = async (id: string, version: string) =>
  PaperVersionPage({ params: Promise.resolve({ id, version }) });

/** The paper answers for the version in the URL, as the node does. */
const byVersion: Routes["paper"] = (path) => {
  const n = Number(/\/v(\d+)$/.exec(path)?.[1] ?? 2);
  return json({ ...PAPER_BODY, n, version: n });
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the route files", () => {
  it("read live data for an id taken from the URL, so nothing is prerendered", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(versionDynamic).toBe("force-dynamic");
  });
});

describe("/p/{id}: the header", () => {
  it("shows the title as the page's one h1", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe("Can a Meta-Agent Choose the Safer Branch?");
  });

  it("lists the authors by the names in their profiles, in byline order", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const authors = screen.getByRole("region", { name: "Authors" });
    const names = within(authors)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(names).toEqual(["Mei Zhang", "A. Okafor"]);
  });

  it("falls back to the DID for an author with no public profile", async () => {
    stubApi({ ...HAPPY, profile: () => notFound() });
    mount(await page(BARE_ID));

    const authors = screen.getByRole("region", { name: "Authors" });
    expect(within(authors).getAllByRole("listitem")[0].textContent).toBe(
      "did:key:z6MkhaXgBZ…2doK",
    );
    // The whole DID is still there, in the title, so nothing is hidden.
    expect(within(authors).getAllByRole("listitem")[0].getAttribute("title")).toContain(ALICE);
  });

  it("shows the status as a chip with its word, with the reviewer count only where it belongs", async () => {
    stubApi();
    mount(await page(BARE_ID));
    expect(screen.getByText("Reviewed")).toBeTruthy();
    cleanup();

    stubApi({ ...HAPPY, paper: () => json({ ...PAPER_BODY, status: "under_review" }) });
    mount(await page(BARE_ID));
    // Three reviews have been committed.
    expect(screen.getByText("Under review (3)")).toBeTruthy();
  });

  it("says which version it is, of how many", async () => {
    stubApi();
    mount(await page(BARE_ID));
    expect(screen.getByText("v2 of 2")).toBeTruthy();
  });

  it("says just the version when the timeline could not be read", async () => {
    stubApi({ ...HAPPY, versions: () => json({ title: "Boom", status: 500 }, 500) });
    mount(await page(BARE_ID));

    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.queryByText(/of 2/)).toBeNull();
  });

  it("states the licence in words", async () => {
    stubApi();
    mount(await page(BARE_ID));
    expect(screen.getByText("CC BY 4.0")).toBeTruthy();
  });

  it("links back to the paper's first category", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const back = screen.getByRole("link", { name: /cs\.AI/ });
    expect(back.getAttribute("href")).toBe("/c/cs.AI");
  });
});

describe("/p/{id}: the four actions", () => {
  it("offers PDF, HTML, Cite and Download", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const actions = screen.getByRole("group", { name: "Read, cite and download" });
    const names = within(actions)
      .getAllByRole("link")
      .map((link) => link.textContent?.replace(/\s*\(.*\)$/, "").replace(/ as BibTeX.*$/, ""));
    expect(names).toEqual(["PDF", "HTML", "Cite", "Download"]);
  });

  it("leaves Invite reviewer out of the first HTML: it is for authors, and the server cannot know who is reading", async () => {
    stubApi();
    mount(await page(BARE_ID));

    expect(screen.queryByRole("button", { name: "Invite reviewer" })).toBeNull();
    expect(document.body.textContent).not.toContain("Invite reviewer");
  });

  it("opens the PDF from the node's content endpoint, in a new tab", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const pdf = screen.getByRole("link", { name: /^PDF/ });
    expect(pdf.getAttribute("href")).toBe(`${NODE}/v1/content/bafkrei-pdf`);
    expect(pdf.getAttribute("target")).toBe("_blank");
    expect(pdf.getAttribute("rel")).toContain("noopener");
  });

  it("marks HTML as the view on screen and points it at the reading column", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const html = screen.getByRole("link", { name: "HTML" });
    expect(html.getAttribute("href")).toBe("#reading");
    expect(html.getAttribute("aria-current")).toBe("true");
    expect(document.getElementById("reading")).not.toBeNull();
  });

  it("cites the exact version on screen", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const cite = screen.getByRole("link", { name: /^Cite/ });
    expect(cite.getAttribute("href")).toBe(
      `${NODE}/v1/papers/${encodeURIComponent(SHORT_ID)}/v2/cite?format=bibtex`,
    );
  });

  it("downloads the paper's archive", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(
      `${NODE}/v1/export/paper/${encodeURIComponent(SHORT_ID)}.car`,
    );
    expect(download.hasAttribute("download")).toBe(true);
  });

  it("does not offer a PDF that is not there, and says why", async () => {
    stubApi({
      ...HAPPY,
      manifest: () => json({ ...MANIFEST_BODY, files: [MANIFEST_BODY.files[1]] }),
    });
    mount(await page(BARE_ID));

    const pdf = screen.getByText("PDF");
    expect(pdf.getAttribute("aria-disabled")).toBe("true");
    expect(pdf.hasAttribute("href")).toBe(false);
    expect(screen.getByText("This version has no PDF.")).toBeTruthy();
    // The other three still work.
    expect(screen.getByRole("link", { name: "HTML" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Cite/ })).toBeTruthy();
  });

  it("does not offer a PDF that is still being scanned", async () => {
    stubApi({
      ...HAPPY,
      manifest: () =>
        json({
          ...MANIFEST_BODY,
          files: [{ ...MANIFEST_BODY.files[0], scanStatus: "scanning" }],
        }),
    });
    mount(await page(BARE_ID));

    expect(screen.getByText("PDF").hasAttribute("href")).toBe(false);
    expect(screen.getByText(/still being scanned/)).toBeTruthy();
  });
});

describe("/p/{id}: the reading column", () => {
  it("shows the abstract and then the text as paragraphs", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const reading = screen.getByRole("region", { name: "Paper text" });
    expect(within(reading).getByRole("heading", { name: "Abstract" })).toBeTruthy();
    expect(within(reading).getByText(/evaluation framework investigating/)).toBeTruthy();
    expect(within(reading).getByText(/Multi-agent systems increasingly/)).toBeTruthy();
    expect(within(reading).getByText(/Section 2 states the evaluation protocol/)).toBeTruthy();
  });

  it("keeps the abstract and says so when the text cannot be loaded", async () => {
    stubApi({ ...HAPPY, text: () => json({ title: "Boom", status: 500, detail: "The text store is down." }, 500) });
    mount(await page(BARE_ID));

    const reading = screen.getByRole("region", { name: "Paper text" });
    expect(within(reading).getByText(/evaluation framework investigating/)).toBeTruthy();
    expect(within(reading).getByRole("status").textContent).toBe("The text store is down.");
  });

  it("points at the PDF when the node has no text for the version", async () => {
    stubApi({ ...HAPPY, text: () => json({ ...{ paper: SHORT_ID, version: 2, paragraphs: [] } }) });
    mount(await page(BARE_ID));

    expect(screen.getByText(/not available to read here\. Open the PDF/)).toBeTruthy();
  });

  it("says when a version has no abstract", async () => {
    stubApi({ ...HAPPY, paper: () => json({ ...PAPER_BODY, abstract: "" }) });
    mount(await page(BARE_ID));

    expect(screen.getByText("This version has no abstract.")).toBeTruthy();
  });

  it("sends a formula as the LaTeX the author wrote: typesetting happens once the page runs", async () => {
    stubApi({
      ...HAPPY,
      text: () =>
        json({
          ...TEXT_BODY,
          paragraphs: [
            {
              paragraph_id: "para-math",
              position: 0,
              text: "The score is $s = \\sum_i w_i x_i$ for each branch.",
            },
          ],
        }),
    });
    mount(await page(BARE_ID));

    const paragraph = document.getElementById("p-para-math");
    expect(paragraph?.textContent).toBe(
      "The score is $s = \\sum_i w_i x_i$ for each branch.",
    );
    // KaTeX is loaded in the browser, not on the server: no typeset markup yet.
    expect(document.querySelector(".katex")).toBeNull();
  });

  it("starts on the text, with no PDF viewer in the page", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const reading = screen.getByRole("region", { name: "Paper text" });
    expect(within(reading).getByText(/Multi-agent systems increasingly/)).toBeTruthy();
    expect(reading.querySelector("[hidden]")).toBeNull();
    expect(screen.queryByRole("region", { name: "PDF of this version", hidden: true })).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("still shows the text of a version that has no PDF", async () => {
    stubApi({
      ...HAPPY,
      manifest: () => json({ ...MANIFEST_BODY, files: [MANIFEST_BODY.files[1]] }),
    });
    mount(await page(BARE_ID));

    const reading = screen.getByRole("region", { name: "Paper text" });
    expect(within(reading).getByText(/Multi-agent systems increasingly/)).toBeTruthy();
    expect(reading.querySelector("[hidden]")).toBeNull();
  });
});

describe("/p/{id}: the margin panel", () => {
  it("has the six tabs, in order, with Reviews open", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Reviews (3)",
      "AI",
      "Discussion (8)",
      "Versions",
      "Files",
      "Proof",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("carries the reviews in the first HTML, so they read without JavaScript", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Reviewer A")).toBeTruthy();
    expect(within(panel).getByText("Reviewer B")).toBeTruthy();
  });

  it("is an aside beside the paper, not part of it", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const margin = screen.getByRole("complementary", { name: "Margin of the paper" });
    expect(margin.contains(screen.getByRole("tablist"))).toBe(true);
    expect(margin.contains(screen.getByRole("heading", { level: 1 }))).toBe(false);
  });

  it("leaves the panel in the flow in the first HTML: nothing collapses before the page runs", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const margin = screen.getByRole("complementary", { name: "Margin of the paper" });
    // The drawer and the bottom sheet (docs/design.md §10) need JavaScript: no
    // toggle is sent, and the styles that put the panel away are not switched on.
    expect(within(margin).queryByRole("button", { name: "Margin" })).toBeNull();
    expect(margin.hasAttribute("data-enhanced")).toBe(false);
    expect(within(margin).getAllByRole("tab")).toHaveLength(6);
  });

  it("never claims a verdict before the browser has checked", async () => {
    stubApi();
    mount(await page(BARE_ID));

    const badge = document.querySelector(".sch-verify");
    expect(badge?.textContent).toContain("Checking");
    expect(document.body.textContent).not.toContain("Verified");
    expect(document.body.textContent).not.toContain("Verification failed");
  });

  it("shows the version's id and when it was anchored", async () => {
    stubApi();
    mount(await page(BARE_ID));

    expect(screen.getByRole("button", { name: new RegExp(`${SHORT_ID}/v2`) })).toBeTruthy();
    expect(screen.getByText(/^Anchored 2 Mar 2027/)).toBeTruthy();
  });

  it("reads each tab's data on the server, so tabs open with content", async () => {
    const fetchMock = stubApi();
    mount(await page(BARE_ID));

    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    for (const suffix of ["/reviews", "/threads", "/versions", "/v/2/manifest", "/v/2/text"]) {
      expect(paths.some((path) => path.endsWith(suffix))).toBe(true);
    }
  });
});

describe("/p/{id}/v{n}", () => {
  it("shows the version in the address", async () => {
    stubApi({ ...HAPPY, paper: byVersion });
    mount(await versionPage(BARE_ID, "v1"));

    expect(screen.getByText("v1 of 2")).toBeTruthy();
    // Every part follows the version, not the newest one.
    expect(screen.getByRole("link", { name: /^Cite/ }).getAttribute("href")).toContain("/v1/cite");
    expect(screen.getByRole("button", { name: new RegExp(`${SHORT_ID}/v1`) })).toBeTruthy();
  });

  it("reads that version's files and text", async () => {
    const fetchMock = stubApi({ ...HAPPY, paper: byVersion });
    mount(await versionPage(BARE_ID, "v1"));

    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.some((path) => path.endsWith("/v/1/manifest"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/v/1/text"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/v/2/manifest"))).toBe(false);
  });

  it("accepts the sch: prefix, plain or percent-encoded", async () => {
    stubApi({ ...HAPPY, paper: byVersion });
    mount(await versionPage(encodeURIComponent(SHORT_ID), "v2"));
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    cleanup();

    mount(await versionPage(SHORT_ID, "v2"));
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("says the version is not listed when only the version is missing", async () => {
    stubApi({ ...HAPPY, paper: () => notFound() });
    mount(await versionPage(BARE_ID, "v9"));

    expect(screen.getByRole("alert").textContent).toContain(
      "This paper has no listed version 9 on this node.",
    );
  });

  it.each(["latest", "0", "v0", "2", "v-1"])("is not an address when the version is %s", async (version) => {
    const fetchMock = stubApi();
    mount(await versionPage(BARE_ID, version));

    expect(screen.getByRole("alert").textContent).toContain("That is not a paper address");
    // A bad address never reaches the API.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a paper that cannot be shown", () => {
  it("answers 404 for an unknown paper instead of rendering a not-found body with 200", async () => {
    stubApi({ ...HAPPY, paper: () => notFound() });

    // Next's `notFound()` throws its 404 control-flow error; the route must not
    // return a page element that the server would send with a 200.
    await expect(page(BARE_ID)).rejects.toThrow();
  });

  it("renders the removed-content state for a tombstoned paper", async () => {
    stubApi({
      ...HAPPY,
      paper: () => notFound(),
      records: () =>
        json([
          versionEntry(),
          decisionEntry("tombstone", 12, {
            clause: "MOD-05",
            reason: "Unlawful content.",
          }),
        ]),
    });
    mount(await page(BARE_ID));

    // design.md §8: "Content removed for legal reasons on {date}. The record
    // of its existence remains." — not a bare 404.
    expect(screen.getByText("Content removed for legal reasons")).toBeTruthy();
    expect(screen.getByText(/Removed on 5 March 2027/)).toBeTruthy();
    expect(screen.getByText(/The record of its existence remains/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Can a Meta-Agent Choose the Safer Branch?",
    );
    expect(
      screen.getByRole("link", { name: "Policy MOD-05" }).getAttribute("href"),
    ).toBe("/policies#MOD-05");
  });

  it("renders the removed-content state for one tombstoned version", async () => {
    stubApi({
      ...HAPPY,
      paper: () => notFound(),
      records: () =>
        json([versionEntry(), decisionEntry("tombstone", 12, { clause: "MOD-05" })]),
    });
    mount(await versionPage(BARE_ID, "v2"));

    expect(screen.getByText("Content removed for legal reasons")).toBeTruthy();
  });

  it("says a bad address is not an address, without asking the API", async () => {
    const fetchMock = stubApi();
    mount(await page("not an id!"));

    expect(screen.getByRole("alert").textContent).toContain("That is not a paper address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the node could not be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    mount(await page(BARE_ID));

    expect(screen.getByRole("alert").textContent).toContain("Couldn’t reach the API");
  });
});

describe("one part failing does not take the page down", () => {
  it("still shows the paper when reviews, discussion and files all fail", async () => {
    const boom = () => json({ title: "Boom", status: 500, detail: "The node is struggling." }, 500);
    stubApi({ ...HAPPY, reviews: boom, threads: boom, manifest: boom, versions: boom, text: boom });
    mount(await page(BARE_ID));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Can a Meta-Agent Choose the Safer Branch?",
    );
    expect(screen.getByRole("tablist")).toBeTruthy();
    // The Reviews tab says why, and offers a retry.
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("alert").textContent).toContain("The node is struggling.");
    expect(within(panel).getByRole("button", { name: /try again|retry/i })).toBeTruthy();
  });

  it("treats a paper with no reviews as the calm empty state", async () => {
    stubApi({ ...HAPPY, reviews: () => notFound() });
    mount(await page(BARE_ID));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(within(panel).getByText(/No reviews yet/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Reviews" })).toBeTruthy();
  });
});

describe("metadata", () => {
  it("titles the page with the paper and its version", async () => {
    stubApi();
    const meta = await generateMetadata({ params: Promise.resolve({ id: BARE_ID }) });

    expect(meta.title).toBe("Can a Meta-Agent Choose the Safer Branch? · v2 of 2 · Scholium");
    expect(meta.description).toMatch(/evaluation framework investigating/);
  });

  it("titles a version page with that version", async () => {
    stubApi({ ...HAPPY, paper: byVersion });
    const meta = await versionMetadata({
      params: Promise.resolve({ id: BARE_ID, version: "v1" }),
    });

    expect(meta.title).toBe("Can a Meta-Agent Choose the Safer Branch? · v1 of 2 · Scholium");
  });

  it("cuts a long abstract at a word", async () => {
    stubApi({ ...HAPPY, paper: () => json({ ...PAPER_BODY, abstract: "word ".repeat(100) }) });
    const meta = await generateMetadata({ params: Promise.resolve({ id: BARE_ID }) });

    expect(String(meta.description).length).toBeLessThanOrEqual(201);
    expect(String(meta.description).endsWith("word…")).toBe(true);
  });

  it("describes a paper with no abstract in general terms", async () => {
    stubApi({ ...HAPPY, paper: () => json({ ...PAPER_BODY, abstract: "" }) });
    const meta = await generateMetadata({ params: Promise.resolve({ id: BARE_ID }) });

    expect(meta.description).toMatch(/A paper on Scholium/);
  });

  it("does not let a page with no paper be indexed", async () => {
    stubApi({ ...HAPPY, paper: () => notFound() });
    const missing = await generateMetadata({ params: Promise.resolve({ id: BARE_ID }) });
    const bad = await generateMetadata({ params: Promise.resolve({ id: "not an id!" }) });

    for (const meta of [missing, bad]) {
      expect(meta.title).toBe("Paper unavailable · Scholium");
      expect(meta.robots).toEqual({ index: false });
    }
  });

  it("titles a tombstoned paper as removed, and keeps it out of indexes", async () => {
    stubApi({
      ...HAPPY,
      paper: () => notFound(),
      records: () =>
        json([versionEntry(), decisionEntry("tombstone", 12, { clause: "MOD-05" })]),
    });

    const meta = await generateMetadata({ params: Promise.resolve({ id: BARE_ID }) });

    expect(meta.title).toBe("Content removed · Scholium");
    expect(meta.robots).toEqual({ index: false });
  });
});
