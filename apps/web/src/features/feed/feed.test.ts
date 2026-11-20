import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  DEFAULT_FEED_STATE,
  FEED_PAGE_SIZE,
  FeedResponseError,
  appendItems,
  authorLabel,
  authorLine,
  categoriesOf,
  categoryChoices,
  categoryPath,
  describeFeedError,
  emptyFeedSentence,
  feedHref,
  feedQuery,
  feedStateKey,
  formatAge,
  loadFeedPage,
  paperHref,
  parseFeedPage,
  parseFeedParams,
  parseInstant,
  rowAge,
  shortDid,
  signInHref,
  type FeedItem,
  type FeedState,
} from "./feed";

// The journeys run east of UTC (GMT+11 in November); pin the zone so the
// reader's-zone dates asserted here are deterministic on any machine.
process.env.TZ = "Australia/Sydney";

const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** The wire shape of one `GET /v1/papers` item. */
function wireItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper: "sch:k3f9-q2xz-7mwd",
    shortId: "sch:k3f9-q2xz-7mwd",
    paperCid: "bafy-paper-1",
    versionCid: "bafy-version-2",
    cid: "bafy-version-2",
    n: 2,
    version: 2,
    title: "Can a Meta-Agent Choose the Safer Branch?",
    abstract: "An evaluation framework for whether meta-agents can identify safer branches.",
    authors: [
      { did: DID_A, author: DID_A, position: 1, creditRoles: null },
      { did: "did:key:z6MkB", author: "did:key:z6MkB", position: 2 },
    ],
    categories: ["cs.AI", "cs.MA"],
    licence: "CC-BY-4.0",
    status: "reviewed",
    listedAt: "2026-11-13T09:00:00",
    updatedAt: "2026-11-15T09:00:00",
    ...overrides,
  };
}

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    shortId: "sch:k3f9-q2xz-7mwd",
    paperCid: "bafy-paper-1",
    versionCid: "bafy-version-2",
    n: 2,
    title: "A paper",
    abstract: "",
    authors: [],
    categories: [],
    status: "preprint",
    listedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("parseFeedParams", () => {
  it("reads the tab, category and sort", () => {
    expect(
      parseFeedParams({ tab: "reviewed", category: "cs.AI", sort: "recently_updated" }),
    ).toEqual({ tab: "reviewed", category: "cs.AI", sort: "recently_updated" });
  });

  it("is the default view for no parameters", () => {
    expect(parseFeedParams({})).toEqual(DEFAULT_FEED_STATE);
    expect(parseFeedParams()).toEqual(DEFAULT_FEED_STATE);
  });

  it("falls back to the default for a tab or sort the API would refuse", () => {
    expect(parseFeedParams({ tab: "trending", sort: "most_votes" })).toEqual(
      DEFAULT_FEED_STATE,
    );
  });

  it("matches the tab and sort without regard to case or padding", () => {
    expect(parseFeedParams({ tab: " Following ", sort: "NEWEST" })).toMatchObject({
      tab: "following",
      sort: "newest",
    });
  });

  it("uses the first of a repeated parameter and trims the category", () => {
    expect(
      parseFeedParams({ tab: ["reviewed", "following"], category: ["  cs.LG ", "cs.AI"] }),
    ).toMatchObject({ tab: "reviewed", category: "cs.LG" });
  });

  it("drops a category longer than the API accepts", () => {
    expect(parseFeedParams({ category: "x".repeat(65) }).category).toBe("");
    expect(parseFeedParams({ category: "x".repeat(64) }).category).toHaveLength(64);
  });
});

