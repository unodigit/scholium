// @vitest-environment node
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import DiscussionPage, {
  dynamic,
  generateMetadata,
} from "../../app/(paper-discussion)/discussion/[...ref]/page";
import { DiscussionTab } from "./discussion-tab";

/**
 * `/discussion/{id}[/v{n}]` is server-rendered: the first HTML response must
 * already contain the threads, in order, with a Reply and a Report on every
 * post, so the page reads before any JavaScript runs. These tests render the
 * route with a stubbed `fetch`, the way the two public reads answer.
 */

const SHORT = "sch:6sel-2dio-orm6";
const ALICE = "did:key:z6MkaliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function wirePost(cid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // The API spells every field more than one way.
  return {
    id: cid,
    cid,
    post_cid: cid,
    postCid: cid,
    author: ALICE,
    author_did: ALICE,
    authorDid: ALICE,
    text: `Text of ${cid}.`,
    textCid: null,
    target: "bafyrei-v2",
    paper: null,
    anchor: "bafyrei-v2",
    parent: null,
    parent_cid: null,
    parentCid: null,
    helpful: 0,
    created: "2026-01-01T00:00:00Z",
    seq: 1,
    replies: [],
    ...extra,
  };
}

/** Arrives in the wrong order on purpose: the tab sorts. */
const THREADS = {
  paper: SHORT,
  paper_cid: "bafyrei-genesis",
  paperCid: "bafyrei-genesis",
  count: 3,
  threads: [
    wirePost("quiet", { helpful: 0 }),
    wirePost("loud", {
      helpful: 4,
      seq: 2,
      replies: [wirePost("reply", { parent: "loud", parent_cid: "loud", parentCid: "loud", seq: 3 })],
    }),
  ],
};

const VERSIONS = {
  paper: SHORT,
  shortId: SHORT,
  paperCid: "bafyrei-genesis",
  versions: [
    { n: 1, version: 1, cid: "bafyrei-v1", versionCid: "bafyrei-v1", change_note: null, listed_at: "2026-01-01T00:00:00", anchor: "pending" },
    { n: 2, version: 2, cid: "bafyrei-v2", versionCid: "bafyrei-v2", change_note: "Fixed it.", listed_at: "2026-02-01T00:00:00", anchor: "pending" },
  ],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": status === 200 ? "application/json" : "application/problem+json" },
  });
}

const encoded = encodeURIComponent(SHORT);

