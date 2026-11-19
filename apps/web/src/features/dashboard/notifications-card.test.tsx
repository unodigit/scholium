// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";

import { NotificationsCard } from "./notifications-card";
import { NOTIFICATIONS_CHANGED_EVENT, type NotificationItem } from "./dashboard";

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

/** A parsed row, the way `loadNotifications` hands it to the card. */
function row(overrides: Partial<NotificationItem> & Pick<NotificationItem, "id">): NotificationItem {
  return {
    did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
    kind: "consent.request",
    payload: {},
    read: false,
    ...overrides,
  };
}

const CONSENT = row({
  id: 1,
  kind: "consent.request",
  payload: { version_cid: "bafy-version-1", paper_cid: "bafy-genesis-1", n: 1 },
});
const RECOVERY = row({
  id: 2,
  kind: "recovery.request",
  payload: { request_id: "rr-9", account_did: "did:key:z6MkAlice", requested_at: "2026-11-16T10:00:00Z" },
});
const MODERATION = row({
  id: 3,
  kind: "moderation.decision",
  read: true,
  payload: { decision_cid: "bafy-decision-1", target_cid: "bafy-version-1", action: "hold", reason: "Needs a licence." },
});

/** The API serves oldest first; the card shows newest first. */
const loaderOf = (...rows: NotificationItem[]) => vi.fn().mockResolvedValue(rows);

const items = () => screen.getAllByRole("listitem");