describe("feedHref", () => {
  it("is the bare feed path for the default view", () => {
    expect(feedHref(DEFAULT_FEED_STATE)).toBe("/papers");
  });

  it("carries only what differs from the default", () => {
    expect(feedHref({ tab: "reviewed", category: "", sort: "newest" })).toBe(
      "/papers?tab=reviewed",
    );
    expect(feedHref({ tab: "latest", category: "cs.AI", sort: "newest" })).toBe(
      "/papers?category=cs.AI",
    );
    expect(feedHref({ tab: "latest", category: "", sort: "recently_reviewed" })).toBe(
      "/papers?sort=recently_reviewed",
    );
  });

  it("round-trips through parseFeedParams", () => {
    const states: FeedState[] = [
      DEFAULT_FEED_STATE,
      { tab: "following", category: "cs.MA", sort: "recently_updated" },
      { tab: "reviewed", category: "astro-ph.HE", sort: "recently_reviewed" },
    ];
    for (const state of states) {
      const query = Object.fromEntries(
        new URL(feedHref(state), "https://x.test").searchParams,
      );
      expect(parseFeedParams(query)).toEqual(state);
    }
  });

  it("encodes a category that holds reserved characters", () => {
    expect(feedHref({ tab: "latest", category: "a&b", sort: "newest" })).toBe(
      "/papers?category=a%26b",
    );
  });
});

describe("feedStateKey", () => {
  it("tells views apart and ignores category padding", () => {
    const a = feedStateKey(DEFAULT_FEED_STATE);
    expect(feedStateKey({ ...DEFAULT_FEED_STATE, tab: "reviewed" })).not.toBe(a);
    expect(feedStateKey({ ...DEFAULT_FEED_STATE, sort: "recently_updated" })).not.toBe(a);
    expect(feedStateKey({ ...DEFAULT_FEED_STATE, category: " cs.AI " })).toBe(
      feedStateKey({ ...DEFAULT_FEED_STATE, category: "cs.AI" }),
    );
  });
});

describe("feedQuery", () => {
  it("asks for the tab, sort and a page of the standard size", () => {
    expect(feedQuery({ tab: "reviewed", category: "", sort: "newest" })).toEqual({
      tab: "reviewed",
      sort: "newest",
      limit: FEED_PAGE_SIZE,
    });
  });

  it("adds the category and the cursor only when there are some", () => {
    expect(
      feedQuery({ tab: "latest", category: "cs.AI", sort: "recently_updated" }, "abc"),
    ).toEqual({
      tab: "latest",
      sort: "recently_updated",
      limit: FEED_PAGE_SIZE,
      category: "cs.AI",
      cursor: "abc",
    });
  });
});

describe("parseFeedPage", () => {
  it("reads the fields a row shows", () => {
    const page = parseFeedPage({ items: [wireItem()], nextCursor: "eyJ2IjoxfQ" });

    expect(page.nextCursor).toBe("eyJ2IjoxfQ");
    expect(page.items).toEqual([
      {
        shortId: "sch:k3f9-q2xz-7mwd",
        paperCid: "bafy-paper-1",
        versionCid: "bafy-version-2",
        n: 2,
        title: "Can a Meta-Agent Choose the Safer Branch?",
        abstract: "An evaluation framework for whether meta-agents can identify safer branches.",
        authors: [
          { did: DID_A, name: null, position: 1 },
          { did: "did:key:z6MkB", name: null, position: 2 },
        ],
        categories: ["cs.AI", "cs.MA"],
        status: "reviewed",
        listedAt: "2026-11-13T09:00:00",
        updatedAt: "2026-11-15T09:00:00",
      },
    ]);
  });

  it("has no next cursor on the last page", () => {
    expect(parseFeedPage({ items: [wireItem()], nextCursor: null }).nextCursor).toBeNull();
    expect(parseFeedPage({ items: [] }).nextCursor).toBeNull();
  });

  it("never carries a vote, like or popularity field into an item", () => {
    const page = parseFeedPage({
      items: [
        wireItem({
          votes: 41,
          upvotes: 40,
          likes: 12,
          score: 9.5,
          popularity: 0.8,
          citations: 3,
        }),
      ],
    });

    const keys = Object.keys(page.items[0]);
    expect(keys).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/vote|like|score|popular/i)]),
    );
    expect(JSON.stringify(page.items[0])).not.toMatch(/41|9\.5|popular/);
  });

  it("puts authors in byline order and reads a display name when one is given", () => {
    const page = parseFeedPage({
      items: [
        wireItem({
          authors: [
            { did: "did:key:two", position: 2, name: "A. Okafor" },
            { did: "did:key:one", position: 1, displayName: "M. Zhang" },
            { did: "did:key:none" },
          ],
        }),
      ],
    });

    expect(page.items[0].authors.map((author) => [author.did, author.name])).toEqual([
      ["did:key:one", "M. Zhang"],
      ["did:key:two", "A. Okafor"],
      ["did:key:none", null],
    ]);
  });

  it("falls back to the version number and the paper id", () => {
    const [parsed] = parseFeedPage({
      items: [wireItem({ n: undefined, version: 3, shortId: undefined, paper: "sch:aaaa-bbbb-cccc" })],
    }).items;

    expect(parsed.n).toBe(3);
    expect(parsed.shortId).toBe("sch:aaaa-bbbb-cccc");
  });

  it("drops an item with no title or nothing to link to, and keeps the rest", () => {
    const page = parseFeedPage({
      items: [
        wireItem({ title: "   " }),
        wireItem({ shortId: undefined, paper: undefined, paperCid: undefined, versionCid: undefined, cid: undefined }),
        null,
        "nope",
        wireItem({ title: "Kept", paperCid: "bafy-kept" }),
      ],
    });

    expect(page.items.map((entry) => entry.title)).toEqual(["Kept"]);
  });

  it("treats a body that is not a list as an error, not an empty feed", () => {
    expect(() => parseFeedPage(null)).toThrow(FeedResponseError);
    expect(() => parseFeedPage({})).toThrow(FeedResponseError);
    expect(() => parseFeedPage({ items: "none" })).toThrow(FeedResponseError);
    expect(() => parseFeedPage([wireItem()])).toThrow(FeedResponseError);
  });
});

