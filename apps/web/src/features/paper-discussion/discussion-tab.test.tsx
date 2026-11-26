// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError } from "../web-auth/errors";
import type { SignedRecord } from "../web-auth/sign-record";
import { ANNOTATION_CREATED_EVENT } from "./annotations";
import { DiscussionTab, type DiscussionActions } from "./discussion-tab";
import {
  authorLabel,
  type DiscussionData,
  type DiscussionPost,
  type LoadThreads,
  type PostAccepted,
} from "./discussion";

const SHORT = "sch:6sel-2dio-orm6";
const ALICE = "did:key:z6MkaliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "did:key:z6MkbobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ME = "did:key:z6MkmeMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";

/** What the reader's own clock calls the day an instant fell on. */
function localDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function post(cid: string, overrides: Partial<DiscussionPost> = {}): DiscussionPost {
  return {
    cid,
    author: ALICE,
    authorName: null,
    text: `Text of ${cid}.`,
    createdAt: "2026-01-01T00:00:00Z",
    helpful: 0,
    parent: null,
    target: "bafyrei-v1",
    quote: null,
    seq: null,
    replies: [],
    ...overrides,
  };
}

/** Deliberately in the wrong order: the tab must sort. Five posts in all. */
function threads(): DiscussionData {
  return {
    paper: SHORT,
    paperCid: "bafyrei-genesis",
    threads: [
      post("quiet", { helpful: 0, createdAt: "2026-01-01T00:00:00Z" }),
      post("loud", {
        helpful: 3,
        author: BOB,
        createdAt: "2026-01-05T00:00:00Z",
        replies: [
          post("reply-low", { parent: "loud", helpful: 0, createdAt: "2026-01-06T00:00:00Z" }),
          post("reply-high", { parent: "loud", helpful: 2, createdAt: "2026-01-07T00:00:00Z" }),
        ],
      }),
      post("middle", { helpful: 1, createdAt: "2026-01-03T00:00:00Z" }),
    ],
  };
}

function signedRecord(type: string, body: Record<string, unknown>, prev: string | null): SignedRecord {
  return {
    v: 1,
    type,
    id: "bafyrei-new",
    author: ME,
    created: "2026-02-01T10:00:00Z",
    prev,
    body,
    proofs: [],
    sig: "c2ln",
  };
}

function problem(status: number, detail = "Refused."): ApiError {
  return new ApiError(status, { type: "about:blank", title: "Problem", status, detail });
}

/** Fakes for every seam, and the calls they saw. */
function seams(overrides: Partial<DiscussionActions> = {}) {
  const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
    signedRecord(type, body, prev),
  );
  const submit = vi.fn(
    async (_paperId: string, _record: SignedRecord): Promise<PostAccepted> => ({
      post_cid: "bafyrei-new",
    }),
  );
  const markHelpful = vi.fn(async (_cid: string): Promise<number | null> => null);
  const report = vi.fn(async (_cid: string, _reason: string) => ({ flagId: "flag-1" }));
  const actions: DiscussionActions = { sign, submit, markHelpful, report, ...overrides } as DiscussionActions;
  return { sign, submit, markHelpful, report, actions };
}

function renderTab(
  props: Partial<React.ComponentProps<typeof DiscussionTab>> = {},
  data: DiscussionData | undefined = threads(),
) {
  return render(
    <DiscussionTab paperId={SHORT} initial={data} signedIn {...props} />,
  );
}

function rootOrder(): string[] {
  const list = screen.getByRole("list", { name: /Threads, most helpful first/i });
  return [...list.children].map((li) => li.getAttribute("data-post") ?? "");
}

function repliesOrder(cid: string): string[] {
  const item = document.querySelector(`li[data-post="${cid}"]`);
  const list = item?.querySelector(":scope > ol");
  return list === null || list === undefined
    ? []
    : [...list.children].map((li) => li.getAttribute("data-post") ?? "");
}

/** The post's own card, not the replies nested under it. */
function card(cid: string): HTMLElement {
  const item = document.querySelector(`li[data-post="${cid}"]`);
  const el = item?.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error(`No post ${cid} on the page`);
  return el;
}

function typeInto(textarea: HTMLElement, value: string): void {
  fireEvent.change(textarea, { target: { value } });
}

/** Stand-in for `window.location` at an address; records `assign`. */
let assign: ReturnType<typeof vi.fn>;

function stubLocation(address: string): void {
  const { pathname, search, hash, origin } = new URL(address, "http://localhost");
  assign = vi.fn();
  vi.stubGlobal("location", { pathname, search, hash, origin, assign });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiscussionTab: order", () => {
  it("shows threads most helpful first, whatever order they arrive in", () => {
    renderTab();
    expect(rootOrder()).toEqual(["loud", "middle", "quiet"]);
  });

  it("orders replies the same way: most helpful first", () => {
    renderTab();
    expect(repliesOrder("loud")).toEqual(["reply-high", "reply-low"]);
  });

  it("breaks a tie on helpful with the oldest first", () => {
    renderTab({}, {
      ...threads(),
      threads: [
        post("new", { helpful: 2, createdAt: "2026-03-01T00:00:00Z" }),
        post("old", { helpful: 2, createdAt: "2026-01-01T00:00:00Z" }),
      ],
    });
    expect(rootOrder()).toEqual(["old", "new"]);
  });

  it("says how many posts there are, replies included, and how they are ordered", () => {
    renderTab();
    expect(screen.getByText("5 posts · most helpful first")).toBeTruthy();
  });

  it("names the list so a screen-reader user hears the order", () => {
    renderTab();
    expect(screen.getByRole("list", { name: "Threads, most helpful first" })).toBeTruthy();
    expect(screen.getByRole("list", { name: /Replies to the post by/ })).toBeTruthy();
  });
});

describe("DiscussionTab: what a post shows", () => {
  it("shows the author, the date, the text and how many found it helpful", () => {
    renderTab();
    const loud = within(card("loud"));
    expect(loud.getByText(authorLabel(BOB))).toBeTruthy();
    expect(loud.getByText("5 Jan 2026")).toBeTruthy();
    expect(loud.getByText("Text of loud.")).toBeTruthy();
    expect(loud.getByText("3 members found this helpful")).toBeTruthy();
    // The full time is on hover and in the machine-readable attribute.
    const time = card("loud").querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-01-05T00:00:00Z");
    expect(time?.getAttribute("title")).toBe("5 Jan 2026 00:00 UTC");
  });

  it("shows a post's time in the reader's zone, with the UTC instant on hover", () => {
    // 00:45 on 18 Nov in AEDT is still 17 Nov in UTC: the post was written on
    // the reader's 18th and must say so (bug_spec_verify6).
    const createdAt = "2026-11-17T13:45:00Z";
    renderTab({}, {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [post("near-midnight", { createdAt })],
    });

    const time = document.querySelector('li[data-post="near-midnight"] time');
    expect(time?.textContent).toBe(localDate(createdAt));
    expect(time?.getAttribute("datetime")).toBe(createdAt);
    expect(time?.getAttribute("title")).toBe("17 Nov 2026 13:45 UTC");
  });

  it("does not print 'No helpful marks yet' under every post", () => {
    renderTab();
    expect(within(card("quiet")).queryByText(/helpful/i, { selector: "p" })).toBeNull();
  });

  it("shows the full DID on hover, not the shortened one only", () => {
    renderTab();
    expect(within(card("loud")).getByText(authorLabel(BOB)).getAttribute("title")).toBe(BOB);
  });

  it("credits a post to the author's profile name, linked to their profile, when there is one", () => {
    renderTab({}, {
      ...threads(),
      threads: [post("named", { author: BOB, authorName: "Sam Rivera" })],
    });
    const link = within(card("named")).getByRole("link", { name: "Sam Rivera" });
    expect(link.getAttribute("href")).toBe(`/u/${encodeURIComponent(BOB)}`);
    // The DID is still there, on hover, so a reader can check who it is.
    expect(link.getAttribute("title")).toBe(BOB);
    // Every action is named after what the reader sees.
    expect(
      within(card("named")).getByRole("button", { name: "Report post by Sam Rivera" }),
    ).toBeTruthy();
  });

  it("falls back to the short DID for a member with no profile name", () => {
    renderTab({}, { ...threads(), threads: [post("nameless", { author: BOB })] });
    expect(within(card("nameless")).getByText(authorLabel(BOB))).toBeTruthy();
    expect(within(card("nameless")).queryByRole("link")).toBeNull();
  });

  it("shows the poster's own name on the post just made, when the server says it", async () => {
    const { submit, actions } = seams();
    submit.mockResolvedValueOnce({ post_cid: "bafyrei-new", author_name: "Sam Rivera" });
    renderTab({ actions });
    fireEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    typeInto(screen.getByLabelText("Start a thread"), "A new question.");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));

    await waitFor(() => expect(rootOrder()).toContain("bafyrei-new"));
    const link = within(card("bafyrei-new")).getByRole("link", { name: "Sam Rivera" });
    expect(link.getAttribute("href")).toBe(`/u/${encodeURIComponent(ME)}`);
  });

  it("shows the passage an annotation quotes", () => {
    renderTab({}, {
      ...threads(),
      threads: [post("ann", { quote: "the quoted passage", text: "Check this step." })],
    });
    const quote = card("ann").querySelector("blockquote");
    expect(quote?.textContent).toContain("“the quoted passage”");
    expect(quote?.textContent).toContain("Annotation on the passage");
  });

  it("keeps a reader's line breaks and renders text as text, never as HTML", () => {
    renderTab({}, {
      ...threads(),
      threads: [post("md", { text: "line one\nline two <img src=x onerror=alert(1)> **not bold**" })],
    });
    const text = card("md").querySelector(".pd-post__text");
    expect(text?.textContent).toBe("line one\nline two <img src=x onerror=alert(1)> **not bold**");
    expect(text?.querySelector("img")).toBeNull();
    expect(text?.querySelector("strong")).toBeNull();
  });

  it("says so when the text is held elsewhere, rather than showing a blank post", () => {
    renderTab({}, { ...threads(), threads: [post("far", { text: null })] });
    expect(within(card("far")).getByText(/text of this post is not available/i)).toBeTruthy();
  });

  it("calls an author with no id 'Unknown author'", () => {
    renderTab({}, { ...threads(), threads: [post("anon", { author: "" })] });
    expect(within(card("anon")).getByText("Unknown author")).toBeTruthy();
  });

  it("shows an empty discussion as one sentence and one action", () => {
    renderTab({}, { ...threads(), threads: [] });
    expect(screen.getByText(/No discussion yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a thread" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: /Threads/ })).toBeNull();
  });
});