describe("NotificationsCard: what it shows", () => {
  it("is the Notifications card that /me#notifications lands on", async () => {
    const { container } = render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT)} />);
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(container.querySelector("section#notifications")).not.toBeNull();
    await screen.findByText(/co-author consent/i);
  });

  it("loads the viewer's notifications instead of a hard-coded empty state", async () => {
    const load = loaderOf(CONSENT, RECOVERY, MODERATION);
    render(<NotificationsCard signedIn loadNotifications={load} />);

    await screen.findAllByRole("listitem");
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No notifications yet.")).toBeNull();
    expect(items()).toHaveLength(3);
  });

  it("lists newest first, each with its kind label and a human summary", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT, RECOVERY, MODERATION)} />);
    await screen.findAllByRole("listitem");

    const [first, second, third] = items();
    expect(within(first).getByText("Moderation outcome")).toBeTruthy();
    expect(within(first).getByText(/paper on hold/i)).toBeTruthy();
    expect(within(second).getByText("Recovery approval")).toBeTruthy();
    expect(within(second).getByText(/guardian/i)).toBeTruthy();
    expect(within(third).getByText("Consent request")).toBeTruthy();
    expect(within(third).getByText(/co-author consent/i)).toBeTruthy();
  });

  it("links each open notification to the screen that deals with it", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT, RECOVERY, MODERATION)} />);
    await screen.findAllByRole("listitem");

    const [read, second, third] = items();
    // An answered notification is history and offers nothing to open.
    expect(within(read).queryByRole("link", { name: /open/i })).toBeNull();
    expect(within(second).getByRole("link", { name: /open/i }).getAttribute("href")).toBe("/me/recovery/rr-9");
    expect(within(third).getByRole("link", { name: /open/i }).getAttribute("href")).toBe("/consent/bafy-version-1");
  });

  it("renders the kind label once, and names each action with it", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT)} />);
    const item = (await screen.findAllByRole("listitem"))[0]!;

    // One visible chip; the label is not repeated in the row's text.
    expect(within(item).getAllByText("Consent request")).toHaveLength(1);
    // The bare action words are disambiguated for assistive tech.
    expect(
      within(item).getByRole("link", { name: "Open consent request" }),
    ).toBeTruthy();
    expect(
      within(item).getByRole("button", { name: "Mark as read consent request" }),
    ).toBeTruthy();
  });

  it("marks unread rows with the word Unread, never colour alone, and leaves read rows plain", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT, MODERATION)} />);
    await screen.findAllByRole("listitem");

    const [read, unread] = items();
    expect(within(unread).getByText("Unread")).toBeTruthy();
    expect(unread.getAttribute("data-read")).toBe("false");
    expect(within(read).queryByText("Unread")).toBeNull();
    expect(read.getAttribute("data-read")).toBe("true");
  });

  it("shows when a notification happened, from its payload, as a <time>", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(RECOVERY)} />);
    await screen.findAllByRole("listitem");

    const time = items()[0].querySelector("time");
    expect(time).not.toBeNull();
    expect(time?.getAttribute("datetime")).toBe("2026-11-16T10:00:00Z");
    expect(time?.textContent).toMatch(/ago|just now|\d{4}/);
  });

  it("falls back to the kind for a notification it has no wording for", async () => {
    render(
      <NotificationsCard
        signedIn
        loadNotifications={loaderOf(row({ id: 4, kind: "something.new", payload: { summary: "Heads up" } }))}
      />,
    );
    const item = (await screen.findAllByRole("listitem"))[0];
    expect(within(item).getByText("Something new")).toBeTruthy();
    expect(within(item).getByText("Heads up")).toBeTruthy();
  });

  it("rewords an answered notification in the past tense and drops its Open link", async () => {
    render(
      <NotificationsCard
        signedIn
        loadNotifications={loaderOf(
          row({
            id: 6,
            kind: "consent.request",
            read: true,
            payload: { version_cid: "bafy-version-1", n: 2, title: "Sparse attention" },
          }),
        )}
      />,
    );
    const item = (await screen.findAllByRole("listitem"))[0];

    expect(within(item).getByText(/You signed your consent/)).toBeTruthy();
    expect(within(item).queryByText(/waiting for your signature/)).toBeNull();
    expect(within(item).queryByRole("link", { name: /open/i })).toBeNull();
  });

  it("does not repeat on a second line a reason the sentence already carries", async () => {
    const sentence =
      'The post you reported as "Off topic" on "Sparse attention" was reviewed and kept. Moderator\'s note: The post is on topic.';
    render(
      <NotificationsCard
        signedIn
        loadNotifications={loaderOf(
          row({
            id: 8,
            kind: "flag.outcome",
            payload: { summary: sentence, outcome: sentence, reason: "Off topic", reason_code: "off-topic" },
          }),
        )}
      />,
    );
    const item = (await screen.findAllByRole("listitem"))[0];

    expect(within(item).getByText(sentence)).toBeTruthy();
    expect(within(item).queryByText("Off topic")).toBeNull();
    expect(item.textContent?.match(/Off topic/g)).toHaveLength(1);
  });

  it("states the decision in a report outcome notice that carries no sentence", async () => {
    // The API sends the reporter `flag.outcome`; without a summary the notice
    // must still say what was decided, not fall back to the kind's own words.
    render(
      <NotificationsCard
        signedIn
        loadNotifications={loaderOf(
          row({ id: 9, kind: "flag.outcome", payload: { status: "upheld" } }),
        )}
      />,
    );
    const item = (await screen.findAllByRole("listitem"))[0];

    expect(within(item).getByText(/upheld/i)).toBeTruthy();
    expect(within(item).queryByText("Flag outcome")).toBeNull();
  });

  it("still shows a reason the sentence leaves out", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(MODERATION)} />);
    const item = (await screen.findAllByRole("listitem"))[0];

    expect(within(item).getByText("Needs a licence.")).toBeTruthy();
  });

  it("never turns a link it does not trust into an href", async () => {
    render(
      <NotificationsCard
        signedIn
        loadNotifications={loaderOf(
          row({ id: 5, kind: "something.new", payload: { link: "javascript:alert(1)" } }),
        )}
      />,
    );
    const item = (await screen.findAllByRole("listitem"))[0];
    expect(within(item).queryByRole("link")).toBeNull();
  });
});