describe("loadFeedPage", () => {
  it("gets /papers with the query and never from a cache", async () => {
    const get = vi.fn(async () => ({ items: [wireItem()], nextCursor: null }));

    const page = await loadFeedPage(
      { tab: "reviewed", category: "cs.AI", sort: "recently_reviewed" },
      "cur",
      { get } as never,
    );

    expect(get).toHaveBeenCalledWith("/papers", {
      query: {
        tab: "reviewed",
        sort: "recently_reviewed",
        limit: FEED_PAGE_SIZE,
        category: "cs.AI",
        cursor: "cur",
      },
      cache: "no-store",
    });
    expect(page.items).toHaveLength(1);
  });

  it("rejects a malformed body", async () => {
    const get = vi.fn(async () => ({ nothing: true }));
    await expect(
      loadFeedPage(DEFAULT_FEED_STATE, undefined, { get } as never),
    ).rejects.toBeInstanceOf(FeedResponseError);
  });
});

describe("author names from public profiles", () => {
  /** A `get` that answers `GET /v1/papers` and each author's profile. */
  function feedClient(
    profiles: Readonly<Record<string, string | null>> = {},
    pages: unknown[] = [wireItem()],
  ) {
    return vi.fn(async (path: string) => {
      if (path === "/papers") {
        return { items: pages, nextCursor: null };
      }
      const match = /^\/profiles\/(.+)$/.exec(path);
      if (match === null) {
        throw new Error(`unexpected ${path}`);
      }
      const did = decodeURIComponent(match[1]);
      if (!(did in profiles)) {
        throw new ApiError(404, { status: 404, title: "Not Found" });
      }
      return { did, name: profiles[did] };
    });
  }

  it("fills the name from GET /v1/profiles/{did} when the list carries DIDs only", async () => {
    const get = feedClient({
      [DID_A]: "Mei Zhang",
      "did:key:z6MkB": "A. Okafor",
    });

    const page = await loadFeedPage(DEFAULT_FEED_STATE, undefined, { get } as never);

    expect(page.items[0].authors.map((author) => author.name)).toEqual([
      "Mei Zhang",
      "A. Okafor",
    ]);
    expect(page.items[0].authors.map((author) => authorLabel(author))).toEqual([
      "Mei Zhang",
      "A. Okafor",
    ]);
  });

  it("asks for each DID once and keeps a name the list already supplied", async () => {
    const get = feedClient({ "did:key:z6MkB": "A. Okafor" }, [
      wireItem({
        authors: [
          { did: DID_A, name: "M. Zhang", position: 1 },
          { did: "did:key:z6MkB", position: 2 },
        ],
      }),
      wireItem({
        paper: "sch:abcd-efgh-jklm",
        shortId: "sch:abcd-efgh-jklm",
        authors: [{ did: "did:key:z6MkB", position: 1 }],
      }),
    ]);

    const page = await loadFeedPage(DEFAULT_FEED_STATE, undefined, { get } as never);

    expect(page.items[0].authors[0].name).toBe("M. Zhang");
    expect(page.items[0].authors[1].name).toBe("A. Okafor");
    expect(page.items[1].authors[0].name).toBe("A. Okafor");
    const profileCalls = get.mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith("/profiles/"));
    expect(profileCalls).toEqual([`/profiles/${encodeURIComponent("did:key:z6MkB")}`]);
  });

  it("falls back to the DID when a profile cannot be read", async () => {
    const get = feedClient();

    const page = await loadFeedPage(DEFAULT_FEED_STATE, undefined, { get } as never);

    expect(page.items[0].authors.map((author) => author.name)).toEqual([null, null]);
    expect(authorLabel(page.items[0].authors[0])).toBe(shortDid(DID_A));
  });

  it("does not let an erased profile reveal a name", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/papers") {
        return { items: [wireItem()], nextCursor: null };
      }
      return { did: DID_A, name: "Stale Name", erased: true };
    });

    const page = await loadFeedPage(DEFAULT_FEED_STATE, undefined, { get } as never);

    expect(page.items[0].authors.map((author) => author.name)).toEqual([null, null]);
  });
});

