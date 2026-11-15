// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { FeedPage, type LoadFeedPage } from "./feed-page";
import {
  DEFAULT_FEED_STATE,
  type FeedItem,
  type FeedPageData,
  type FeedState,
} from "./feed";

const NOW = new Date("2026-11-16T12:00:00Z");
const DID_ZHANG = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const REVIEWED: FeedItem = {
  shortId: "sch:k3f9-q2xz-7mwd",
  paperCid: "bafy-paper-1",
  versionCid: "bafy-version-2",
  n: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "An evaluation framework for whether meta-agents can identify safer branches.",
  authors: [
    { did: DID_ZHANG, name: "M. Zhang", position: 1 },
    { did: "did:key:z6MkOkafor", name: "A. Okafor", position: 2 },
    { did: "did:key:z6MkSilva", name: "R. Silva", position: 3 },
    { did: "did:key:z6MkTan", name: "J. Tan", position: 4 },
  ],
  categories: ["cs.AI", "cs.MA"],
  status: "reviewed",
  listedAt: "2026-11-13T09:00:00",
  updatedAt: "2026-11-15T09:00:00",
};

const PREPRINT: FeedItem = {
  shortId: "sch:abcd-efgh-jklm",
  paperCid: "bafy-paper-2",
  versionCid: "bafy-version-3",
  n: 1,
  title: "Sparse Probing of Reward Models",
  abstract: "Linear probes recover reward signals from a handful of sparse directions.",
  authors: [{ did: "did:key:z6MkHaddad", name: "L. Haddad", position: 1 }],
  categories: ["cs.LG"],
  status: "preprint",
  listedAt: "2026-11-16T07:00:00",
  updatedAt: "2026-11-16T07:00:00",
};

const THIRD: FeedItem = {
  ...PREPRINT,
  shortId: "sch:zzzz-yyyy-xxxx",
  paperCid: "bafy-paper-3",
  versionCid: "bafy-version-4",
  title: "A Third Paper",
  status: "under_review",
};

