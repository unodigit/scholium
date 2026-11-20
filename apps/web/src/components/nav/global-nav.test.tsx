// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { SIGNED_IN_HINT_STORAGE_KEY } from "../../lib/api/session-provider";
import { HomeNav } from "../../features/home/home-nav";
import { DEFAULT_CATEGORIES } from "./categories";
import { GlobalNav, NavTabBarSpacer } from "./global-nav";
import { NOTIFICATIONS_CHANGED_EVENT } from "./notifications";

/* ---------------------------------------------------------------------------
   Next.js plumbing. Both hooks are read during render, so they are mocked at
   the module level; `push` and `pathnameValue` are read lazily (inside the
   component), which keeps the vi.mock factories hoist-safe.
   ------------------------------------------------------------------------- */

const push = vi.fn();
const replace = vi.fn();
let pathnameValue: string | null = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => pathnameValue,
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children);
  return { default: Link };
});

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  pathnameValue = "/";
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
   Desktop header
   ------------------------------------------------------------------------- */

describe("GlobalNav desktop header", () => {
  it("shows the brand lockup linking the feed, named Scholium home", () => {
    render(<GlobalNav />);

    const logo = screen.getByRole("link", { name: "Scholium home" });
    expect(logo.getAttribute("href")).toBe("/papers");

    // BrandLogo size="sm": inline SVG mark + serif wordmark at a fixed 20px
    // height. No <img>, so nothing loads in after paint and shifts the row.
    const lockup = logo.querySelector(".sch-brand-logo") as HTMLElement;
    expect(lockup).not.toBeNull();
    expect(lockup.getAttribute("data-size")).toBe("sm");
    expect(lockup.style.height).toBe("20px");
    expect(lockup.querySelector("svg")).not.toBeNull();
    expect(lockup.querySelector("img")).toBeNull();

    const wordmark = lockup.querySelector(".sch-brand-logo__wordmark");
    expect(wordmark?.getAttribute("aria-hidden")).toBe("true");
    expect(wordmark?.textContent).toBe("scholium");
  });

  it("no longer renders the old text-only wordmark", () => {
    const { container } = render(<GlobalNav />);

    expect(container.querySelector(".gn-wordmark")).toBeNull();
    // The bare wordmark is not the link's name any more.
    expect(screen.queryByRole("link", { name: "scholium" })).toBeNull();
  });

  it("is a sticky translucent header shown from 640px up", () => {
    render(<GlobalNav />);

    const header = screen.getByRole("banner");
    expect(header.className).toContain("material-chrome");
    expect(header.className).toContain("hidden");
    expect(header.className).toContain("sm:flex");
  });

  it("offers a Submit link to /submit on desktop and mobile", () => {
    render(<GlobalNav />);

    const submits = screen.getAllByRole("link", { name: "Submit" });
    expect(submits).toHaveLength(2);
    for (const link of submits) {
      expect(link.getAttribute("href")).toBe("/submit");
    }
  });
});

describe("GlobalNav search field", () => {
  it("submits q to /search as a plain GET form", () => {
    render(<GlobalNav />);

    const form = screen.getByRole("search");
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.getAttribute("method")).toBe("get");

    const input = within(form).getByLabelText(
      "Search papers, authors and sch: IDs",
    );
    expect(input).toHaveProperty("name", "q");
    expect(input.getAttribute("placeholder")).toBe(
      "Search papers, authors, sch: IDs…",
    );
  });

  it("soft-navigates with the encoded query on submit", () => {
    render(<GlobalNav />);

    const form = screen.getByRole("search");
    fireEvent.change(within(form).getByLabelText(/Search papers/), {
      target: { value: "reward models" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Search" }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/search?q=reward%20models");
  });

  it("navigates to /search without a query when the field is empty", () => {
    render(<GlobalNav />);

    const form = screen.getByRole("search");
    fireEvent.submit(form);

    expect(push).toHaveBeenCalledWith("/search");
  });

  it("shows the query already in the address bar on /search?q=…", async () => {
    window.history.replaceState(null, "", "/search?q=reward+models");
    pathnameValue = "/search";

    render(<GlobalNav />);

    const input = within(screen.getByRole("search")).getByLabelText(
      /Search papers/,
    ) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("reward models"));
  });

  it("adopts a back/forward change to the query without a remount", async () => {
    render(<GlobalNav />);
    const input = within(screen.getByRole("search")).getByLabelText(
      /Search papers/,
    ) as HTMLInputElement;
    expect(input.value).toBe("");

    window.history.replaceState(null, "", "/search?q=pulsars");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => expect(input.value).toBe("pulsars"));
  });
});

