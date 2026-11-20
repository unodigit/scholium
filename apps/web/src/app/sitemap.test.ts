// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sitemap, {
  SITEMAP_PAPER_LIMIT,
  loadSitemapPapers,
  parseSitemapPaperPage,
} from "./sitemap";

/**
 * `/sitemap.xml` is the list of URLs a crawler may read. These tests pin the
 * three parts of it: the static and category entries that never depend on the
 * API, the papers it adds (and the ones it must never add), and the fallback
 * that keeps the static entries when the catalog is down.
 */

const SITE = "https://scholium.test";

const STATIC_URLS = [
  `${SITE}/`,
  `${SITE}/papers`,
  `${SITE}/search`,
  `${SITE}/verify`,
  `${SITE}/network`,
  `${SITE}/policies`,
  `${SITE}/c/cs.AI`,
  `${SITE}/c/cs.LG`,
  `${SITE}/c/cs.MA`,
];

/** One `GET /v1/papers` item, shaped like the catalog's wire format. */
function wireItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper: "sch:k3f9-q2xz-7mwd",
    shortId: "sch:k3f9-q2xz-7mwd",
    paperCid: "bafy-paper-1",
    versionCid: "bafy-version-2",
    n: 2,
    version: 2,
    title: "Can a Meta-Agent Choose the Safer Branch?",
    abstract: "An evaluation framework.",
    authors: [],
    categories: ["cs.AI"],
    licence: "CC-BY-4.0",
    status: "preprint",
    listedAt: "2026-01-01T00:00:00",
    updatedAt: "2026-02-01T00:00:00",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

/** A fetch whose answer depends on the cursor in the request URL. */
function stubPages(pages: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor") ?? "first";
    const page = pages[cursor] ?? { items: [], nextCursor: null };
    return jsonResponse(page);
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("SCHOLIUM_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const urls = (entries: Awaited<ReturnType<typeof sitemap>>): string[] =>
  entries.map((entry) => entry.url);

describe("the sitemap's static entries", () => {
  it("lists the site pages and one entry per category, as absolute URLs", async () => {
    stubPages({ first: { items: [], nextCursor: null } });

    expect(urls(await sitemap())).toEqual(STATIC_URLS);
  });

  it("still lists them when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    expect(urls(await sitemap())).toEqual(STATIC_URLS);
  });

  it("still lists them when the API refuses the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { status: 500, title: "Internal Server Error", detail: "catalog down" },
          500,
          "application/problem+json",
        ),
      ),
    );

    expect(urls(await sitemap())).toEqual(STATIC_URLS);
  });

  it("still lists them when the API answers a body that is not a list", async () => {
    stubPages({ first: { nothing: true } });

    expect(urls(await sitemap())).toEqual(STATIC_URLS);
  });
});