function page(items: FeedItem[], nextCursor: string | null = null): FeedPageData {
  return { items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderFeed(props: Partial<React.ComponentProps<typeof FeedPage>> = {}) {
  const updateUrl = vi.fn();
  const load = vi.fn<LoadFeedPage>(async () => page([PREPRINT]));
  render(
    <FeedPage
      initialState={DEFAULT_FEED_STATE}
      initialPage={page([REVIEWED, PREPRINT])}
      signedIn={false}
      now={NOW}
      {...props}
      load={props.load ?? load}
      updateUrl={props.updateUrl ?? updateUrl}
    />,
  );
  return {
    load: (props.load ?? load) as ReturnType<typeof vi.fn<LoadFeedPage>>,
    updateUrl: (props.updateUrl ?? updateUrl) as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  window.history.replaceState(null, "", "/");
});

describe("FeedPage layout", () => {
  it("has Latest, Reviewed and Following tabs as links, with the current one marked", () => {
    renderFeed();

    const tabs = within(screen.getByRole("navigation", { name: "Feed" })).getAllByRole("link");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Latest", "Reviewed", "Following"]);
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual([
      "/",
      "/?tab=reviewed",
      "/?tab=following",
    ]);
    expect(tabs[0].getAttribute("aria-current")).toBe("page");
    expect(tabs[1].getAttribute("aria-current")).toBeNull();
  });

  it("keeps the category and sort when a tab link is followed without JavaScript", () => {
    renderFeed({
      initialState: { tab: "latest", category: "cs.AI", sort: "recently_updated" },
    });

    const reviewed = screen.getByRole("link", { name: "Reviewed" });
    expect(reviewed.getAttribute("href")).toBe("/?tab=reviewed&category=cs.AI&sort=recently_updated");
  });

  it("has a category selector and a sort selector with every option", () => {
    renderFeed();

    const category = screen.getByRole("combobox", { name: "Category" });
    expect(
      within(category).getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "All categories",
      "cs.AI · Artificial Intelligence",
      "cs.LG · Machine Learning",
      "cs.MA · Multiagent Systems",
    ]);

    const sort = screen.getByRole("combobox", { name: "Sort" });
    expect(within(sort).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Newest",
      "Recently reviewed",
      "Recently updated",
    ]);
  });

  it("shows the chosen category and sort", () => {
    renderFeed({
      initialState: { tab: "reviewed", category: "cs.LG", sort: "recently_reviewed" },
    });

    expect((screen.getByRole("combobox", { name: "Category" }) as HTMLSelectElement).value).toBe(
      "cs.LG",
    );
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe(
      "recently_reviewed",
    );
  });

  it("offers a category from the URL or from a paper even when the launch list lacks it", () => {
    renderFeed({
      initialState: { tab: "latest", category: "math.CO", sort: "newest" },
      initialPage: page([{ ...REVIEWED, categories: ["astro-ph.HE"] }]),
    });

    const options = within(screen.getByRole("combobox", { name: "Category" }))
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"));
    expect(options).toEqual(expect.arrayContaining(["math.CO", "astro-ph.HE"]));
  });

  it("has a heading for assistive tech that follows the tab", () => {
    renderFeed({ initialState: { ...DEFAULT_FEED_STATE, tab: "reviewed" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reviewed papers");
  });
});

describe("FeedPage rows", () => {
  it("shows a row per paper, in the order given", () => {
    renderFeed();

    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([REVIEWED.title, PREPRINT.title]);
  });

  it("links the title to the paper page", () => {
    renderFeed();

    const link = screen.getByRole("link", { name: REVIEWED.title });
    expect(link.getAttribute("href")).toBe("/p/k3f9-q2xz-7mwd");
    // The title heading is the serif role the stylesheet styles.
    expect(link.closest("h2")?.className).toBe("fd-row-title");
  });

  it("shows authors, categories, version and age on the meta line", () => {
    renderFeed();

    const [first] = screen.getAllByRole("listitem").filter((li) => li.classList.contains("fd-row"));
    const meta = first.querySelector(".fd-row-meta") as HTMLElement;

    expect(meta.querySelector(".fd-row-authors")?.textContent).toBe("M. Zhang, A. Okafor, +2");
    expect(
      Array.from(meta.querySelectorAll(".fd-row-categories a")).map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["cs.AI", "/c/cs.AI"],
      ["cs.MA", "/c/cs.MA"],
    ]);
    expect(meta.querySelector(".fd-row-version")?.textContent).toBe("v2");

    const age = meta.querySelector("time") as HTMLTimeElement;
    expect(age.textContent).toBe("3 days ago");
    expect(age.getAttribute("datetime")).toBe("2026-11-13T09:00:00.000Z");
    expect(age.getAttribute("title")).toBe("Listed 13 Nov 2026");
  });

  it("names every author in a tooltip when the byline is cut short", () => {
    renderFeed();

    const authors = document.querySelector(".fd-row-authors") as HTMLElement;
    expect(authors.getAttribute("title")).toBe("M. Zhang, A. Okafor, R. Silva, J. Tan");
  });

  it("shows a short DID when the API gives no author name", () => {
    renderFeed({
      initialPage: page([
        { ...PREPRINT, authors: [{ did: DID_ZHANG, name: null, position: 1 }] },
      ]),
    });

    expect(document.querySelector(".fd-row-authors")?.textContent).toBe("z6Mkha…2doK");
  });

  it("counts the age from the latest listing when sorted by recently updated", () => {
    renderFeed({
      initialState: { ...DEFAULT_FEED_STATE, sort: "recently_updated" },
    });

    expect(document.querySelector("time")?.textContent).toBe("1 day ago");
  });

  it("shows the abstract in the clamped two-line paragraph", () => {
    renderFeed();

    const abstract = document.querySelector(".fd-row-abstract") as HTMLElement;
    expect(abstract.tagName).toBe("P");
    expect(abstract.textContent).toBe(REVIEWED.abstract);
  });

  it("shows a status chip with its word, per paper", () => {
    renderFeed({ initialPage: page([REVIEWED, PREPRINT, THIRD]) });

    const chips = Array.from(document.querySelectorAll(".sch-chip")).map((chip) => [
      chip.getAttribute("data-status"),
      chip.textContent,
    ]);
    expect(chips).toEqual([
      ["reviewed", "Reviewed"],
      ["preprint", "Preprint"],
      ["under_review", "Under review"],
    ]);
  });

  it("shows no chip for a status the design has no chip for", () => {
    renderFeed({ initialPage: page([{ ...PREPRINT, status: "mystery" }]) });
    expect(document.querySelector(".sch-chip")).toBeNull();
    expect(document.querySelector(".fd-row-chips")).toBeNull();
  });

  it("leaves out the parts a paper does not have", () => {
    renderFeed({
      initialPage: page([
        { ...PREPRINT, abstract: "", authors: [], categories: [], listedAt: null, updatedAt: null },
      ]),
    });

    expect(document.querySelector(".fd-row-abstract")).toBeNull();
    expect(document.querySelector(".fd-row-authors")).toBeNull();
    expect(document.querySelector(".fd-row-categories")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
    expect(document.querySelector(".fd-row-version")?.textContent).toBe("v1");
  });

  it("shows no vote, like or score of any kind", () => {
    renderFeed({ initialPage: page([REVIEWED, PREPRINT, THIRD], "more") });

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/vote|upvote|downvote|likes?\b|score|popular|trending|karma/);
    expect(screen.queryByRole("button", { name: /vote|like|upvote/i })).toBeNull();
    expect(screen.queryByLabelText(/vote|like/i)).toBeNull();
    // Sort offers only time-based orders.
    expect(
      within(screen.getByRole("combobox", { name: "Sort" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["newest", "recently_reviewed", "recently_updated"]);
  });
});

describe("FeedPage tabs and selectors", () => {
  it("loads the Reviewed tab in place and updates the address", async () => {
    const { load, updateUrl } = renderFeed();

    // The page took the click over: the browser must not also follow the link.
    expect(fireEvent.click(screen.getByRole("link", { name: "Reviewed" }))).toBe(false);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({ tab: "reviewed", category: "", sort: "newest" });
    expect(updateUrl).toHaveBeenCalledWith("/?tab=reviewed", "push");

    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(screen.queryByRole("heading", { level: 2, name: REVIEWED.title })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Reviewed" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("shows a loading note while the next view loads", async () => {
    const slow = deferred<FeedPageData>();
    const { load } = renderFeed({ load: vi.fn(() => slow.promise) as never });

    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));

    expect((await screen.findByRole("status")).textContent).toBe("Loading papers…");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    void load;

    await act(async () => slow.resolve(page([PREPRINT])));
    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves a modified click (new tab) to the browser", () => {
    const { load, updateUrl } = renderFeed();
    // jsdom cannot navigate; stop it after React has had its look at the click.
    const stopNavigation = (event: Event): void => event.preventDefault();
    document.addEventListener("click", stopNavigation);

    try {
      const link = screen.getByRole("link", { name: "Reviewed" });
      for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        fireEvent.click(link, init);
      }
    } finally {
      document.removeEventListener("click", stopNavigation);
    }

    expect(load).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();
  });

  it("does nothing when the current tab is clicked again", () => {
    const { load, updateUrl } = renderFeed();

    fireEvent.click(screen.getByRole("link", { name: "Latest" }));

    expect(load).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();
  });

  it("keeps the category and sort across tabs", async () => {
    const { load } = renderFeed({
      initialState: { tab: "latest", category: "cs.AI", sort: "recently_updated" },
    });

    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));

    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(load).toHaveBeenCalledWith({
      tab: "reviewed",
      category: "cs.AI",
      sort: "recently_updated",
    });
  });

  it("filters by category when the selector changes", async () => {
    const { load, updateUrl } = renderFeed();

    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), {
      target: { value: "cs.LG" },
    });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({ tab: "latest", category: "cs.LG", sort: "newest" });
    expect(updateUrl).toHaveBeenCalledWith("/?category=cs.LG", "push");
  });

  it("returns to every category", async () => {
    const { load, updateUrl } = renderFeed({
      initialState: { tab: "latest", category: "cs.LG", sort: "newest" },
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), {
      target: { value: "" },
    });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE);
    expect(updateUrl).toHaveBeenCalledWith("/", "push");
  });

  it("re-sorts when the sort selector changes", async () => {
    const { load, updateUrl } = renderFeed();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "recently_reviewed" },
    });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({ tab: "latest", category: "", sort: "recently_reviewed" });
    expect(updateUrl).toHaveBeenCalledWith("/?sort=recently_reviewed", "push");
  });

  it("does not reload the page when Enter is pressed in a selector", () => {
    renderFeed();

    const form = screen.getByRole("combobox", { name: "Sort" }).closest("form") as HTMLFormElement;
    const allowed = fireEvent.submit(form);

    expect(allowed).toBe(false);
  });

  it("answers the newest choice when an earlier request answers late", async () => {
    const first = deferred<FeedPageData>();
    const second = deferred<FeedPageData>();
    const load = vi
      .fn<LoadFeedPage>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderFeed({ load });

    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "recently_updated" },
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(page([THIRD])));
    await act(async () => first.resolve(page([PREPRINT])));

    await screen.findByRole("heading", { level: 2, name: THIRD.title });
    expect(screen.queryByRole("heading", { level: 2, name: PREPRINT.title })).toBeNull();
  });

  it("follows the browser's back button", async () => {
    const { load } = renderFeed();
    window.history.pushState(null, "", "/?tab=reviewed&sort=recently_updated");

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith({
      tab: "reviewed",
      category: "",
      sort: "recently_updated",
    });
    expect(
      screen.getByRole("link", { name: "Reviewed" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("adopts a new route from the server, even one that repeats the earlier props", async () => {
    const load = vi.fn<LoadFeedPage>(async () => page([PREPRINT]));
    const initialState: FeedState = DEFAULT_FEED_STATE;
    const props = {
      signedIn: false,
      load,
      updateUrl: vi.fn(),
      now: NOW,
    };
    const { rerender } = render(
      <FeedPage {...props} initialState={initialState} initialPage={page([REVIEWED])} />,
    );

    // The reader moves to Reviewed in the browser…
    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));
    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });

    // …then follows a "Home" link: the server answers `/` again, with new objects
    // but the very same state as the first render.
    rerender(
      <FeedPage
        {...props}
        initialState={{ ...initialState }}
        initialPage={page([REVIEWED])}
      />,
    );

    await screen.findByRole("heading", { level: 2, name: REVIEWED.title });
    expect(
      screen.getByRole("link", { name: "Latest" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("FeedPage paging", () => {
  it("offers more papers only when the API has a next page", () => {
    renderFeed({ initialPage: page([REVIEWED], null) });
    expect(screen.queryByRole("button", { name: "Show more papers" })).toBeNull();
    cleanup();

    renderFeed({ initialPage: page([REVIEWED], "cursor-1") });
    expect(screen.getByRole("button", { name: "Show more papers" })).toBeTruthy();
  });

  it("appends the next page using the cursor and drops the button on the last page", async () => {
    const load = vi.fn<LoadFeedPage>(async () => page([PREPRINT, THIRD], null));
    renderFeed({ initialPage: page([REVIEWED], "cursor-1"), load });

    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));

    await screen.findByRole("heading", { level: 2, name: THIRD.title });
    expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE, "cursor-1");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      REVIEWED.title,
      PREPRINT.title,
      THIRD.title,
    ]);
    expect(screen.queryByRole("button", { name: "Show more papers" })).toBeNull();
  });

  it("keeps going with the new cursor and never shows a paper twice", async () => {
    const load = vi
      .fn<LoadFeedPage>()
      .mockResolvedValueOnce(page([REVIEWED, PREPRINT], "cursor-2"))
      .mockResolvedValueOnce(page([THIRD], null));
    renderFeed({ initialPage: page([REVIEWED], "cursor-1"), load });

    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));
    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));
    await screen.findByRole("heading", { level: 2, name: THIRD.title });

    expect(load).toHaveBeenNthCalledWith(2, DEFAULT_FEED_STATE, "cursor-2");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
  });

  it("disables the button while a page loads", async () => {
    const slow = deferred<FeedPageData>();
    renderFeed({
      initialPage: page([REVIEWED], "cursor-1"),
      load: vi.fn(() => slow.promise) as never,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));

    const busy = await screen.findByRole("button", { name: "Loading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => slow.resolve(page([])));
  });

  it("keeps the papers on screen and says so when a page fails to load", async () => {
    const load = vi.fn<LoadFeedPage>(async () => {
      throw new Error("The catalog is rebuilding.");
    });
    renderFeed({ initialPage: page([REVIEWED], "cursor-1"), load });

    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The catalog is rebuilding.");
    expect(screen.getByRole("heading", { level: 2, name: REVIEWED.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show more papers" })).toBeTruthy();
  });

  it("drops a late page when the view has changed meanwhile", async () => {
    const slowMore = deferred<FeedPageData>();
    const load = vi
      .fn<LoadFeedPage>()
      .mockReturnValueOnce(slowMore.promise)
      .mockResolvedValueOnce(page([THIRD]));
    renderFeed({ initialPage: page([REVIEWED], "cursor-1"), load });

    fireEvent.click(screen.getByRole("button", { name: "Show more papers" }));
    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));
    await screen.findByRole("heading", { level: 2, name: THIRD.title });

    await act(async () => slowMore.resolve(page([PREPRINT])));

    expect(screen.queryByRole("heading", { level: 2, name: PREPRINT.title })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: THIRD.title })).toBeTruthy();
  });
});

