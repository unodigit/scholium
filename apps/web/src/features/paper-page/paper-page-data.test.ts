import { afterEach, describe, expect, it, vi } from "vitest";

import { apiErrorFrom } from "../../lib/api";
import { parseManifest, parseVersions } from "../paper-meta/meta";
import { parseReviews } from "../paper-reviews/review";
import { parseThreads } from "../paper-discussion/discussion";
import { parsePaper } from "../search-page/paper";
import { parseReadingText } from "./reading";
import {
  DEFAULT_LOADERS,
  describePageError,
  loadPaperPageData,
  type PaperPageLoaders,
} from "./paper-page-data";
import {
  HAPPY,
  MANIFEST_BODY,
  PAPER_BODY,
  REVIEWS_BODY,
  SHORT_ID,
  TEXT_BODY,
  THREADS_BODY,
  VERSIONS_BODY,
  VERSION_CID,
  stubApi,
} from "./paper-page-fixtures";

/**
 * The page's data is the paper plus five other reads. The paper decides
 * whether there is a page; each other read is a part that can fail on its own
 * without blanking the paper.
 */

const problem = (status: number) =>
  apiErrorFrom(status, { title: "Problem", status, detail: "The node said no." });

function loaders(overrides: Partial<PaperPageLoaders> = {}): PaperPageLoaders {
  return {
    paper: async () => parsePaper(PAPER_BODY),
    versions: async () => parseVersions(VERSIONS_BODY),
    manifest: async () => parseManifest(MANIFEST_BODY),
    reviews: async () => parseReviews(REVIEWS_BODY),
    discussion: async () => parseThreads(THREADS_BODY),
    reading: async () => parseReadingText(TEXT_BODY),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPaperPageData", () => {
  it("names the paper, the version on screen and the id the tabs are given", async () => {
    const data = await loadPaperPageData({ id: SHORT_ID, version: null }, loaders());

    expect(data.paper.title).toBe("Can a Meta-Agent Choose the Safer Branch?");
    expect(data.shortId).toBe(SHORT_ID);
    expect(data.version).toBe(2);
    expect(data.versionId).toBe(`${SHORT_ID}/v2`);
  });

  it("states the total number of versions from the timeline", async () => {
    const data = await loadPaperPageData({ id: SHORT_ID, version: null }, loaders());
    expect(data.totalVersions).toBe(2);
  });

  it("reads every part for the canonical id and the version the paper names", async () => {
    const calls: string[] = [];
    await loadPaperPageData(
      // The URL spelled the paper as a record id; the API names it.
      { id: "bafyrei-genesis", version: 2 },
      loaders({
        versions: async (id) => {
          calls.push(`versions ${id}`);
          return parseVersions(VERSIONS_BODY);
        },
        manifest: async (id, n) => {
          calls.push(`manifest ${id} v${n}`);
          return parseManifest(MANIFEST_BODY);
        },
        reviews: async (id) => {
          calls.push(`reviews ${id}`);
          return parseReviews(REVIEWS_BODY);
        },
        discussion: async (id) => {
          calls.push(`discussion ${id}`);
          return parseThreads(THREADS_BODY);
        },
        reading: async (id, n) => {
          calls.push(`reading ${id} v${n}`);
          return parseReadingText(TEXT_BODY);
        },
      }),
    );

    expect(calls.sort()).toEqual(
      [
        `discussion ${SHORT_ID}`,
        `manifest ${SHORT_ID} v2`,
        `reading ${SHORT_ID} v2`,
        `reviews ${SHORT_ID}`,
        `versions ${SHORT_ID}`,
      ].sort(),
    );
  });

  it("holds each part's data when every read works", async () => {
    const data = await loadPaperPageData({ id: SHORT_ID, version: null }, loaders());

    expect(data.versions.ok && data.versions.data.versions).toHaveLength(2);
    expect(data.manifest.ok && data.manifest.data.files).toHaveLength(2);
    expect(data.reviews.ok && data.reviews.data.count).toBe(3);
    expect(data.discussion.ok && data.discussion.data.threads).toHaveLength(3);
    expect(data.reading.ok && data.reading.data.paragraphs).toHaveLength(3);
    expect(data.paper.versionCid).toBe(VERSION_CID);
  });

  it("does not wait for the parts one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = <T,>(value: T) => async (): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    };

    await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders({
        versions: slow(parseVersions(VERSIONS_BODY)),
        manifest: slow(parseManifest(MANIFEST_BODY)),
        reviews: slow(parseReviews(REVIEWS_BODY)),
        discussion: slow(parseThreads(THREADS_BODY)),
        reading: slow(parseReadingText(TEXT_BODY)),
      }),
    );

    expect(peak).toBe(5);
  });

  it("rejects when the paper cannot be read: there is no page without it", async () => {
    await expect(
      loadPaperPageData(
        { id: SHORT_ID, version: null },
        loaders({
          paper: async () => {
            throw problem(404);
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("does not read the other parts for a paper that is not there", async () => {
    const versions = vi.fn();
    await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders({
        paper: async () => {
          throw problem(404);
        },
        versions,
      }),
    ).catch(() => undefined);
    expect(versions).not.toHaveBeenCalled();
  });
});

describe("a part that fails does not blank the paper", () => {
  it("keeps the paper and says why the versions are missing; the total is then unknown", async () => {
    const data = await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders({
        versions: async () => {
          throw problem(500);
        },
      }),
    );

    expect(data.paper.title).toBe("Can a Meta-Agent Choose the Safer Branch?");
    expect(data.versions.ok).toBe(false);
    expect(data.versions.ok === false && data.versions.error).toMatch(/\S/);
    expect(data.totalVersions).toBeNull();
    expect(data.reviews.ok).toBe(true);
  });

  it.each([
    ["manifest", { manifest: async () => { throw problem(500); } }],
    ["discussion", { discussion: async () => { throw problem(500); } }],
    ["reading", { reading: async () => { throw problem(500); } }],
  ] as const)("keeps the rest when the %s read fails", async (part, override) => {
    const data = await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders(override),
    );
    expect(data[part].ok).toBe(false);
    expect(data.paper.title).toMatch(/Meta-Agent/);
    expect(data.versions.ok).toBe(true);
  });

  it("treats a paper with no reviews (404) as the calm empty state, not a failure", async () => {
    const data = await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders({
        reviews: async () => {
          throw problem(404);
        },
      }),
    );

    expect(data.reviews).toMatchObject({ ok: true, data: { count: 0, reviews: [] } });
  });

  it("reports a failed reviews read as a failure, with the reader-facing sentence", async () => {
    const data = await loadPaperPageData(
      { id: SHORT_ID, version: null },
      loaders({
        reviews: async () => {
          throw problem(429);
        },
      }),
    );
    expect(data.reviews).toEqual({
      ok: false,
      error: "Too many requests just now. Wait a moment and try again.",
    });
  });
});

describe("through the real reads", () => {
  it("assembles the page from the node's public endpoints", async () => {
    const fetchMock = stubApi(HAPPY);

    const data = await loadPaperPageData({ id: SHORT_ID, version: null }, DEFAULT_LOADERS);

    expect(data.paper.authors.map((author) => author.name)).toEqual([
      "Mei Zhang",
      "A. Okafor",
    ]);
    expect(data.totalVersions).toBe(2);
    expect(data.reviews).toMatchObject({ ok: true, data: { count: 3 } });
    expect(data.reading.ok && data.reading.data.paragraphs[0].id).toBe("para-1");

    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toContain(`/v1/papers/${encodeURIComponent(SHORT_ID)}`);
    expect(paths).toContain(`/v1/papers/${encodeURIComponent(SHORT_ID)}/versions`);
    expect(paths).toContain(`/v1/papers/${encodeURIComponent(SHORT_ID)}/v/2/manifest`);
    expect(paths).toContain(`/v1/papers/${encodeURIComponent(SHORT_ID)}/v/2/text`);
  });

  it("asks for the version in the address", async () => {
    const fetchMock = stubApi(HAPPY);

    await loadPaperPageData({ id: SHORT_ID, version: 1 }, DEFAULT_LOADERS);

    const paths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toContain(`/v1/papers/${encodeURIComponent(SHORT_ID)}/v1`);
  });
});

describe("describePageError", () => {
  const address = { id: SHORT_ID, version: null };

  it("says a paper this node does not list is not listed", () => {
    expect(describePageError(problem(404), address)).toBe(
      "No paper with that id is listed on this node.",
    );
  });

  it("says it is the version that is missing when the address names one", () => {
    expect(describePageError(problem(404), { id: SHORT_ID, version: 9 })).toBe(
      "This paper has no listed version 9 on this node.",
    );
  });

  it("uses the search page's wording for everything else", () => {
    expect(describePageError(problem(422), address)).toBe(
      "That is not a valid paper address.",
    );
    expect(describePageError(new Error(""), address)).toBe(
      "The paper could not be loaded. Try again.",
    );
  });
});