function stubApi(
  handler: (url: string) => Response = (url) =>
    url.endsWith(`/papers/${encoded}/threads`)
      ? json(THREADS)
      : url.endsWith(`/papers/${encoded}/versions`)
        ? json(VERSIONS)
        : json({ title: "Not Found", status: 404 }, 404),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function page(ref: string[]): Promise<ReactElement> {
  return (await DiscussionPage({ params: Promise.resolve({ ref }) })) as ReactElement;
}

async function render(ref: string[]): Promise<string> {
  return renderToStaticMarkup(await page(ref));
}

/** The props the route handed the tab. */
async function tabProps(ref: string[]): Promise<Record<string, unknown>> {
  const element = await page(ref);
  const children = Children.toArray((element.props as { children: ReactNode }).children);
  const tab = children.find(
    (child): child is ReactElement => isValidElement(child) && child.type === DiscussionTab,
  );
  if (tab === undefined) throw new Error("The page did not render a DiscussionTab");
  return tab.props as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/discussion/[id]", () => {
  it("renders the threads, most helpful first, in the first HTML", async () => {
    stubApi();
    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("Text of loud.");
    expect(html).toContain("Text of quiet.");
    expect(html).toContain("Text of reply.");
    expect(html).toContain("3 posts · most helpful first");
    expect(html.indexOf("Text of loud.")).toBeLessThan(html.indexOf("Text of quiet."));
    expect(html).toContain("4 members found this helpful");
    expect(html).toContain("sch:6sel-2dio-orm6");
  });

  it("puts a Reply and a Report on every post in the first HTML", async () => {
    stubApi();
    const html = await render(["6sel-2dio-orm6"]);
    expect(html.match(/data-action="reply"/g)).toHaveLength(3);
    expect(html.match(/data-action="report"/g)).toHaveLength(3);
  });

  it("is readable without signing in, and says where to sign in", async () => {
    stubApi();
    const html = await render(["6sel-2dio-orm6"]);
    // The link is the first words of the sentence: "Sign in to start a thread or reply."
    expect(html).toMatch(/>Sign in<\/a> to start a thread or reply\./);
    expect(html).toContain("/signin?next=%2Fp%2F6sel-2dio-orm6");
  });

  it("asks the API for this paper's threads and versions, and nothing else", async () => {
    const fetchMock = stubApi();
    await render(["6sel-2dio-orm6"]);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.endsWith(`/v1/papers/${encoded}/threads`))).toBe(true);
    expect(urls.some((url) => url.endsWith(`/v1/papers/${encoded}/versions`))).toBe(true);
  });

  it("attaches new threads to the newest version when the URL names none", async () => {
    stubApi();
    expect((await tabProps(["6sel-2dio-orm6"])).versionCid).toBe("bafyrei-v2");
  });

  it("attaches new threads to the version in the URL", async () => {
    stubApi();
    expect((await tabProps(["6sel-2dio-orm6", "v1"])).versionCid).toBe("bafyrei-v1");
  });

  it("still serves the discussion when the version list cannot be read", async () => {
    stubApi((url) =>
      url.endsWith("/threads") ? json(THREADS) : json({ title: "Catalog unavailable", status: 503 }, 503),
    );
    const props = await tabProps(["6sel-2dio-orm6"]);
    // The tab then falls back to the paper's own record.
    expect(props.versionCid).toBeUndefined();
    expect(renderToStaticMarkup(await page(["6sel-2dio-orm6"]))).toContain("Text of loud.");
  });

  it("does not guess a version the paper does not have", async () => {
    stubApi();
    expect((await tabProps(["6sel-2dio-orm6", "v9"])).versionCid).toBeUndefined();
  });

  it("shows an empty discussion as an empty discussion", async () => {
    stubApi((url) =>
      url.endsWith("/threads") ? json({ ...THREADS, count: 0, threads: [] }) : json(VERSIONS),
    );
    const html = await render(["6sel-2dio-orm6"]);
    expect(html).toContain("No discussion yet");
    expect(html).not.toContain("Try again");
  });

  it("says a bad id is not a paper, instead of asking the API", async () => {
    const fetchMock = stubApi();
    const html = await render(["not-a-paper"]);

    expect(html).toContain("That is not a paper id");
    expect(html).not.toContain("Discussion</section>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a failed read down as a retryable message, not a 500", async () => {
    stubApi((url) =>
      url.endsWith("/threads") ? json({ title: "Discussion unavailable", status: 503 }, 503) : json(VERSIONS),
    );
    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("Discussion unavailable");
    expect(html).toContain("Try again");
    // An unreadable answer is not an empty discussion.
    expect(html).not.toContain("No discussion yet");
  });

  it("says 'we do not know', not 'nobody has posted', when the answer is not a thread list", async () => {
    stubApi((url) => (url.endsWith("/threads") ? json({ surprise: true }) : json(VERSIONS)));
    const html = await render(["6sel-2dio-orm6"]);
    expect(html).toContain("not a list of threads");
    expect(html).not.toContain("No discussion yet");
  });

  it("says the paper is unknown on a 404, in words", async () => {
    stubApi(() => json({ title: "Not Found", status: 404, detail: "No paper 'x'." }, 404));
    const html = await render(["6sel-2dio-orm6"]);
    expect(html).toContain("This server has no discussion for that paper");
  });

  it("is dynamic: the thread list changes with every post and helpful mark", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("titles the page after the paper named in the URL", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ ref: ["6sel-2dio-orm6"] }) });
    expect(meta.title).toBe(`Discussion of ${SHORT} · Scholium`);

    const bad = await generateMetadata({ params: Promise.resolve({ ref: ["nope"] }) });
    expect(bad.title).toBe("Discussion · Scholium");
  });

  it("says in the header that a helpful mark never changes the paper's status", async () => {
    stubApi();
    expect(await render(["6sel-2dio-orm6"])).toMatch(/never changes what the paper(?:’|&#x27;|&rsquo;|')s status says/);
  });
});