describe("FeedPage following tab", () => {
  const following: FeedState = { tab: "following", category: "", sort: "newest" };

  it("asks a signed-out visitor to sign in and makes no request", () => {
    const { load } = renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: false,
    });

    expect(
      screen.getByText("Sign in to follow categories and see their new papers here."),
    ).toBeTruthy();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe("/signin?next=%2F%3Ftab%3Dfollowing");
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("loads the caller's followed papers once signed in", async () => {
    const { load } = renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: true,
    });

    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(following);
  });

  it("reads the session from the token store when it is not pinned", async () => {
    tokenStore.set({ accessToken: "token-1" });
    const { load } = renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: undefined,
    });

    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(load).toHaveBeenCalledWith(following);
    expect(screen.queryByText(/Sign in to follow/)).toBeNull();
  });

  it("shows the sign-in prompt, not an error, when there is no session in the store", async () => {
    const { load } = renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: undefined,
    });

    await screen.findByText("Sign in to follow categories and see their new papers here.");
    expect(load).not.toHaveBeenCalled();
  });

  it("switches from the sign-in prompt to a loaded Latest tab", async () => {
    const { load } = renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: false,
    });

    fireEvent.click(screen.getByRole("link", { name: "Latest" }));

    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE);
    expect(screen.queryByText(/Sign in to follow/)).toBeNull();
  });

  it("shows loading, not the sign-in prompt, on the first render before the session is read", () => {
    // `renderToString` is the render before any effect runs: the server's HTML,
    // and the browser's first paint. Nobody has asked the token store yet, so
    // the page must not tell a signed-in reader to sign in.
    const html = renderToString(
      <FeedPage initialState={following} signedIn={undefined} load={vi.fn()} now={NOW} />,
    );

    expect(html).toContain("Loading papers…");
    expect(html).not.toContain("Sign in to follow");
  });

  it("points an empty Following tab at a category to follow", async () => {
    renderFeed({
      initialState: following,
      initialPage: undefined,
      signedIn: true,
      load: vi.fn(async () => page([])) as never,
    });

    await screen.findByText(/No papers from the categories you follow yet/);
    expect(screen.getByRole("link", { name: "Open cs.AI" }).getAttribute("href")).toBe("/c/cs.AI");
  });
});