describe("DiscussionTab: a reply form and a Report action on every post", () => {
  it("gives every post, replies included, a Reply button and a Report button", () => {
    renderTab();
    const cids = ["quiet", "loud", "middle", "reply-low", "reply-high"];
    for (const cid of cids) {
      const scope = within(card(cid));
      expect(scope.getByRole("button", { name: /^Reply to post by/ }), `reply on ${cid}`).toBeTruthy();
      expect(scope.getByRole("button", { name: /^Report post by/ }), `report on ${cid}`).toBeTruthy();
    }
    expect(document.querySelectorAll('[data-action="reply"]')).toHaveLength(cids.length);
    expect(document.querySelectorAll('[data-action="report"]')).toHaveLength(cids.length);
  });

  it("puts the author in each button's name, so twenty Reports are not twenty identical buttons", () => {
    renderTab();
    expect(
      within(card("loud")).getByRole("button", { name: `Report post by ${authorLabel(BOB)}` }),
    ).toBeTruthy();
    expect(
      within(card("quiet")).getByRole("button", { name: `Reply to post by ${authorLabel(ALICE)}` }),
    ).toBeTruthy();
  });

  it("shows Reply and Report even when signed out: the action is always there", () => {
    renderTab({ signedIn: false });
    expect(document.querySelectorAll('[data-action="reply"]')).toHaveLength(5);
    expect(document.querySelectorAll('[data-action="report"]')).toHaveLength(5);
  });

  it("opens a reply form under the post, and closes it again", () => {
    renderTab();
    const reply = within(card("middle")).getByRole("button", { name: /^Reply to post by/ });
    expect(reply.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(reply);
    expect(reply.getAttribute("aria-expanded")).toBe("true");
    const form = within(card("middle")).getByLabelText(/^Your reply to the post by/);
    expect(form.tagName).toBe("TEXTAREA");
    expect(document.activeElement).toBe(form);
    expect(reply.getAttribute("aria-controls")).toBe(form.closest(".pd-panel")?.id);

    fireEvent.click(within(card("middle")).getByRole("button", { name: "Cancel" }));
    expect(within(card("middle")).queryByLabelText(/^Your reply/)).toBeNull();
    expect(reply.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(reply);
  });

  it("opens one panel at a time on a post: Report replaces Reply", () => {
    renderTab();
    const scope = within(card("middle"));
    fireEvent.click(scope.getByRole("button", { name: /^Reply to post by/ }));
    fireEvent.click(scope.getByRole("button", { name: /^Report post by/ }));
    expect(scope.queryByLabelText(/^Your reply/)).toBeNull();
    expect(scope.getByRole("group", { name: /Why are you reporting/ })).toBeTruthy();
  });
});

describe("DiscussionTab: replying", () => {
  async function reply(cid: string, text: string): Promise<void> {
    fireEvent.click(within(card(cid)).getByRole("button", { name: /^Reply to post by/ }));
    typeInto(within(card(cid)).getByLabelText(/^Your reply/), text);
    fireEvent.click(within(card(cid)).getByRole("button", { name: "Sign and submit" }));
  }

  it("signs a discussion.post that names the parent, submits it, and shows the reply at once", async () => {
    const { sign, submit, actions } = seams();
    renderTab({ actions });

    await reply("loud", "  Thanks, that helps.  ");

    await waitFor(() => expect(repliesOrder("loud")).toContain("bafyrei-new"));
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(
      "discussion.post",
      { target: "bafyrei-v1", anchor: "bafyrei-v1", text: "Thanks, that helps.", parent: "loud" },
      null,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe(SHORT);
    expect(submit.mock.calls[0][1]).toMatchObject({ type: "discussion.post", id: "bafyrei-new" });

    const mine = within(card("bafyrei-new"));
    expect(mine.getByText("Thanks, that helps.")).toBeTruthy();
    expect(mine.getByText(authorLabel(ME))).toBeTruthy();
    // 5 posts before, 6 now.
    expect(screen.getByText("6 posts · most helpful first")).toBeTruthy();
  });

  it("closes the form and puts focus back on Reply once the reply is in", async () => {
    const { actions } = seams();
    renderTab({ actions });
    await reply("loud", "Thanks.");

    await waitFor(() => expect(within(card("loud")).queryByLabelText(/^Your reply/)).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card("loud")).getByRole("button", { name: /^Reply to post by/ }),
      ),
    );
  });

  it("announces the reply to assistive technology", async () => {
    const { actions } = seams();
    renderTab({ actions });
    await reply("loud", "Thanks.");
    await waitFor(() =>
      expect(document.querySelector("[data-announcement]")?.textContent).toBe("Your reply was posted."),
    );
  });

  it("attaches a reply to what its parent is about, not to whatever version the page shows", async () => {
    const { sign, actions } = seams();
    renderTab(
      { actions, versionCid: "bafyrei-v9" },
      { ...threads(), threads: [post("old-thread", { target: "bafyrei-v1" })] },
    );
    await reply("old-thread", "Still true in v9?");
    await waitFor(() => expect(sign).toHaveBeenCalled());
    expect(sign.mock.calls[0][1]).toMatchObject({ target: "bafyrei-v1" });
  });

  it("asks for words before it asks for a passkey", async () => {
    const { sign, actions } = seams();
    renderTab({ actions });
    fireEvent.click(within(card("loud")).getByRole("button", { name: /^Reply to post by/ }));
    typeInto(within(card("loud")).getByLabelText(/^Your reply/), "   ");
    fireEvent.click(within(card("loud")).getByRole("button", { name: "Sign and submit" }));

    expect((await within(card("loud")).findByRole("alert")).textContent).toMatch(/Write something/);
    expect(sign).not.toHaveBeenCalled();
    const field = within(card("loud")).getByLabelText(/^Your reply/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
  });

  it("tells a reader a post is too long, in words, and does not sign it", async () => {
    const { sign, actions } = seams();
    renderTab({ actions });
    await reply("loud", "x".repeat(4001));
    expect((await within(card("loud")).findByRole("alert")).textContent).toBe(
      "This post is 1 character over the 4,000 limit.",
    );
    expect(sign).not.toHaveBeenCalled();
    // The counter shows it too.
    expect(within(card("loud")).getByText("4,001 / 4,000").getAttribute("data-over")).toBe("true");
  });

  it("keeps what the reader typed when the server refuses, and says why", async () => {
    const { submit, actions } = seams();
    submit.mockRejectedValueOnce(problem(403));
    renderTab({ actions });
    await reply("loud", "My careful reply.");

    const alert = await within(card("loud")).findByRole("alert");
    expect(alert.textContent).toMatch(/tier 1/);
    expect(alert.textContent).toMatch(/Nothing was sent/);
    expect((within(card("loud")).getByLabelText(/^Your reply/) as HTMLTextAreaElement).value).toBe(
      "My careful reply.",
    );
    // Nothing was added to the thread.
    expect(repliesOrder("loud")).toEqual(["reply-high", "reply-low"]);
  });

  it("treats a dismissed passkey prompt as a choice, and lets the reader try again", async () => {
    const { sign, actions } = seams();
    sign.mockRejectedValueOnce(new PasskeyCancelledError());
    renderTab({ actions });
    await reply("loud", "Thanks.");

    expect((await within(card("loud")).findByRole("alert")).textContent).toMatch(/Signing was cancelled/);
    fireEvent.click(within(card("loud")).getByRole("button", { name: "Sign and submit" }));
    await waitFor(() => expect(repliesOrder("loud")).toContain("bafyrei-new"));
  });

  it("offers to sign in again when the session has ended", async () => {
    const { submit, actions } = seams();
    submit.mockRejectedValueOnce(problem(401));
    renderTab({ actions });
    await reply("loud", "Thanks.");

    const alert = await within(card("loud")).findByRole("alert");
    expect(alert.textContent).toMatch(/session has ended/);
    expect(within(alert).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fp%2F6sel-2dio-orm6",
    );
  });

  it("says plainly when the server cannot be reached", async () => {
    const { submit, actions } = seams();
    submit.mockRejectedValueOnce(new NetworkError("http://api"));
    renderTab({ actions });
    await reply("loud", "Thanks.");
    expect((await within(card("loud")).findByRole("alert")).textContent).toMatch(/reach the server/);
  });

  it("disables the form while the passkey prompt is open, so one tap cannot post twice", async () => {
    let finish: (record: SignedRecord) => void = () => undefined;
    const { sign, submit, actions } = seams();
    sign.mockImplementationOnce(
      (type, body, prev) => new Promise<SignedRecord>((resolve) => (finish = () => resolve(signedRecord(type, body, prev)))),
    );
    renderTab({ actions });
    await reply("loud", "Thanks.");

    const button = await within(card("loud")).findByRole("button", { name: "Waiting for your passkey…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((within(card("loud")).getByLabelText(/^Your reply/) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(sign).toHaveBeenCalledTimes(1);

    await act(async () => finish(signedRecord("discussion.post", {}, null)));
    await waitFor(() => expect(repliesOrder("loud")).toContain("bafyrei-new"));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("explains what signing means, in the words of the design", () => {
    renderTab();
    fireEvent.click(within(card("loud")).getByRole("button", { name: /^Reply to post by/ }));
    expect(
      within(card("loud")).getByText("You’re signing with your passkey. Scholium never sees your key."),
    ).toBeTruthy();
  });

  it("describes the textarea with the count and the hint", () => {
    renderTab();
    fireEvent.click(within(card("loud")).getByRole("button", { name: /^Reply to post by/ }));
    const field = within(card("loud")).getByLabelText(/^Your reply/);
    const described = (field.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described.length).toBeGreaterThanOrEqual(2);
    for (const id of described) expect(document.getElementById(id), id).not.toBeNull();
  });

  it("does not crash if a reply is posted after the form was dismissed mid-flight", async () => {
    let finish: (record: SignedRecord) => void = () => undefined;
    const { sign, actions } = seams();
    sign.mockImplementationOnce(
      (type, body, prev) => new Promise<SignedRecord>((resolve) => (finish = () => resolve(signedRecord(type, body, prev)))),
    );
    renderTab({ actions });
    await reply("loud", "Thanks.");
    await within(card("loud")).findByRole("button", { name: "Waiting for your passkey…" });

    // Cancel is disabled while waiting, so the host unmounts the whole tab instead.
    cleanup();
    await act(async () => finish(signedRecord("discussion.post", {}, null)));
  });
});

describe("DiscussionTab: starting a thread", () => {
  async function start(text: string): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    typeInto(screen.getByLabelText("Start a thread"), text);
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
  }

  it("attaches a new thread to the version the page is showing", async () => {
    const { sign, actions } = seams();
    renderTab({ actions, versionCid: "bafyrei-v2" });
    await start("A new question.");
    await waitFor(() => expect(sign).toHaveBeenCalled());
    expect(sign).toHaveBeenCalledWith(
      "discussion.post",
      { target: "bafyrei-v2", anchor: "bafyrei-v2", text: "A new question.", parent: null },
      null,
    );
  });

  it("attaches it to the paper itself when no version is given", async () => {
    const { sign, actions } = seams();
    renderTab({ actions });
    await start("A general question.");
    await waitFor(() => expect(sign).toHaveBeenCalled());
    expect(sign.mock.calls[0][1]).toMatchObject({ target: "bafyrei-genesis", parent: null });
  });

  it("says so, and signs nothing, when there is nothing to attach a post to", async () => {
    const { sign, actions } = seams();
    renderTab({ actions }, { paper: SHORT, paperCid: null, threads: [] });
    await start("Hello?");
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not say which paper record/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("puts the new thread where its (zero) helpful marks and time place it, and shows it at once", async () => {
    const { actions } = seams();
    renderTab({ actions });
    await start("A new question.");

    await waitFor(() => expect(rootOrder()).toContain("bafyrei-new"));
    // loud (3), middle (1), then the two with none: quiet is older than the new post.
    expect(rootOrder()).toEqual(["loud", "middle", "quiet", "bafyrei-new"]);
    expect(document.querySelector("[data-announcement]")?.textContent).toBe("Your thread was posted.");
  });

  it("closes the form and returns focus to the Start a thread button", async () => {
    const { actions } = seams();
    renderTab({ actions });
    await start("A new question.");
    await waitFor(() => expect(screen.queryByLabelText("Start a thread")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start a thread" })),
    );
  });

  it("starts the first thread of an empty discussion", async () => {
    const { actions } = seams();
    renderTab({ actions }, { paper: SHORT, paperCid: "bafyrei-genesis", threads: [] });
    await start("First!");
    await waitFor(() => expect(rootOrder()).toEqual(["bafyrei-new"]));
    expect(screen.queryByText(/No discussion yet/)).toBeNull();
    expect(screen.getByText("1 post · most helpful first")).toBeTruthy();
  });

  it("can be given up without posting anything", () => {
    const { sign, actions } = seams();
    renderTab({ actions });
    fireEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Start a thread")).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("DiscussionTab: helpful marks", () => {
  it("marks a post helpful and re-orders the thread at once", async () => {
    const { markHelpful, actions } = seams();
    markHelpful.mockResolvedValueOnce(4);
    renderTab({ actions });
    expect(rootOrder()).toEqual(["loud", "middle", "quiet"]);

    fireEvent.click(within(card("quiet")).getByRole("button", { name: /^Mark helpful/ }));

    await waitFor(() => expect(rootOrder()).toEqual(["quiet", "loud", "middle"]));
    expect(markHelpful).toHaveBeenCalledWith("quiet");
    expect(within(card("quiet")).getByText("4 members found this helpful")).toBeTruthy();
    const done = within(card("quiet")).getByRole("button", { name: /^Marked helpful/ });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-announcement]")?.textContent).toMatch(/Marked helpful/);
  });

  it("counts one more when the server does not say the new count", async () => {
    const { actions } = seams();
    renderTab({ actions });
    fireEvent.click(within(card("middle")).getByRole("button", { name: /^Mark helpful/ }));
    await waitFor(() =>
      expect(within(card("middle")).getByText("2 members found this helpful")).toBeTruthy(),
    );
  });

  it("re-orders replies too", async () => {
    const { markHelpful, actions } = seams();
    markHelpful.mockResolvedValueOnce(9);
    renderTab({ actions });
    fireEvent.click(within(card("reply-low")).getByRole("button", { name: /^Mark helpful/ }));
    await waitFor(() => expect(repliesOrder("loud")).toEqual(["reply-low", "reply-high"]));
  });

  it("keeps the reader's place after the post moves", async () => {
    const { markHelpful, actions } = seams();
    markHelpful.mockResolvedValueOnce(4);
    renderTab({ actions });
    fireEvent.click(within(card("quiet")).getByRole("button", { name: /^Mark helpful/ }));
    await waitFor(() => expect(document.activeElement).toBe(card("quiet")));
  });

  it("does not let a reader mark the same post twice in a tab", async () => {
    const { markHelpful, actions } = seams();
    renderTab({ actions });
    const button = within(card("middle")).getByRole("button", { name: /^Mark helpful/ });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    expect(markHelpful).toHaveBeenCalledTimes(1);
  });

  it("takes a 409 as 'you already did that', not as a failure", async () => {
    const { markHelpful, actions } = seams();
    markHelpful.mockRejectedValueOnce(problem(409));
    renderTab({ actions });
    fireEvent.click(within(card("middle")).getByRole("button", { name: /^Mark helpful/ }));

    // The note, the button and the focus settle over more than one render once
    // the 409 lands; wait for all of them.
    await waitFor(() => {
      expect(within(card("middle")).getByRole("status").textContent).toMatch(/already marked/);
      const done = within(card("middle")).getByRole("button", { name: /^Marked helpful/ });
      expect((done as HTMLButtonElement).disabled).toBe(true);
      expect(document.activeElement).toBe(card("middle"));
    });
    expect(within(card("middle")).queryByRole("alert")).toBeNull();
    // The count is not invented: the server did not count it.
    expect(within(card("middle")).getByText("1 member found this helpful")).toBeTruthy();
  });

  it("explains a refusal and leaves the button to try again", async () => {
    const { markHelpful, actions } = seams();
    markHelpful.mockRejectedValueOnce(problem(403));
    renderTab({ actions });
    fireEvent.click(within(card("middle")).getByRole("button", { name: /^Mark helpful/ }));

    expect((await within(card("middle")).findByRole("alert")).textContent).toMatch(/tier 1/);
    const again = within(card("middle")).getByRole("button", { name: /^Mark helpful/ });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(rootOrder()).toEqual(["loud", "middle", "quiet"]);
  });

  it("asks a signed-out reader to sign in rather than calling the server", () => {
    const { markHelpful, actions } = seams();
    renderTab({ actions, signedIn: false });
    fireEvent.click(within(card("middle")).getByRole("button", { name: /^Mark helpful/ }));

    expect(markHelpful).not.toHaveBeenCalled();
  });

  it("does not offer Mark helpful on the viewer's own post", () => {
    renderTab({ viewerDid: ME }, {
      ...threads(),
      threads: [post("mine", { author: ME }), post("theirs", { author: BOB })],
    });
    expect(within(card("mine")).queryByRole("button", { name: /^Mark helpful/ })).toBeNull();
    expect(within(card("theirs")).getByRole("button", { name: /^Mark helpful/ })).toBeTruthy();
  });

  it("offers Mark helpful on posts by other members", () => {
    renderTab({ viewerDid: ME });
    expect(document.querySelectorAll('[data-action="helpful"]')).toHaveLength(5);
  });
});

describe("DiscussionTab: reporting", () => {
  function openReport(cid: string): void {
    fireEvent.click(within(card(cid)).getByRole("button", { name: /^Report post by/ }));
  }

  it("opens a fieldset of reasons with none chosen for the reader", () => {
    renderTab();
    openReport("quiet");
    const group = within(card("quiet")).getByRole("group", {
      name: `Why are you reporting the post by ${authorLabel(ALICE)}?`,
    });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.length).toBeGreaterThanOrEqual(5);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
    // Each reason has its words and a one-line hint tied to the radio.
    expect(within(group).getByRole("radio", { name: /Spam or advertising/ })).toBeTruthy();
    for (const radio of radios) {
      expect(document.getElementById(radio.getAttribute("aria-describedby") ?? "")).not.toBeNull();
    }
  });

  it("files the report against the post with the chosen reason, and says it was reported", async () => {
    const { report, actions } = seams();
    renderTab({ actions });
    openReport("quiet");
    fireEvent.click(within(card("quiet")).getByRole("radio", { name: /Harassment or abuse/ }));
    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(report).toHaveBeenCalledWith("quiet", "abuse"));
    const note = await within(card("quiet")).findByText(/You reported this post as “Harassment or abuse”/);
    expect(note.textContent).toMatch(/A moderator will review it, and you will be told what was decided/);
    // The Report button gives way to one confirmation: the note below.
    expect(within(card("quiet")).queryByRole("button", { name: /^Report post by/ })).toBeNull();
    expect(within(card("quiet")).queryByText("Reported")).toBeNull();
    expect(card("quiet").querySelector("[data-reported]")).toBeNull();
    expect(within(card("quiet")).queryByRole("group", { name: /Why are you reporting/ })).toBeNull();
    // Focus goes to the confirmation, not into the void.
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(document.querySelector("[data-announcement]")?.textContent).not.toMatch(/Reported/);
  });

  it("only marks the reported post, never its neighbours", async () => {
    const { actions } = seams();
    renderTab({ actions });
    openReport("loud");
    fireEvent.click(within(card("loud")).getByRole("radio", { name: /Spam/ }));
    fireEvent.click(within(card("loud")).getByRole("button", { name: "Send report" }));
    await within(card("loud")).findByText(/You reported this post as “Spam/);

    expect(within(card("reply-high")).getByRole("button", { name: /^Report post by/ })).toBeTruthy();
    expect(within(card("quiet")).getByRole("button", { name: /^Report post by/ })).toBeTruthy();
    expect(document.querySelectorAll('[data-action="report"]')).toHaveLength(4);
  });

  it("reports a reply as readily as a thread", async () => {
    const { report, actions } = seams();
    renderTab({ actions });
    openReport("reply-low");
    fireEvent.click(within(card("reply-low")).getByRole("radio", { name: /Off topic/ }));
    fireEvent.click(within(card("reply-low")).getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(report).toHaveBeenCalledWith("reply-low", "off-topic"));
  });

  it("will not send a report with no reason, and says what to do", () => {
    const { report, actions } = seams();
    renderTab({ actions });
    openReport("quiet");
    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Send report" }));

    expect(within(card("quiet")).getByRole("alert").textContent).toMatch(/Choose a reason/);
    expect(report).not.toHaveBeenCalled();
    // Choosing one clears the message.
    fireEvent.click(within(card("quiet")).getByRole("radio", { name: /Something else/ }));
    expect(within(card("quiet")).queryByRole("alert")).toBeNull();
  });

  it("stays open and says why when the report is refused, so it can be sent again", async () => {
    const { report, actions } = seams();
    report.mockRejectedValueOnce(problem(500));
    renderTab({ actions });
    openReport("quiet");
    fireEvent.click(within(card("quiet")).getByRole("radio", { name: /Spam/ }));
    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Send report" }));

    expect((await within(card("quiet")).findByRole("alert")).textContent).toMatch(/could not take the report/);
    expect(within(card("quiet")).getByRole("button", { name: /^Report post by/ })).toBeTruthy();
    expect((within(card("quiet")).getByRole("radio", { name: /Spam/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Send report" }));
    await within(card("quiet")).findByText(/You reported this post as “Spam/);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("offers to sign in again when the session has ended", async () => {
    const { report, actions } = seams();
    report.mockRejectedValueOnce(problem(401));
    renderTab({ actions });
    openReport("quiet");
    fireEvent.click(within(card("quiet")).getByRole("radio", { name: /Spam/ }));
    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Send report" }));
    const alert = await within(card("quiet")).findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("can be given up, returning focus to Report", () => {
    const { report, actions } = seams();
    renderTab({ actions });
    openReport("quiet");
    fireEvent.click(within(card("quiet")).getByRole("button", { name: "Cancel" }));
    expect(within(card("quiet")).queryByRole("group", { name: /Why are you reporting/ })).toBeNull();
    expect(document.activeElement).toBe(within(card("quiet")).getByRole("button", { name: /^Report post by/ }));
    expect(report).not.toHaveBeenCalled();
  });

  it("asks a signed-out reader to sign in instead of showing the form", () => {
    const { report, actions } = seams();
    renderTab({ actions, signedIn: false });
    openReport("quiet");
    expect(within(card("quiet")).queryByRole("radio")).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
});

describe("DiscussionTab: signed out", () => {
  it("lets a signed-out reader read everything, and tells them where to sign in", () => {
    renderTab({ signedIn: false });
    expect(rootOrder()).toEqual(["loud", "middle", "quiet"]);
    const note = document.querySelector('.pd-start [data-note="sign-in"]');
    expect(note?.textContent).toMatch(/Sign in to start a thread or reply/);
    expect(screen.queryByRole("button", { name: "Start a thread" })).toBeNull();
  });

  it("shows a sign-in note, not a form, under Reply", () => {
    renderTab({ signedIn: false });
    fireEvent.click(within(card("quiet")).getByRole("button", { name: /^Reply to post by/ }));
    expect(within(card("quiet")).queryByRole("textbox")).toBeNull();
  });

  it("sends the reader to sign in and back to the paper page", () => {
    renderTab({ signedIn: false });
    const link = document.querySelector('.pd-start a[href^="/signin"]');
    expect(link?.getAttribute("href")).toBe("/signin?next=%2Fp%2F6sel-2dio-orm6");
  });

  it("lets the host choose where Sign in goes", () => {
    renderTab({ signedIn: false, signInHref: "/signin?next=%2Fdiscussion%2F6sel-2dio-orm6" });
    expect(document.querySelector('.pd-start a[href^="/signin"]')?.getAttribute("href")).toBe(
      "/signin?next=%2Fdiscussion%2F6sel-2dio-orm6",
    );
  });

  it("points the sign-in link back at the page the reader is on, fragment included", () => {
    stubLocation("/p/6sel-2dio-orm6/v2?from=search#discussion");
    renderTab({ signedIn: false });
    expect(document.querySelector('.pd-start a[href^="/signin"]')?.getAttribute("href")).toBe(
      `/signin?next=${encodeURIComponent("/p/6sel-2dio-orm6/v2?from=search#discussion")}`,
    );
  });

  it("keeps the full address, fragment and all, when an action sends them to sign in", () => {
    stubLocation("/p/6sel-2dio-orm6/v2?from=search#discussion");
    const { markHelpful, actions } = seams();
    renderTab({ actions, signedIn: false });

    fireEvent.click(within(card("middle")).getByRole("button", { name: /^Mark helpful/ }));

    expect(markHelpful).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(
      `/signin?next=${encodeURIComponent("/p/6sel-2dio-orm6/v2?from=search#discussion")}`,
    );
  });
});

describe("DiscussionTab: loading", () => {
  it("loads the threads itself when the server gave none, showing progress meanwhile", async () => {
    let resolve: (data: DiscussionData) => void = () => undefined;
    const load = vi.fn<LoadThreads>(() => new Promise((done) => (resolve = done)));
    render(<DiscussionTab paperId={SHORT} signedIn load={load} />);

    expect(document.querySelector(".pd-loading")?.textContent).toMatch(/Loading the discussion/);
    expect(document.querySelector(".pd-loading")?.getAttribute("role")).toBe("status");
    expect(document.querySelector('[data-state="loading"]')?.getAttribute("aria-busy")).toBe("true");
    expect(load).toHaveBeenCalledWith(SHORT, expect.any(AbortSignal));

    await act(async () => resolve(threads()));
    expect(rootOrder()).toEqual(["loud", "middle", "quiet"]);
    expect(document.querySelector('[data-state="ready"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it("does not ask again when the server already supplied the threads", () => {
    const load = vi.fn<LoadThreads>();
    renderTab({ load });
    expect(load).not.toHaveBeenCalled();
  });

  it("says what went wrong, and offers Try again, which asks again", async () => {
    const load = vi
      .fn<LoadThreads>()
      .mockRejectedValueOnce(problem(500, "The database is resting."))
      .mockResolvedValueOnce(threads());
    render(<DiscussionTab paperId={SHORT} signedIn load={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The database is resting.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(rootOrder()).toEqual(["loud", "middle", "quiet"]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows the error the server's own fetch hit, and retries in the browser", async () => {
    const load = vi.fn<LoadThreads>().mockResolvedValue(threads());
    render(<DiscussionTab paperId={SHORT} signedIn initialError="The server could not answer." load={load} />);

    expect(screen.getByRole("alert").textContent).toContain("The server could not answer.");
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rootOrder()).toHaveLength(3));
  });

  it("is not an empty discussion when the answer was unreadable", async () => {
    const load = vi.fn<LoadThreads>().mockRejectedValue(new Error("The server's answer was not a list of threads."));
    render(<DiscussionTab paperId={SHORT} signedIn load={load} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a list of threads/);
    expect(screen.queryByText(/No discussion yet/)).toBeNull();
  });

  it("ignores a late answer for a paper the tab has moved on from", async () => {
    let resolveFirst: (data: DiscussionData) => void = () => undefined;
    const load = vi
      .fn<LoadThreads>()
      .mockImplementationOnce(() => new Promise((done) => (resolveFirst = done)))
      .mockResolvedValueOnce({ ...threads(), threads: [post("second-paper")] });

    const { rerender } = render(<DiscussionTab paperId="sch:aaaa-aaaa-aaaa" signedIn load={load} />);
    rerender(<DiscussionTab paperId="sch:bbbb-bbbb-bbbb" signedIn load={load} />);
    await waitFor(() => expect(rootOrder()).toEqual(["second-paper"]));

    await act(async () => resolveFirst(threads()));
    expect(rootOrder()).toEqual(["second-paper"]);
  });

  it("starts over, with nothing carried across, when the paper changes", async () => {
    const { actions } = seams();
    const { rerender } = render(<DiscussionTab paperId={SHORT} signedIn initial={threads()} actions={actions} />);
    fireEvent.click(within(card("quiet")).getByRole("button", { name: /^Mark helpful/ }));
    await waitFor(() =>
      expect((within(card("quiet")).getByRole("button", { name: /^Marked helpful/ }) as HTMLButtonElement).disabled).toBe(true),
    );

    rerender(
      <DiscussionTab
        paperId="sch:bbbb-bbbb-bbbb"
        signedIn
        actions={actions}
        initial={{ ...threads(), threads: [post("quiet")] }}
      />,
    );
    // Same post id on another paper's list: not marked helpful there.
    expect(within(card("quiet")).getByRole("button", { name: /^Mark helpful/ })).toBeTruthy();
  });
});

describe("DiscussionTab: an annotation saved in the reading column", () => {
  /** An empty discussion, as the server seeds a paper nobody has written on. */
  function empty(): DiscussionData {
    return { paper: SHORT, paperCid: "bafyrei-genesis", threads: [] };
  }

  /** What the reading column says on `window` after a save (bug_spec_verify24 D2). */
  function savedInTheText(paperId: string, annotation: DiscussionPost = post("bafyrei-annotation")): void {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ANNOTATION_CREATED_EVENT, {
          detail: { paperId, versionCid: "bafyrei-v1", annotation },
        }),
      );
    });
  }

  it("lists the saved annotation and counts it, without a reload", async () => {
    const annotation = post("bafyrei-annotation", {
      quote: "the paragraph the reader annotated",
      text: "A note on this paragraph.",
    });
    // The reload the tab does itself sees what a page reload would: the
    // annotation is a `discussion.post` among the paper's threads.
    const load = vi.fn<LoadThreads>().mockResolvedValue({
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [annotation],
    });
    const onCountChange = vi.fn();
    render(
      <DiscussionTab paperId={SHORT} signedIn initial={empty()} load={load} onCountChange={onCountChange} />,
    );
    expect(screen.getByText(/No discussion yet/)).toBeTruthy();
    expect(onCountChange).toHaveBeenLastCalledWith(0);

    savedInTheText(SHORT);

    await waitFor(() => expect(screen.getByText("A note on this paragraph.")).toBeTruthy());
    expect(screen.getByText("1 post · most helpful first")).toBeTruthy();
    expect(screen.queryByText(/No discussion yet/)).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    expect(load).toHaveBeenCalledWith(SHORT, expect.any(AbortSignal));
  });

  it("ignores an annotation saved on another paper", async () => {
    const load = vi.fn<LoadThreads>().mockResolvedValue(empty());
    render(<DiscussionTab paperId={SHORT} signedIn initial={empty()} load={load} />);

    savedInTheText("sch:bbbb-bbbb-bbbb");
    // Let any read a listener wrongly started settle.
    await act(async () => Promise.resolve());

    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText(/No discussion yet/)).toBeTruthy();
  });

  it("stops hearing once the tab is unmounted", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    try {
      const view = render(<DiscussionTab paperId={SHORT} signedIn initial={empty()} />);
      const listening = added.mock.calls
        .filter(([type]) => type === ANNOTATION_CREATED_EVENT)
        .map(([, listener]) => listener);
      expect(listening.length).toBeGreaterThan(0);

      view.unmount();

      for (const listener of listening) {
        expect(removed).toHaveBeenCalledWith(ANNOTATION_CREATED_EVENT, listener);
      }
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});

describe("DiscussionTab: server rendering", () => {
  it("renders the threads, in order, with Reply and Report on every post, before any script runs", () => {
    const html = renderToString(<DiscussionTab paperId={SHORT} initial={threads()} signedIn={false} />);

    expect(html).toContain("Text of loud.");
    expect(html).toContain("5 posts · most helpful first");
    expect(html.indexOf("Text of loud.")).toBeLessThan(html.indexOf("Text of middle."));
    expect(html.indexOf("Text of middle.")).toBeLessThan(html.indexOf("Text of quiet."));
    expect(html.indexOf("Text of reply-high.")).toBeLessThan(html.indexOf("Text of reply-low."));
    expect(html.match(/data-action="report"/g)).toHaveLength(5);
    expect(html.match(/data-action="reply"/g)).toHaveLength(5);
  });

  it("renders the error, with its retry button, when the server's fetch failed", () => {
    const html = renderToString(<DiscussionTab paperId={SHORT} initialError="Could not reach the server." />);
    expect(html).toContain("Could not reach the server.");
    expect(html).toContain("Try again");
  });

  it("renders a loading state when it has neither data nor an error", () => {
    const html = renderToString(<DiscussionTab paperId={SHORT} />);
    expect(html).toContain("Loading the discussion");
    expect(html).toContain('aria-busy="true"');
  });
});

describe("DiscussionTab: hidden posts", () => {
  function hiddenThreads(): DiscussionData {
    return {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [
        post("hidden", {
          hidden: true,
          hiddenReason: "Abusive and off-topic.",
          hiddenAt: "2026-02-01T10:00:00Z",
          text: null,
          replies: [post("under-hidden", { parent: "hidden" })],
        }),
        post("visible"),
      ],
    };
  }

  it("shows a placeholder with the reason instead of a hidden post's body", () => {
    renderTab({}, hiddenThreads());

    expect(screen.getByText("Hidden by moderation: Abusive and off-topic.")).toBeTruthy();
    expect(screen.queryByText(/Text of hidden/)).toBeNull();
    // The reply under it keeps its place, so no visible post disappears.
    expect(within(card("under-hidden")).getByText(/Text of under-hidden/)).toBeTruthy();
  });

  it("does not count the hidden placeholder as a post, but says it is listed", () => {
    renderTab({}, hiddenThreads());

    // Two visible posts (the reply and the visible root) and the placeholder.
    expect(screen.getByText("2 posts, 1 hidden · most helpful first")).toBeTruthy();
  });

  it("counts what is listed: one post and one hidden placeholder", () => {
    renderTab(
      {},
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [post("hidden", { hidden: true, hiddenReason: "Off topic.", text: null }), post("visible")],
      },
    );

    expect(screen.getByText("1 post, 1 hidden · most helpful first")).toBeTruthy();
  });

  it("does not say there is no discussion while a hidden placeholder is listed", () => {
    renderTab(
      {},
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [post("hidden", { hidden: true, hiddenReason: "Off topic.", text: null })],
      },
    );

    expect(screen.queryByText(/No discussion yet/)).toBeNull();
    expect(screen.getByText("0 posts, 1 hidden · most helpful first")).toBeTruthy();
    // The placeholder itself is listed, not only counted.
    expect(screen.getByText("Hidden by moderation: Off topic.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Threads, most helpful first" })).toBeTruthy();
  });

  it("keeps the plain wording when nothing is hidden", () => {
    renderTab();
    expect(screen.getByText("5 posts · most helpful first")).toBeTruthy();
  });

  it("offers no helpful, reply or report action on a hidden post", () => {
    renderTab({}, hiddenThreads());

    const scope = within(card("hidden"));
    expect(scope.queryByRole("button", { name: /Mark helpful/ })).toBeNull();
    expect(scope.queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(scope.queryByRole("button", { name: /^Report/ })).toBeNull();
  });
});

describe("DiscussionTab: the author's hidden post", () => {
  function ownHidden(reason: string | null): DiscussionData {
    return {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [
        post("mine", {
          author: ME,
          hidden: true,
          hiddenReason: reason,
          decisionCid: "bafyrei-decision",
          text: null,
        }),
        post("visible"),
      ],
    };
  }

  function notice(): HTMLElement {
    const el = card("mine").querySelector("[data-hidden]");
    if (!(el instanceof HTMLElement)) throw new Error("No hidden notice on the post");
    return el;
  }

  /** One hidden post by the reader, with the node's copy of their own text. */
  function ownHiddenBody(ownText: string): DiscussionData {
    return {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [
        post("mine", {
          author: ME,
          hidden: true,
          hiddenReason: "Off topic.",
          decisionCid: "bafyrei-decision",
          text: null,
          ownText,
        }),
        post("visible"),
      ],
    };
  }

  it("names the post by its own words, so two rows hidden alike can be told apart", () => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("one", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-1",
            text: null,
            ownText: "The lemma's case n = 0 is missing.",
          }),
          post("two", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-2",
            text: null,
            ownText: "The dataset licence is incompatible.",
          }),
          post("visible"),
        ],
      },
    );

    expect(within(card("one")).getByText("The lemma's case n = 0 is missing.")).toBeTruthy();
    expect(within(card("two")).getByText("The dataset licence is incompatible.")).toBeTruthy();
    expect(within(card("one")).queryByText("The dataset licence is incompatible.")).toBeNull();
    expect(within(card("two")).queryByText("The lemma's case n = 0 is missing.")).toBeNull();
  });

  it("collapses a long hidden post and opens all of it with Show my post", () => {
    const text = "The lemma's case n = 0 is missing from the proof. ".repeat(8).trim();
    renderTab({ viewerDid: ME }, ownHiddenBody(text));

    // Collapsed: the opening words stand in for the body, which is not all there.
    const excerpt = within(card("mine")).getByText(/^The lemma's case n = 0 is missing/);
    expect(excerpt.textContent?.endsWith("…")).toBe(true);
    expect(within(card("mine")).queryByText(text)).toBeNull();

    const show = within(card("mine")).getByRole("button", { name: /Show my post/ });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);

    expect(within(card("mine")).getByText(text)).toBeTruthy();
    const hide = within(card("mine")).getByRole("button", { name: /Hide my post/ });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(within(card("mine")).queryByText(text)).toBeNull();
  });

  it("calls the author's hidden annotation an annotation, and their hidden post a post", () => {
    // D3: an annotation the moderators hid reads with its own noun, while a
    // hidden thread post keeps the plain wording. The hide withholds the
    // annotation's anchor, so the card knows its kind from the node's flag on
    // the parsed post (`is_annotation`, read into `isAnnotation`).
    const long = "The lemma's case n = 0 is missing from the proof. ".repeat(8).trim();
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine-annotation", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-1",
            text: null,
            ownText: `An annotation on the lemma. ${long}`,
            isAnnotation: true,
          }),
          post("mine-post", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-2",
            text: null,
            ownText: `A thread post about the lemma. ${long}`,
          }),
        ],
      },
    );

    expect(
      within(card("mine-annotation")).getByText("Your annotation was hidden: Off topic."),
    ).toBeTruthy();
    expect(within(card("mine-post")).getByText("Your post was hidden: Off topic.")).toBeTruthy();
    // Neither row borrows the other's notice.
    expect(within(card("mine-annotation")).queryByText(/Your post was hidden/)).toBeNull();
    expect(within(card("mine-post")).queryByText(/Your annotation was hidden/)).toBeNull();

    const showAnnotation = within(card("mine-annotation")).getByRole("button", {
      name: /Show my annotation/,
    });
    const showPost = within(card("mine-post")).getByRole("button", { name: /Show my post/ });
    expect(
      within(card("mine-annotation")).queryByRole("button", { name: /Show my post/ }),
    ).toBeNull();
    expect(
      within(card("mine-post")).queryByRole("button", { name: /Show my annotation/ }),
    ).toBeNull();

    fireEvent.click(showAnnotation);
    fireEvent.click(showPost);

    expect(
      within(card("mine-annotation")).getByRole("button", { name: /Hide my annotation/ }),
    ).toBeTruthy();
    expect(within(card("mine-post")).getByRole("button", { name: /Hide my post/ })).toBeTruthy();
  });

  it("offers no Show my post when the whole post already fits", () => {
    renderTab({ viewerDid: ME }, ownHiddenBody("Too short to hide."));

    expect(within(card("mine")).getByText("Too short to hide.")).toBeTruthy();
    expect(within(card("mine")).queryByRole("button", { name: /Show my post/ })).toBeNull();
  });

  it("keeps a hidden post's text from every reader but its author", () => {
    renderTab({ viewerDid: BOB }, ownHiddenBody("My private words."));
    expect(within(card("mine")).getByText("Hidden by moderation: Off topic.")).toBeTruthy();
    expect(within(card("mine")).queryByText("My private words.")).toBeNull();
    expect(within(card("mine")).queryByRole("button", { name: /Show my post/ })).toBeNull();
  });

  it("keeps the author's own excerpt after they file an appeal", async () => {
    // The reported defect: filing replaced the row's body with the appeal label,
    // so two appealed posts by the same author read identically again.
    const text = "The lemma's case n = 0 is missing from the proof. ".repeat(8).trim();
    const { actions } = seams();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
    );
    try {
      renderTab({ viewerDid: ME, actions }, ownHiddenBody(text));
      fireEvent.click(within(card("mine")).getByRole("button", { name: "Appeal" }));
      typeInto(screen.getByLabelText("Why should this decision be reconsidered?"), "Context was missing.");
      fireEvent.click(screen.getByRole("button", { name: "Sign and file appeal" }));

      await waitFor(() =>
        expect(notice().textContent).toMatch(/^Appeal filed on .* — awaiting panel$/),
      );
      const excerpt = within(card("mine")).getByText(/^The lemma's case n = 0 is missing/);
      expect(excerpt.textContent?.endsWith("…")).toBe(true);
      const show = within(card("mine")).getByRole("button", { name: /Show my post/ });
      fireEvent.click(show);
      expect(within(card("mine")).getByText(text)).toBeTruthy();
    } finally {
      fetched.mockRestore();
    }
  });

  it.each<[string, NonNullable<DiscussionPost["appeal"]>, string]>([
    [
      "awaiting a panel",
      {
        cid: "bafyrei-appeal",
        filedAt: "2026-11-18T00:00:00Z",
        status: "awaiting_panel",
        outcome: null,
        decidedAt: null,
      },
      "Appeal filed on 18 Nov 2026 — awaiting panel",
    ],
    [
      "with no panel formed",
      {
        cid: "bafyrei-appeal",
        filedAt: "2026-11-18T00:00:00Z",
        status: "not_formed",
        outcome: null,
        decidedAt: null,
      },
      "Appeal filed on 18 Nov 2026 — panel not yet formed",
    ],
    [
      "decided",
      {
        cid: "bafyrei-appeal",
        filedAt: "2026-11-18T00:00:00Z",
        status: "decided",
        outcome: "overturned",
        decidedAt: "2026-11-25T00:00:00Z",
      },
      "Appeal filed on 18 Nov 2026 — decided: overturned the decision",
    ],
    [
      "decided without a panel",
      {
        cid: "bafyrei-appeal",
        filedAt: "2026-11-18T00:00:00Z",
        status: "decided",
        outcome: "upheld",
        decidedAt: "2026-12-02T00:00:00Z",
        decidedWithoutPanel: true,
      },
      "Appeal filed on 18 Nov 2026 — decided without a panel: upheld the decision",
    ],
  ])("keeps the author's own excerpt while the appeal is %s", (_state, appeal, label) => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision",
            text: null,
            ownText: "The dataset licence is incompatible.",
            appeal,
          }),
          post("visible"),
        ],
      },
    );

    expect(notice().textContent).toBe(label);
    expect(within(card("mine")).getByText("The dataset licence is incompatible.")).toBeTruthy();
  });

  it("tells two appealed posts apart by their own words", () => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("one", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-1",
            text: null,
            ownText: "The lemma's case n = 0 is missing.",
            appeal: {
              cid: "bafyrei-appeal-1",
              filedAt: "2026-11-18T00:00:00Z",
              status: "awaiting_panel",
              outcome: null,
              decidedAt: null,
            },
          }),
          post("two", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision-2",
            text: null,
            ownText: "The dataset licence is incompatible.",
            appeal: {
              cid: "bafyrei-appeal-2",
              filedAt: "2026-11-18T00:00:00Z",
              status: "awaiting_panel",
              outcome: null,
              decidedAt: null,
            },
          }),
          post("visible"),
        ],
      },
    );

    expect(within(card("one")).getByText("The lemma's case n = 0 is missing.")).toBeTruthy();
    expect(within(card("two")).getByText("The dataset licence is incompatible.")).toBeTruthy();
  });

  it("shows another reader no body once the author's appeal is filed", () => {
    renderTab(
      { viewerDid: BOB },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision",
            text: null,
            ownText: "My private words.",
            appeal: {
              cid: "bafyrei-appeal",
              filedAt: "2026-11-18T00:00:00Z",
              status: "not_formed",
              outcome: null,
              decidedAt: null,
            },
          }),
          post("visible"),
        ],
      },
    );

    expect(within(card("mine")).getByText("Hidden by moderation: Off topic.")).toBeTruthy();
    expect(within(card("mine")).queryByText("My private words.")).toBeNull();
    expect(within(card("mine")).queryByRole("button", { name: /Show my post/ })).toBeNull();
  });

  it("ends the reason sentence with one full stop, not two", () => {
    renderTab({ viewerDid: ME }, ownHidden("Needs the claim clarified."));

    expect(notice().textContent).toBe("Your post was hidden: Needs the claim clarified. Appeal");
    expect(notice().textContent).not.toContain("..");
  });

  it("still ends a reason that has no punctuation with a full stop", () => {
    renderTab({ viewerDid: ME }, ownHidden("Off topic"));

    expect(notice().textContent).toBe("Your post was hidden: Off topic. Appeal");
  });

  it("opens a labelled appeal form, with guidance, submit and cancel", () => {
    renderTab({ viewerDid: ME }, ownHidden("Off topic."));
    expect(screen.queryByLabelText("Why should this decision be reconsidered?")).toBeNull();

    fireEvent.click(within(card("mine")).getByRole("button", { name: "Appeal" }));

    const grounds = screen.getByLabelText("Why should this decision be reconsidered?");
    expect(grounds.tagName).toBe("TEXTAREA");
    // The same full-width field the reply form uses, not a bare textarea.
    expect(grounds.className).toContain("pd-compose__text");
    expect(grounds.getAttribute("aria-describedby")).toBeTruthy();

    // Guidance: what the grounds are for, and a running character count.
    const form = grounds.closest("form") as HTMLElement;
    expect(within(form).getByText(/signed into the public record/)).toBeTruthy();
    expect(within(form).getByText("0 characters")).toBeTruthy();
    typeInto(grounds, "The quote was taken out of context.");
    expect(within(form).getByText("35 characters")).toBeTruthy();

    expect(within(form).getByRole("button", { name: "Sign and file appeal" })).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("closes the appeal form on Cancel and puts focus back on Appeal", () => {
    renderTab({ viewerDid: ME }, ownHidden("Off topic."));
    const appeal = within(card("mine")).getByRole("button", { name: "Appeal" });
    fireEvent.click(appeal);
    typeInto(screen.getByLabelText("Why should this decision be reconsidered?"), "Draft");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Why should this decision be reconsidered?")).toBeNull();
    expect(document.activeElement).toBe(within(card("mine")).getByRole("button", { name: "Appeal" }));
  });

  it("signs the appeal against the moderation decision and says it is filed", async () => {
    const { sign, actions } = seams();
    // `api.post("/appeals", …)` is the tab's own call; stub it at the transport.
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
    );
    try {
      renderTab({ viewerDid: ME, actions }, ownHidden("Off topic."));
      fireEvent.click(within(card("mine")).getByRole("button", { name: "Appeal" }));
      typeInto(screen.getByLabelText("Why should this decision be reconsidered?"), "  Context was missing. ");
      fireEvent.click(screen.getByRole("button", { name: "Sign and file appeal" }));

      await waitFor(() => expect(notice().textContent).toMatch(/^Appeal filed on .* — awaiting panel$/));
      expect(sign).toHaveBeenCalledWith(
        "appeal",
        { target: "bafyrei-decision", grounds: "Context was missing.", paper: "bafyrei-genesis" },
        null,
      );
    } finally {
      fetched.mockRestore();
    }
  });

  it("says no panel could form as soon as the filing response says so", async () => {
    // The node draws the panel as it accepts the appeal: `panel_not_formed`
    // already names the state the next read will report.
    const { actions } = seams();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: "bafyrei-new", status: "panel_not_formed" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      renderTab({ viewerDid: ME, actions }, ownHidden("Off topic."));
      fireEvent.click(within(card("mine")).getByRole("button", { name: "Appeal" }));
      typeInto(screen.getByLabelText("Why should this decision be reconsidered?"), "Context was missing.");
      fireEvent.click(screen.getByRole("button", { name: "Sign and file appeal" }));

      await waitFor(() =>
        expect(notice().textContent).toBe("Appeal filed on 1 Feb 2026 — panel not yet formed"),
      );
    } finally {
      fetched.mockRestore();
    }
  });

  it("shows the panel state the node served after a reload, not a fresh Appeal button", () => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision",
            text: null,
            appeal: {
              cid: "bafyrei-appeal",
              filedAt: "2026-11-18T00:00:00Z",
              status: "not_formed",
              outcome: null,
              decidedAt: null,
            },
          }),
          post("visible"),
        ],
      },
    );

    expect(notice().textContent).toBe("Appeal filed on 18 Nov 2026 — panel not yet formed");
    expect(within(card("mine")).queryByRole("button", { name: "Appeal" })).toBeNull();
  });

  it("shows a decided appeal's outcome from the node's answer", () => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision",
            text: null,
            appeal: {
              cid: "bafyrei-appeal",
              filedAt: "2026-11-18T00:00:00Z",
              status: "decided",
              outcome: "overturned",
              decidedAt: "2026-11-25T00:00:00Z",
            },
          }),
          post("visible"),
        ],
      },
    );

    expect(notice().textContent).toBe(
      "Appeal filed on 18 Nov 2026 — decided: overturned the decision",
    );
  });

  it("says when a moderator had to decide without a panel", () => {
    renderTab(
      { viewerDid: ME },
      {
        paper: SHORT,
        paperCid: "bafyrei-genesis",
        threads: [
          post("mine", {
            author: ME,
            hidden: true,
            hiddenReason: "Off topic.",
            decisionCid: "bafyrei-decision",
            text: null,
            appeal: {
              cid: "bafyrei-appeal",
              filedAt: "2026-11-18T00:00:00Z",
              status: "decided",
              outcome: "upheld",
              decidedAt: "2026-12-02T00:00:00Z",
              decidedWithoutPanel: true,
            },
          }),
          post("visible"),
        ],
      },
    );

    expect(notice().textContent).toBe(
      "Appeal filed on 18 Nov 2026 — decided without a panel: upheld the decision",
    );
  });

  it("says the decision was already appealed, with the day it was filed", async () => {
    const { actions } = seams();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            type: "urn:scholium:problem:appeal-already-filed",
            title: "Conflict",
            status: 409,
            detail: "This decision has already been appealed.",
            filed_at: "2026-11-18T00:00:00Z",
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
    );
    try {
      renderTab({ viewerDid: ME, actions }, ownHidden("Off topic."));
      fireEvent.click(within(card("mine")).getByRole("button", { name: "Appeal" }));
      typeInto(screen.getByLabelText("Why should this decision be reconsidered?"), "Again.");
      fireEvent.click(screen.getByRole("button", { name: "Sign and file appeal" }));

      const told = await within(card("mine")).findByText(/You already appealed this decision/);
      expect(told.textContent).toBe("You already appealed this decision on 18 Nov 2026.");
      // The old generic report wording must not stand in for the real reason.
      expect(within(card("mine")).queryByText(/could not take the report/)).toBeNull();
    } finally {
      fetched.mockRestore();
    }
  });
});