describe("GlobalNav categories menu", () => {
  it("opens on demand and lists categories linking to /c/{id}", () => {
    render(<GlobalNav />);

    const trigger = screen.getByRole("button", { name: "Categories" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    for (const category of DEFAULT_CATEGORIES) {
      // The item's name joins the label and the mono id; match the label.
      const link = screen.getByRole("link", {
        name: new RegExp(category.label),
      });
      expect(link.getAttribute("href")).toBe(`/c/${category.id}`);
    }
  });

  it("closes after choosing a category", () => {
    render(<GlobalNav />);

    fireEvent.click(screen.getByRole("button", { name: "Categories" }));
    fireEvent.click(screen.getByRole("link", { name: /Artificial Intelligence/ }));

    expect(screen.queryByRole("link", { name: /Artificial Intelligence/ })).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<GlobalNav />);

    const trigger = screen.getByRole("button", { name: "Categories" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a pointer down outside the menu", () => {
    render(<GlobalNav />);

    const trigger = screen.getByRole("button", { name: "Categories" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

/* ---------------------------------------------------------------------------
   Notifications badge and avatar
   ------------------------------------------------------------------------- */

describe("GlobalNav notifications", () => {
  it("labels the bell with the unread count and badges both bell and Inbox", () => {
    render(<GlobalNav signedIn unreadCount={3} />);

    const bell = screen.getByRole("link", { name: "Notifications, 3 unread" });
    expect(bell.getAttribute("href")).toBe("/me#notifications");
    expect(bell.textContent).toContain("3");

    const inbox = screen.getByRole("link", { name: "Inbox" });
    expect(inbox.getAttribute("href")).toBe("/me#notifications");
    expect(inbox.textContent).toContain("3");
  });

  it("caps the badge at 99+", () => {
    render(<GlobalNav unreadCount={150} />);

    expect(
      screen.getByRole("link", { name: "Notifications, 99+ unread" }),
    ).toBeTruthy();
  });

  it("shows no badge when nothing is unread", () => {
    render(<GlobalNav unreadCount={0} />);

    const bell = screen.getByRole("link", { name: "Notifications" });
    expect(bell.textContent).toBe("");
  });

  it("points signed-out users at sign-in instead of notifications", () => {
    render(<GlobalNav unreadCount={0} />);

    expect(screen.getByRole("link", { name: "Notifications" }).getAttribute("href")).toBe(
      "/signin",
    );
  });
});

describe("GlobalNav avatar", () => {
  it("links to /signin with a guest glyph when signed out", () => {
    render(<GlobalNav />);

    const avatar = screen.getByRole("link", { name: "Sign in" });
    expect(avatar.getAttribute("href")).toBe("/signin");
    expect(avatar.textContent).toBe("");
  });

  it("shows initials and links to /me when signed in", () => {
    render(<GlobalNav signedIn displayName="Mei Zhang" />);

    const avatar = screen.getByRole("link", { name: "Your dashboard" });
    expect(avatar.getAttribute("href")).toBe("/me");
    expect(avatar.textContent).toBe("MZ");
  });

  it("falls back to the person glyph without a display name", () => {
    render(<GlobalNav signedIn />);

    const avatar = screen.getByRole("link", { name: "Your dashboard" });
    expect(avatar.textContent).toBe("");
  });

  it("derives sign-in from the shared token store after mount", async () => {
    // The access token lives in memory only; seed the shared store directly.
    tokenStore.set({ accessToken: "token" });
    render(<GlobalNav />);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Your dashboard" }),
      ).toBeTruthy(),
    );
  });
});

/* ---------------------------------------------------------------------------
   Mobile tab bar
   ------------------------------------------------------------------------- */

describe("GlobalNav mobile tab bar", () => {
  it("is a bottom bar with Home, Search, Submit, Inbox and Me under 640px", () => {
    render(<GlobalNav signedIn unreadCount={0} />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(bar.className).toContain("gn-tabbar");
    expect(bar.className).toContain("material-chrome");
    expect(bar.className).toContain("flex");
    expect(bar.className).toContain("sm:hidden");

    const expected: Record<string, string> = {
      Home: "/papers",
      Search: "/search",
      Submit: "/submit",
      Inbox: "/me#notifications",
      Me: "/me",
    };
    for (const [name, href] of Object.entries(expected)) {
      const tab = within(bar).getByRole("link", { name });
      expect(tab.getAttribute("href")).toBe(href);
    }
  });

  it("shows the brand tile at 24px on the Home tab", () => {
    render(<GlobalNav />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    const home = within(bar).getByRole("link", { name: "Home" });
    const tile = home.querySelector(".sch-brand-mark") as HTMLElement;

    expect(tile).not.toBeNull();
    expect(tile.getAttribute("data-variant")).toBe("tile");
    expect(tile.style.height).toBe("24px");
    expect(tile.querySelector("svg")).not.toBeNull();
    // Decorative: the visible Home label names the link.
    expect(tile.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(home.textContent).toContain("Home");
  });

  it("marks the current tab, and only that tab", () => {
    pathnameValue = "/search";
    render(<GlobalNav signedIn />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(bar).getByRole("link", { name: "Search" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(bar).getByRole("link", { name: "Home" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(
      within(bar).getByRole("link", { name: "Me" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Home current on /papers, where the logo and the tab both point", () => {
    pathnameValue = "/papers";
    render(<GlobalNav />);

    expect(
      screen.getByRole("link", { name: "Scholium home" }).getAttribute("href"),
    ).toBe("/papers");

    const bar = screen.getByRole("navigation", { name: "Primary" });
    const home = within(bar).getByRole("link", { name: "Home" });
    expect(home.getAttribute("href")).toBe("/papers");
    expect(home.getAttribute("aria-current")).toBe("page");

    // The feed is Home's page, not every other tab's.
    for (const name of ["Search", "Submit", "Me"]) {
      expect(
        within(bar).getByRole("link", { name }).getAttribute("aria-current"),
      ).toBeNull();
    }
  });

  it("leaves Home unmarked on the homepage at /", () => {
    pathnameValue = "/";
    render(<GlobalNav />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(bar).getByRole("link", { name: "Home" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Me current on /me, and Inbox current on /me#notifications", async () => {
    pathnameValue = "/me";
    render(<GlobalNav signedIn />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(bar).getByRole("link", { name: "Me" }).getAttribute("aria-current"),
    ).toBe("page");

    window.location.hash = "#notifications";
    await waitFor(() =>
      expect(
        within(bar).getByRole("link", { name: "Inbox" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(
      within(bar).getByRole("link", { name: "Me" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("points Inbox and Me at sign-in when signed out", () => {
    render(<GlobalNav />);

    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(bar).getByRole("link", { name: "Inbox" }).getAttribute("href"),
    ).toBe("/signin");
    expect(
      within(bar).getByRole("link", { name: "Me" }).getAttribute("href"),
    ).toBe("/signin");
  });
});

/* ---------------------------------------------------------------------------
   Unread-count loading
   ------------------------------------------------------------------------- */

describe("GlobalNav unread loading", () => {
  it("fetches and counts unread notifications when signed in", async () => {
    const loadNotifications = vi.fn(async () => [
      { id: 1, read: false },
      { id: 2, read: false },
      { id: 3, read: true },
      { id: 4 },
    ]);
    render(<GlobalNav signedIn loadNotifications={loadNotifications} />);

    expect(loadNotifications).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Notifications, 3 unread" }),
      ).toBeTruthy(),
    );
  });

  it("does not fetch when the count is provided", () => {
    const loadNotifications = vi.fn();
    render(<GlobalNav unreadCount={0} loadNotifications={loadNotifications} />);

    expect(loadNotifications).not.toHaveBeenCalled();
  });

  it("does not fetch when signed out", () => {
    const loadNotifications = vi.fn();
    render(<GlobalNav signedIn={false} loadNotifications={loadNotifications} />);

    expect(loadNotifications).not.toHaveBeenCalled();
  });

  it("shows no badge when loading fails", async () => {
    const loadNotifications = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<GlobalNav signedIn loadNotifications={loadNotifications} />);

    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Notifications" }).textContent).toBe("");
  });

  it("lowers the badge at once when the notifications card marks a row read", async () => {
    const loadNotifications = vi.fn(async () => [
      { id: 1, read: false },
      { id: 2, read: false },
    ]);
    render(<GlobalNav signedIn loadNotifications={loadNotifications} />);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Notifications, 2 unread" }),
      ).toBeTruthy(),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, {
          detail: { unread: 1 },
        }),
      );
    });

    expect(
      screen.getByRole("link", { name: "Notifications, 1 unread" }),
    ).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, {
          detail: { unread: 0 },
        }),
      );
    });

    expect(screen.getByRole("link", { name: "Notifications" })).toBeTruthy();
  });

  it("ignores an event that carries no unread count", async () => {
    const loadNotifications = vi.fn(async () => [{ id: 1, read: false }]);
    render(<GlobalNav signedIn loadNotifications={loadNotifications} />);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Notifications, 1 unread" }),
      ).toBeTruthy(),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, {
          detail: { unread: "many" },
        }),
      );
    });

    expect(
      screen.getByRole("link", { name: "Notifications, 1 unread" }),
    ).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
   The session ending takes the previous account's badge with it
   ------------------------------------------------------------------------- */

describe("GlobalNav after the session ends", () => {
  const twoUnread = async () => [
    { id: 1, read: false },
    { id: 2, read: false },
  ];

  /** Sign in through the shared store, mount the nav, wait for the badge. */
  async function mountSignedIn(load: () => Promise<unknown>) {
    tokenStore.set({ accessToken: "access-a" });
    render(<GlobalNav loadNotifications={load} />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("link", { name: "Notifications, 2 unread" }),
      ).toHaveLength(1),
    );
  }

  it("drops the badge in the same tick the token store is cleared", async () => {
    await mountSignedIn(twoUnread);

    // No waitFor: the signed-out bell must be there as soon as the session is.
    act(() => {
      tokenStore.clear();
    });

    expect(screen.queryByRole("link", { name: /unread/ })).toBeNull();
    const bell = screen.getByRole("link", { name: "Notifications" });
    expect(bell.getAttribute("href")).toBe("/signin");
    expect(bell.querySelector(".gn-badge")).toBeNull();
    // The Inbox tab of the mobile bar shows the same count.
    expect(document.querySelectorAll(".gn-badge")).toHaveLength(0);
  });

  it("shows the signed-out bell after the Sign out button finishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await mountSignedIn(twoUnread);

    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("link", { name: /unread/ })).toBeNull();
    expect(document.querySelectorAll(".gn-badge")).toHaveLength(0);
  });

  it("does not show the previous account's count to the next account", async () => {
    // The first account's read answers; the next account's read never does.
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(twoUnread)
      .mockImplementation(() => new Promise(() => {}));
    await mountSignedIn(load);
    act(() => {
      tokenStore.clear();
    });

    // The next account signs in on the same document.
    act(() => {
      tokenStore.set({ accessToken: "access-b" });
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("link", { name: /unread/ })).toBeNull();
    expect(document.querySelectorAll(".gn-badge")).toHaveLength(0);
  });

  it("ignores a late notifications-changed event once signed out", async () => {
    await mountSignedIn(twoUnread);
    act(() => {
      tokenStore.clear();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, {
          detail: { unread: 5 },
        }),
      );
    });

    expect(screen.queryByRole("link", { name: /unread/ })).toBeNull();
    expect(document.querySelectorAll(".gn-badge")).toHaveLength(0);
  });

  it("keeps a pinned unreadCount as given", () => {
    render(<GlobalNav signedIn={false} unreadCount={4} />);

    expect(
      screen.getByRole("link", { name: "Notifications, 4 unread" }),
    ).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
   Spacer
   ------------------------------------------------------------------------- */

describe("NavTabBarSpacer", () => {
  it("blocks out the bar height below 640px only", () => {
    const { container } = render(<NavTabBarSpacer />);

    const spacer = container.firstElementChild as HTMLElement;
    expect(spacer.className).toContain("gn-tabbar-spacer");
    expect(spacer.className).toContain("sm:hidden");
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
  });
});

/* ---------------------------------------------------------------------------
   Sign out
   ------------------------------------------------------------------------- */

describe("GlobalNav sign out", () => {
  it("offers the action only to a signed-in visitor", () => {
    render(<GlobalNav />);
    expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(0);

    cleanup();
    render(<GlobalNav signedIn />);
    // One in the desktop header, one in the mobile tab bar; CSS hides the
    // half that does not apply at the current width.
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(2);
  });

  it("revokes the session, clears the token and goes home", async () => {
    tokenStore.set({ accessToken: "access-1" });
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GlobalNav signedIn unreadCount={0} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(tokenStore.isAuthenticated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer access-1",
    );
  });

  it("lands at the top of the homepage rather than keeping the old scroll", async () => {
    tokenStore.set({ accessToken: "access-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const scrollTo = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => undefined);

    render(<GlobalNav signedIn unreadCount={0} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockRestore();
  });
});

/* ---------------------------------------------------------------------------
   HomeNav on a fresh load of the homepage

   The homepage makes no API call, so its bar cannot restore the session. It
   reads the non-secret signed-in hint the session layer keeps in localStorage
   instead, and still fetches nothing.
   ------------------------------------------------------------------------- */

describe("HomeNav on a fresh load of the homepage", () => {
  it("shows the signed-in actions from the hint without asking the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(SIGNED_IN_HINT_STORAGE_KEY, "1");

    render(<HomeNav />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Your dashboard" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("link", { name: "Browse papers" }).getAttribute("href"),
    ).toBe("/papers");
    expect(screen.getByRole("link", { name: "Your dashboard" }).getAttribute("href")).toBe(
      "/me",
    );
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Submit a paper" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the signed-out actions when the browser holds no hint", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<HomeNav />);

    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin",
    );
    expect(
      screen.getByRole("link", { name: "Submit a paper" }).getAttribute("href"),
    ).toBe("/submit");
    expect(screen.queryByRole("link", { name: "Your dashboard" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------
   Stylesheet contract
   ------------------------------------------------------------------------- */

describe("nav.css brand contract", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "nav.css"),
    "utf8",
  );

  it("gives the logo link a 2px accent keyboard focus ring", () => {
    const rule = /\.gn-brand:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("outline: 2px solid var(--accent)");
    expect(rule).toContain("outline-offset: 2px");
  });

  it("keeps the 64px desktop header height", () => {
    const rule = /\.gn-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("height: 64px");
  });

  it("does not style the removed text-only wordmark", () => {
    expect(css).not.toMatch(/\.gn-wordmark\b/);
  });
});