describe("FeedPage errors and empty states", () => {
  it("shows a failed server fetch with a way to try again", async () => {
    const load = vi.fn<LoadFeedPage>(async () => page([PREPRINT]));
    renderFeed({
      initialPage: undefined,
      initialError: "Couldn’t reach the API. Check your connection and try again.",
      load,
    });

    expect((screen.getByRole("alert")).textContent).toContain("Couldn’t reach the API");
    // The tabs and selectors stay usable.
    expect(screen.getByRole("link", { name: "Reviewed" })).toBeTruthy();
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed tab change and recovers on retry", async () => {
    const load = vi
      .fn<LoadFeedPage>()
      .mockRejectedValueOnce(new Error("The catalog is rebuilding."))
      .mockResolvedValueOnce(page([PREPRINT]));
    renderFeed({ load });

    fireEvent.click(screen.getByRole("link", { name: "Reviewed" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The catalog is rebuilding.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 2, name: PREPRINT.title });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("says no papers are listed yet, with a way to submit one", () => {
    renderFeed({ initialPage: page([]) });

    expect(screen.getByText("No papers are listed yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Submit a paper" }).getAttribute("href")).toBe(
      "/submit",
    );
  });

  it("offers every category when a category has no papers", async () => {
    const { load, updateUrl } = renderFeed({
      initialState: { tab: "latest", category: "cs.MA", sort: "newest" },
      initialPage: page([]),
    });

    expect(screen.getByText("No papers are listed in cs.MA yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Show all categories" }));

    await waitFor(() => expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE));
    expect(updateUrl).toHaveBeenCalledWith("/", "push");
  });

  it("sends an empty Reviewed tab to the latest papers", async () => {
    const { load } = renderFeed({
      initialState: { tab: "reviewed", category: "", sort: "newest" },
      initialPage: page([]),
    });

    expect(screen.getByText("No reviewed papers yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "See the latest papers" }));

    await waitFor(() => expect(load).toHaveBeenCalledWith(DEFAULT_FEED_STATE));
  });
});