describe("DiscussionTab: the viewer's own post", () => {
  it("does not offer Report on a post the viewer wrote", () => {
    renderTab({ viewerDid: ME }, {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [
        post("mine", { author: ME }),
        post("theirs", { author: BOB }),
      ],
    });

    expect(
      within(card("mine")).queryByRole("button", { name: /^Report/ }),
    ).toBeNull();
    expect(
      within(card("theirs")).getByRole("button", { name: /^Report/ }),
    ).toBeTruthy();
  });
});

describe("DiscussionTab: the region", () => {
  it("is a labelled region for the margin panel", () => {
    renderTab();
    expect(screen.getByRole("region", { name: "Discussion" })).toBeTruthy();
  });

  it("keeps a polite live region in the DOM from the start so a change is announced", () => {
    renderTab();
    const live = document.querySelector("[data-announcement]");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.textContent).toBe("");
  });
});

describe("DiscussionTab: post anchors (#post-<cid>)", () => {
  // jsdom has no layout, so it does not implement scrollIntoView: install a
  // recorder on the prototype for these tests, and take it away again.
  const proto = Element.prototype as { scrollIntoView?: unknown };
  const hadScrollIntoView = "scrollIntoView" in proto;
  const originalScrollIntoView = proto.scrollIntoView;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  /** The elements `scrollIntoView` was called on, in order. */
  function scrolledTo(): Element[] {
    return scrollIntoView.mock.contexts as Element[];
  }

  beforeEach(() => {
    scrollIntoView = vi.fn();
    proto.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    if (hadScrollIntoView) proto.scrollIntoView = originalScrollIntoView;
    else delete proto.scrollIntoView;
  });

  it("gives every post's card an id of post-<cid>, replies included", () => {
    renderTab();
    for (const cid of ["quiet", "loud", "middle", "reply-low", "reply-high"]) {
      expect(card(cid).id).toBe(`post-${cid}`);
    }
    expect(document.querySelectorAll("[id^='post-']")).toHaveLength(5);
  });

  it("uses the cid exactly as the API sent it", () => {
    renderTab({}, {
      paper: SHORT,
      paperCid: "bafyrei-genesis",
      threads: [post("bafyreiAbC123xyz")],
    });
    expect(document.getElementById("post-bafyreiAbC123xyz")).toBe(card("bafyreiAbC123xyz"));
  });

  it("makes the card focusable by script and keeps the sticky header off the target", () => {
    renderTab();
    expect(card("loud").getAttribute("tabindex")).toBe("-1");
    // The 64px sticky nav plus 8px of air; jsdom folds the sum, a browser does too.
    expect(card("loud").style.scrollMarginTop).toMatch(/^calc\((?:64px \+ 8px|72px)\)$/);
  });

  it("scrolls the named post into view once the threads have rendered", async () => {
    stubLocation(`/discussion/${SHORT}/v1#post-middle`);
    let resolve: (data: DiscussionData) => void = () => undefined;
    const load = vi.fn<LoadThreads>(() => new Promise((done) => (resolve = done)));
    render(<DiscussionTab paperId={SHORT} signedIn load={load} />);

    // The posts do not exist yet: there is nothing to scroll to.
    expect(document.getElementById("post-middle")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => resolve(threads()));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrolledTo()[0]).toBe(card("middle"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("scrolls to a post the server already rendered, on mount", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-loud`);
    renderTab();
    expect(scrolledTo()).toEqual([card("loud")]);
  });

  it("scrolls to a reply too", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-reply-high`);
    renderTab();
    expect(scrolledTo()).toEqual([card("reply-high")]);
  });

  it("moves focus to the post it scrolled to", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-middle`);
    renderTab();
    expect(document.activeElement).toBe(card("middle"));
  });

  it("finds a post whose cid the margin link had to percent-encode", () => {
    // annotations.tsx builds the link with encodeURIComponent(cid).
    const cid = "cid with space/and slash";
    stubLocation(`/discussion/${SHORT}/v1#post-${encodeURIComponent(cid)}`);
    renderTab({}, { paper: SHORT, paperCid: "bafyrei-genesis", threads: [post(cid)] });
    expect(scrolledTo()).toEqual([card(cid)]);
  });

  it("does nothing for a hash that names no post", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-nobody`);
    const before = document.activeElement;
    renderTab();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
  });

  it("does nothing when there is no hash", () => {
    stubLocation(`/discussion/${SHORT}/v1`);
    renderTab();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves alone an element it does not own that the hash happens to name", () => {
    const outside = document.createElement("div");
    outside.id = "discussion";
    document.body.append(outside);
    try {
      stubLocation(`/papers/${SHORT}#discussion`);
      renderTab();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it("scrolls once per hash: re-reading the threads does not move the reader again", async () => {
    stubLocation(`/discussion/${SHORT}/v1#post-middle`);
    const load = vi.fn<LoadThreads>(async () => threads());
    renderTab({ load, viewerDid: ME });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The reader scrolls away, then an annotation saved elsewhere re-reads.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ANNOTATION_CREATED_EVENT, { detail: { paperId: SHORT } }),
      );
    });
    await waitFor(() => expect(load).toHaveBeenCalled());
    await act(async () => undefined);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls again on a later hashchange to another post", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-middle`);
    renderTab();
    expect(scrolledTo()).toEqual([card("middle")]);

    window.location.hash = "#post-quiet";
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });

    expect(scrolledTo()).toEqual([card("middle"), card("quiet")]);
    expect(document.activeElement).toBe(card("quiet"));
  });

  it("ignores a hashchange to an unknown hash, and stops listening when it unmounts", () => {
    stubLocation(`/discussion/${SHORT}/v1#post-middle`);
    const { unmount } = renderTab();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    window.location.hash = "#post-nobody";
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    unmount();
    window.location.hash = "#post-quiet";
    window.dispatchEvent(new Event("hashchange"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