describe("describeFeedError", () => {
  function apiError(status: number, detail = ""): ApiError {
    return new ApiError(status, {
      status,
      title: "Problem",
      ...(detail === "" ? {} : { detail }),
    });
  }

  it("asks a signed-out visitor on the Following tab to sign in", () => {
    expect(describeFeedError(apiError(401), "following")).toBe(
      "Sign in to see papers from the categories you follow.",
    );
  });

  it("says Following is unavailable when the node does not serve the tab", () => {
    expect(describeFeedError(apiError(422), "following")).toBe(
      "Following is not available on this node yet.",
    );
  });

  it("explains a rate limit and a network failure plainly", () => {
    expect(describeFeedError(apiError(429))).toContain("Too many requests");
    expect(describeFeedError(new NetworkError("http://localhost:8000/v1/papers"))).toContain("Couldn’t reach the API");
  });

  it("prefers the API's own detail", () => {
    expect(describeFeedError(apiError(500, "The catalog is rebuilding."))).toBe(
      "The catalog is rebuilding.",
    );
  });

  it("passes on a malformed-response message and has a last resort", () => {
    expect(describeFeedError(new FeedResponseError("The API did not return a list of papers."))).toBe(
      "The API did not return a list of papers.",
    );
    expect(describeFeedError("nonsense")).toBe("The feed could not be loaded. Try again.");
  });
});

describe("paperHref and categoryPath", () => {
  it("drops the sch: prefix like every paper URL", () => {
    expect(paperHref(item({ shortId: "sch:k3f9-q2xz-7mwd" }))).toBe("/p/k3f9-q2xz-7mwd");
  });

  it("falls back to a cid when the paper has no short id", () => {
    expect(paperHref(item({ shortId: "", paperCid: "bafy-paper-1" }))).toBe("/p/bafy-paper-1");
    expect(paperHref(item({ shortId: "", paperCid: "", versionCid: "bafy-v" }))).toBe("/p/bafy-v");
  });

  it("links a category to its page as one path segment", () => {
    expect(categoryPath("cs.AI")).toBe("/c/cs.AI");
    expect(categoryPath("a/b")).toBe("/c/a%2Fb");
  });
});

describe("appendItems", () => {
  it("adds a page and skips a paper already shown", () => {
    const first = item({ paperCid: "p1", title: "One" });
    const second = item({ paperCid: "p2", title: "Two" });
    const third = item({ paperCid: "p3", title: "Three" });

    expect(
      appendItems([first, second], [second, third]).map((entry) => entry.title),
    ).toEqual(["One", "Two", "Three"]);
  });

  it("skips a repeat within the new page too", () => {
    const one = item({ paperCid: "p1" });
    expect(appendItems([], [one, one])).toHaveLength(1);
  });
});