describe("the sitemap's paper entries", () => {
  it("adds each listed paper at /p/{id}", async () => {
    stubPages({
      first: { items: [wireItem()], nextCursor: null },
    });

    expect(urls(await sitemap())).toEqual([...STATIC_URLS, `${SITE}/p/k3f9-q2xz-7mwd`]);
  });

  it("dates a paper by its newest listed version", async () => {
    stubPages({
      first: {
        items: [
          wireItem({
            listedAt: "2026-01-01T00:00:00",
            updatedAt: "2026-02-01T00:00:00",
          }),
        ],
        nextCursor: null,
      },
    });

    const paper = (await sitemap()).at(-1);

    expect(paper?.lastModified).toEqual(new Date("2026-02-01T00:00:00"));
  });

  it("leaves lastModified off when the API names no timestamp", async () => {
    stubPages({
      first: {
        items: [wireItem({ listedAt: undefined, updatedAt: undefined })],
        nextCursor: null,
      },
    });

    const paper = (await sitemap()).at(-1);

    expect(paper?.url).toBe(`${SITE}/p/k3f9-q2xz-7mwd`);
    expect(paper && "lastModified" in paper).toBe(false);
  });

  it("never lists an unlisted, held or tombstoned paper", async () => {
    stubPages({
      first: {
        items: [
          wireItem({ shortId: "sch:public-one" }),
          wireItem({ shortId: "sch:unlisted-one", status: "unlisted" }),
          wireItem({ shortId: "sch:held-one", status: "held" }),
          wireItem({ shortId: "sch:tombstoned-one", status: "tombstoned" }),
          wireItem({ shortId: "sch:flag-unlisted", unlisted: true }),
          wireItem({ shortId: "sch:flag-held", held: true }),
          wireItem({ shortId: "sch:flag-tombstoned", tombstoned: true }),
        ],
        nextCursor: null,
      },
    });

    const listed = urls(await sitemap()).filter((url) => url.includes("/p/"));

    expect(listed).toEqual([`${SITE}/p/public-one`]);
  });

  it("keeps a retracted or contested paper, which is still publicly listed", async () => {
    stubPages({
      first: {
        items: [
          wireItem({ shortId: "sch:retracted-one", status: "retracted" }),
          wireItem({ shortId: "sch:contested-one", status: "contested" }),
        ],
        nextCursor: null,
      },
    });

    const listed = urls(await sitemap()).filter((url) => url.includes("/p/"));

    expect(listed).toEqual([`${SITE}/p/retracted-one`, `${SITE}/p/contested-one`]);
  });

  it("follows the catalog's cursor to the next page", async () => {
    const fetchStub = stubPages({
      first: { items: [wireItem({ shortId: "sch:first-paper" })], nextCursor: "next-page" },
      "next-page": { items: [wireItem({ shortId: "sch:second-paper" })], nextCursor: null },
    });

    const listed = urls(await sitemap()).filter((url) => url.includes("/p/"));

    expect(listed).toEqual([`${SITE}/p/first-paper`, `${SITE}/p/second-paper`]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const second = new URL(String(fetchStub.mock.calls[1][0]));
    expect(second.searchParams.get("cursor")).toBe("next-page");
  });

  it("asks for the newest listed papers a full page at a time", async () => {
    const fetchStub = stubPages({ first: { items: [], nextCursor: null } });

    await sitemap();

    const request = new URL(String(fetchStub.mock.calls[0][0]));
    expect(request.pathname).toBe("/v1/papers");
    expect(request.searchParams.get("tab")).toBe("latest");
    expect(request.searchParams.get("sort")).toBe("newest");
    expect(request.searchParams.get("limit")).toBe("100");
  });

  it(`stops at ${SITEMAP_PAPER_LIMIT.toLocaleString("en")} papers`, async () => {
    let counter = 0;
    const fetchStub = vi.fn(async () => {
      const items = Array.from({ length: 100 }, () =>
        wireItem({ shortId: `sch:paper-${counter++}` }),
      );
      return jsonResponse({ items, nextCursor: `cursor-${counter}` });
    });
    vi.stubGlobal("fetch", fetchStub);

    const entries = await sitemap();
    const listed = entries.filter((entry) => entry.url.includes("/p/"));

    expect(listed).toHaveLength(SITEMAP_PAPER_LIMIT);
    expect(fetchStub).toHaveBeenCalledTimes(SITEMAP_PAPER_LIMIT / 100);
  });

  it("does not repeat a paper the catalog lists twice", async () => {
    stubPages({
      first: { items: [wireItem({ shortId: "sch:same-paper" })], nextCursor: "next" },
      next: { items: [wireItem({ shortId: "sch:same-paper" })], nextCursor: null },
    });

    const listed = urls(await sitemap()).filter((url) => url.includes("/p/"));

    expect(listed).toEqual([`${SITE}/p/same-paper`]);
  });
});

describe("parseSitemapPaperPage", () => {
  it("drops rows without an id", () => {
    const page = parseSitemapPaperPage({
      items: [{ title: "No id" }, wireItem()],
      nextCursor: null,
    });

    expect(page.papers).toEqual([
      { path: "/p/k3f9-q2xz-7mwd", lastModified: new Date("2026-02-01T00:00:00") },
    ]);
  });

  it("rejects a body that is not a list", () => {
    expect(() => parseSitemapPaperPage(null)).toThrow();
    expect(() => parseSitemapPaperPage({})).toThrow();
    expect(() => parseSitemapPaperPage({ items: "none" })).toThrow();
  });
});

describe("loadSitemapPapers", () => {
  it("walks the cursor and returns what it read", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [wireItem({ shortId: "sch:a" })], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [wireItem({ shortId: "sch:b" })], nextCursor: null });

    const papers = await loadSitemapPapers({ get } as never);

    expect(papers.map((paper) => paper.path)).toEqual(["/p/a", "/p/b"]);
    expect(get).toHaveBeenNthCalledWith(1, "/papers", {
      query: { tab: "latest", sort: "newest", limit: 100 },
      cache: "no-store",
    });
    expect(get).toHaveBeenNthCalledWith(2, "/papers", {
      query: { tab: "latest", sort: "newest", limit: 100, cursor: "c1" },
      cache: "no-store",
    });
  });
});