describe("NotificationsCard: empty, loading, error", () => {
  it("shows the empty state only when the API returned nothing", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf()} />);
    expect(await screen.findByText("No notifications yet.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("says it is loading before the answer, not 'No notifications yet'", async () => {
    render(<NotificationsCard signedIn loadNotifications={() => new Promise(() => {})} />);
    expect(screen.getByText("Loading your notifications…")).toBeTruthy();
    expect(screen.queryByText("No notifications yet.")).toBeNull();
  });

  it("shows a retryable error, and retrying loads the list", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("/v1/me/notifications"))
      .mockResolvedValueOnce([CONSENT]);
    render(<NotificationsCard signedIn loadNotifications={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not reach the API");
    expect(screen.queryByText("No notifications yet.")).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await screen.findAllByRole("listitem");
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the API's own problem detail when it refuses", async () => {
    const load = vi.fn().mockRejectedValue(new ApiError(401, { detail: "Sign in to read your notifications." }));
    render(<NotificationsCard signedIn loadNotifications={load} />);
    expect(await screen.findByText("Sign in to read your notifications.")).toBeTruthy();
  });

  it("does not call the API when nobody is signed in", () => {
    const load = loaderOf(CONSENT);
    render(<NotificationsCard signedIn={false} loadNotifications={load} />);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("NotificationsCard: marking read", () => {
  it("marks one read through the API, drops its Unread word and tells the bell the new count", async () => {
    const mark = vi.fn().mockResolvedValue(undefined);
    const heard: number[] = [];
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, (event) => {
      heard.push((event as CustomEvent<{ unread: number }>).detail.unread);
    });

    render(
      <NotificationsCard signedIn loadNotifications={loaderOf(CONSENT, RECOVERY)} markNotificationRead={mark} />,
    );
    await screen.findAllByRole("listitem");
    expect(screen.getAllByText("Unread")).toHaveLength(2);

    // Newest first: RECOVERY (id 2) is the top row.
    fireEvent.click(within(items()[0]).getByRole("button", { name: /mark as read/i }));

    await waitFor(() => expect(screen.getAllByText("Unread")).toHaveLength(1));
    expect(mark).toHaveBeenCalledWith(2);
    expect(items()[0].getAttribute("data-read")).toBe("true");
    expect(within(items()[0]).queryByRole("button", { name: /mark as read/i })).toBeNull();
    expect(heard).toEqual([1]);
  });

  it("opening a notification marks it read, and keeps the link so the browser still goes there", async () => {
    const mark = vi.fn().mockResolvedValue(undefined);
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT)} markNotificationRead={mark} />);
    await screen.findAllByRole("listitem");

    const open = within(items()[0]).getByRole("link", { name: /open/i });
    // jsdom cannot navigate; stop the default so only the handler is observed.
    open.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(open);

    expect(mark).toHaveBeenCalledWith(1);
    expect(open.getAttribute("href")).toBe("/consent/bafy-version-1");
    await waitFor(() => expect(screen.queryByText("Unread")).toBeNull());
  });

  it("offers nothing to do for a notification that is already read", async () => {
    const mark = vi.fn().mockResolvedValue(undefined);
    render(<NotificationsCard signedIn loadNotifications={loaderOf(MODERATION)} markNotificationRead={mark} />);
    await screen.findAllByRole("listitem");

    expect(mark).not.toHaveBeenCalled();
    expect(within(items()[0]).queryByRole("link", { name: /open/i })).toBeNull();
    expect(within(items()[0]).queryByRole("button", { name: /mark as read/i })).toBeNull();
  });

  it("keeps the row unread and says why when the API refuses", async () => {
    const mark = vi.fn().mockRejectedValue(new ApiError(404, { detail: "There is no notification 1 for this account." }));
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT)} markNotificationRead={mark} />);
    await screen.findAllByRole("listitem");

    fireEvent.click(within(items()[0]).getByRole("button", { name: /mark as read/i }));

    expect(await within(items()[0]).findByRole("alert")).toBeTruthy();
    expect(within(items()[0]).getByText("There is no notification 1 for this account.")).toBeTruthy();
    expect(within(items()[0]).getByText("Unread")).toBeTruthy();
  });
});

describe("NotificationsCard: long lists", () => {
  const many = Array.from({ length: 25 }, (_, index) => row({ id: index + 1, read: true }));

  it("caps the list and reveals more on request, newest first", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(...many)} />);
    await screen.findAllByRole("listitem");

    expect(items()).toHaveLength(10);
    // Row 25 is the newest, so its consent link is on top.
    const more = screen.getByRole("button", { name: /show more/i });
    expect(more.textContent).toMatch(/15/);

    act(() => {
      fireEvent.click(more);
    });
    expect(items()).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(items()).toHaveLength(25);
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("offers no Show more when everything already fits", async () => {
    render(<NotificationsCard signedIn loadNotifications={loaderOf(CONSENT, RECOVERY)} />);
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });
});