describe("authors", () => {
  it("shortens a DID to something that tells authors apart", () => {
    expect(shortDid(DID_A)).toBe("z6Mkha…2doK");
    expect(shortDid("did:key:z6MkB")).toBe("z6MkB");
    expect(shortDid("did:web:example.com")).toBe("example.com");
    expect(shortDid("")).toBe("Unknown author");
  });

  it("names an author by display name, else by short DID", () => {
    expect(authorLabel({ did: DID_A, name: "Mei Zhang" })).toBe("Mei Zhang");
    expect(authorLabel({ did: DID_A, name: null })).toBe("z6Mkha…2doK");
  });

  it("names up to three authors in full", () => {
    const names = ["M. Zhang", "A. Okafor", "R. Silva"].map((name) => ({ did: "d", name }));

    expect(authorLine(names.slice(0, 1))).toMatchObject({ shown: ["M. Zhang"], more: 0 });
    expect(authorLine(names)).toMatchObject({
      shown: ["M. Zhang", "A. Okafor", "R. Silva"],
      more: 0,
    });
  });

  it("names two and counts the rest from four authors (M. Zhang, A. Okafor, +2)", () => {
    const names = ["M. Zhang", "A. Okafor", "R. Silva", "J. Tan"].map((name) => ({
      did: "d",
      name,
    }));

    const line = authorLine(names);
    expect(line.shown).toEqual(["M. Zhang", "A. Okafor"]);
    expect(line.more).toBe(2);
    expect(line.all).toHaveLength(4);
    expect(authorLine([...names, { did: "d", name: "K. Lee" }]).more).toBe(3);
  });

  it("is empty for no authors", () => {
    expect(authorLine([])).toEqual({ shown: [], more: 0, all: [] });
  });
});

describe("parseInstant", () => {
  it("reads a zone-less API timestamp as UTC, not as the viewer's local time", () => {
    expect(parseInstant("2026-11-15T09:00:00")?.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect(parseInstant("2026-11-15T09:00:00.123456")?.toISOString()).toBe(
      "2026-11-15T09:00:00.123Z",
    );
  });

  it("keeps an explicit zone", () => {
    expect(parseInstant("2026-11-15T09:00:00Z")?.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect(parseInstant("2026-11-15T11:00:00+02:00")?.toISOString()).toBe(
      "2026-11-15T09:00:00.000Z",
    );
  });

  it("is null for nothing or nonsense", () => {
    expect(parseInstant(null)).toBeNull();
    expect(parseInstant("")).toBeNull();
    expect(parseInstant("yesterday")).toBeNull();
  });
});

describe("formatAge", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("reads like the design mock: 5 hours ago, 3 days ago", () => {
    expect(formatAge(ago(5 * HOUR), now)).toBe("5 hours ago");
    expect(formatAge(ago(3 * DAY), now)).toBe("3 days ago");
  });

  it("uses the singular for one", () => {
    expect(formatAge(ago(1 * MIN + 5_000), now)).toBe("1 minute ago");
    expect(formatAge(ago(1 * HOUR), now)).toBe("1 hour ago");
    expect(formatAge(ago(1 * DAY), now)).toBe("1 day ago");
    expect(formatAge(ago(30 * DAY), now)).toBe("1 month ago");
    expect(formatAge(ago(365 * DAY), now)).toBe("1 year ago");
  });

  it("steps up through minutes, hours, days, months and years", () => {
    expect(formatAge(ago(10 * 1000), now)).toBe("just now");
    expect(formatAge(ago(59 * MIN), now)).toBe("59 minutes ago");
    expect(formatAge(ago(23 * HOUR), now)).toBe("23 hours ago");
    expect(formatAge(ago(29 * DAY), now)).toBe("29 days ago");
    expect(formatAge(ago(90 * DAY), now)).toBe("3 months ago");
    expect(formatAge(ago(800 * DAY), now)).toBe("2 years ago");
  });

  it("reads a moment in the future as just now", () => {
    expect(formatAge(new Date(now.getTime() + 5 * MIN), now)).toBe("just now");
  });
});

describe("rowAge", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const times = { listedAt: "2026-11-13T12:00:00", updatedAt: "2026-11-15T12:00:00" };

  it("counts from when the paper first appeared, in every sort but recently updated", () => {
    for (const sort of ["newest", "recently_reviewed"] as const) {
      expect(rowAge(times, sort, now)).toEqual({
        label: "3 days ago",
        dateTime: "2026-11-13T12:00:00.000Z",
        title: "Listed 13 Nov 2026",
      });
    }
  });

  it("counts from the latest listing when sorted by recently updated", () => {
    expect(rowAge(times, "recently_updated", now)).toEqual({
      label: "1 day ago",
      dateTime: "2026-11-15T12:00:00.000Z",
      title: "Updated 15 Nov 2026",
    });
  });

  it("falls back to the other timestamp, and to nothing", () => {
    expect(rowAge({ listedAt: null, updatedAt: times.updatedAt }, "newest", now)?.title).toBe(
      "Updated 15 Nov 2026",
    );
    expect(rowAge({ listedAt: times.listedAt, updatedAt: null }, "recently_updated", now)?.title).toBe(
      "Listed 13 Nov 2026",
    );
    expect(rowAge({ listedAt: null, updatedAt: null }, "newest", now)).toBeNull();
  });

  it("names the day in the reader's own time zone, as every page does", () => {
    // 23:30 UTC on the 15th is the 16th in Sydney (GMT+11); the feed row, the
    // profile and the Versions tab must all say 16 (bug_spec_verify12 bug 2).
    expect(
      rowAge({ listedAt: "2026-11-15T23:30:00", updatedAt: null }, "newest", now)?.title,
    ).toBe("Listed 16 Nov 2026");
  });
});

describe("categoryChoices", () => {
  it("offers the launch taxonomy first, with names", () => {
    expect(categoryChoices().map((choice) => choice.id)).toEqual(["cs.AI", "cs.LG", "cs.MA"]);
    expect(categoryChoices()[0].label).toBe("cs.AI · Artificial Intelligence");
  });

  it("adds every other seen category alphabetically, with just the id", () => {
    const choices = categoryChoices(["q-bio.NC", "astro-ph.HE", "cs.AI", "q-bio.NC"]);

    expect(choices.map((choice) => choice.id)).toEqual([
      "cs.AI",
      "cs.LG",
      "cs.MA",
      "astro-ph.HE",
      "q-bio.NC",
    ]);
    expect(choices.at(-1)?.label).toBe("q-bio.NC");
  });

  it("always includes the chosen category", () => {
    expect(categoryChoices([], "math.CO").map((choice) => choice.id)).toContain("math.CO");
    expect(categoryChoices([], "cs.LG").filter((choice) => choice.id === "cs.LG")).toHaveLength(1);
  });
});

describe("categoriesOf", () => {
  it("lists each category once, in first-seen order", () => {
    expect(
      categoriesOf([
        { categories: ["cs.AI", "cs.MA"] },
        { categories: ["cs.MA", "cs.LG"] },
      ]),
    ).toEqual(["cs.AI", "cs.MA", "cs.LG"]);
  });
});

describe("signInHref", () => {
  it("returns to the feed view the visitor was on", () => {
    expect(signInHref({ tab: "following", category: "", sort: "newest" })).toBe(
      "/signin?next=%2Fpapers%3Ftab%3Dfollowing",
    );
  });
});

describe("emptyFeedSentence", () => {
  it("says what is missing in each view", () => {
    expect(emptyFeedSentence(DEFAULT_FEED_STATE)).toBe("No papers are listed yet.");
    expect(emptyFeedSentence({ ...DEFAULT_FEED_STATE, category: "cs.AI" })).toBe(
      "No papers are listed in cs.AI yet.",
    );
    expect(emptyFeedSentence({ ...DEFAULT_FEED_STATE, tab: "reviewed" })).toBe(
      "No reviewed papers yet.",
    );
    expect(emptyFeedSentence({ ...DEFAULT_FEED_STATE, tab: "following" })).toContain(
      "categories you follow",
    );
  });
});
