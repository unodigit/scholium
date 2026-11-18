import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError, RecordSigningError } from "../web-auth/errors";
import type { SignedRecord } from "../web-auth/sign-record";
import {
  DISCUSSION_RECORD_TYPE,
  DiscussionResponseError,
  POST_TEXT_MAX,
  PostInputError,
  REPORT_REASONS,
  SELF_HELPFUL_TYPE,
  WrongPostRecordError,
  addPost,
  appealFiledLabel,
  authorLabel,
  comparePosts,
  countHiddenPosts,
  countPosts,
  describeActionError,
  describeLoadError,
  describeWait,
  discussionPath,
  findPost,
  formatDate,
  formatDateTime,
  helpfulEndpoint,
  helpfulLabel,
  loadThreads,
  markPostHelpful,
  orderThreads,
  paperPagePath,
  parseThreads,
  postAuthorLabel,
  postBody,
  hiddenOwnNotice,
  postCountLabel,
  postTextProblem,
  profilePath,
  reportPostFlag,
  reportReason,
  shortDid,
  signInPath,
  signInReturnPath,
  submitPost,
  threadsEndpoint,
  withHelpful,
  type DiscussionData,
  type DiscussionPost,
} from "./discussion";

// The journeys run east of UTC (GMT+11 in November); pin the zone so the
// reader's-zone dates asserted here are deterministic on any machine.
process.env.TZ = "Australia/Sydney";

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SHORT = "sch:6sel-2dio-orm6";

function post(cid: string, overrides: Partial<DiscussionPost> = {}): DiscussionPost {
  return {
    cid,
    author: ME,
    authorName: null,
    text: `text of ${cid}`,
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

function data(threads: DiscussionPost[]): DiscussionData {
  return { paper: "sch:6sel-2dio-orm6", paperCid: "bafyrei-genesis", threads };
}

function problem(status: number, detail = "nope", extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, { type: "about:blank", title: "Problem", status, detail, ...extra });
}

describe("parseThreads", () => {
  it("reads the API's thread list, replies nested", () => {
    const parsed = parseThreads({
      paper: "sch:6sel-2dio-orm6",
      paper_cid: "bafyrei-genesis",
      count: 2,
      threads: [
        {
          post_cid: "bafyrei-a",
          author: ME,
          text: "A root post.\n\nSecond paragraph.  ",
          helpful: 2,
          created: "2026-01-02T03:04:05Z",
          seq: 7,
          target: "bafyrei-v1",
          parent_cid: null,
          anchor: "bafyrei-v1",
          replies: [{ post_cid: "bafyrei-b", author: ME, text: "A reply.", helpful: 0, parent_cid: "bafyrei-a" }],
        },
      ],
    });

    expect(parsed.paper).toBe("sch:6sel-2dio-orm6");
    expect(parsed.paperCid).toBe("bafyrei-genesis");
    expect(parsed.threads).toHaveLength(1);
    const [root] = parsed.threads;
    expect(root).toMatchObject({
      cid: "bafyrei-a",
      author: ME,
      // A reader's line breaks stay; only trailing blank space goes.
      text: "A root post.\n\nSecond paragraph.",
      helpful: 2,
      createdAt: "2026-01-02T03:04:05Z",
      seq: 7,
      target: "bafyrei-v1",
      parent: null,
      quote: null,
    });
    expect(root.replies.map((reply) => reply.cid)).toEqual(["bafyrei-b"]);
    expect(root.replies[0].parent).toBe("bafyrei-a");
  });

  it("accepts camelCase spellings and any of the id fields", () => {
    const parsed = parseThreads({
      paperCid: "bafyrei-genesis",
      threads: [
        { postCid: "p1", authorDid: ME, text: "x", parentCid: "gone" },
        { cid: "p2", author_did: ME, text: "y" },
        { id: "p3", author: ME, text: "z" },
      ],
    });
    expect(parsed.paperCid).toBe("bafyrei-genesis");
    expect(parsed.threads.map((thread) => thread.cid)).toEqual(["p1", "p2", "p3"]);
    expect(parsed.threads[0].author).toBe(ME);
    expect(parsed.threads[0].parent).toBe("gone");
  });

  it("reads the author's profile name the API supplies, when there is one", () => {
    const parsed = parseThreads({
      threads: [
        { post_cid: "p1", author: ME, author_name: "Sam Rivera", text: "x" },
        { post_cid: "p2", author: ME, authorName: "Sam Rivera", text: "y" },
        { post_cid: "p3", author: ME, text: "z" },
        { post_cid: "p4", author: ME, author_name: "   ", text: "w" },
      ],
    });
    expect(parsed.threads.map((thread) => thread.authorName)).toEqual([
      "Sam Rivera",
      "Sam Rivera",
      null,
      null,
    ]);
  });

  it("reads the quote of an annotation, and nothing from a plain-id anchor", () => {
    const parsed = parseThreads({
      threads: [
        {
          post_cid: "ann",
          author: ME,
          text: "Check this.",
          anchor: { version: "bafyrei-v1", paragraph_id: "p-4", quote: "the quoted passage", offset: 12 },
        },
        { post_cid: "plain", author: ME, text: "Hi.", anchor: "bafyrei-v1" },
      ],
    });
    expect(parsed.threads[0].quote).toBe("the quoted passage");
    expect(parsed.threads[1].quote).toBeNull();
  });

  it("says a post has no text rather than showing blank", () => {
    const parsed = parseThreads({
      threads: [
        { post_cid: "a", author: ME, text: null, textCid: "bafkrei-body" },
        { post_cid: "b", author: ME, text: "   " },
      ],
    });
    expect(parsed.threads.map((thread) => thread.text)).toEqual([null, null]);
  });

  it("reads the author's own appeal state on a hidden post", () => {
    const parsed = parseThreads({
      threads: [
        {
          post_cid: "hidden",
          author: ME,
          hidden: true,
          hidden_reason: "Off topic.",
          decision_cid: "bafyrei-decision",
          appeal: {
            appeal_cid: "bafyrei-appeal",
            filed_at: "2026-11-18T09:30:00Z",
            panel_status: "not_formed",
            outcome: null,
            deadline: "2026-12-02T09:30:00Z",
          },
        },
        { post_cid: "plain", author: ME, text: "Hi." },
      ],
    });

    expect(parsed.threads[0].appeal).toEqual({
      cid: "bafyrei-appeal",
      filedAt: "2026-11-18T09:30:00Z",
      status: "not_formed",
      outcome: null,
      decidedAt: null,
      decidedWithoutPanel: false,
    });
    // A post nobody appealed has no state to show.
    expect(parsed.threads[1].appeal).toBeNull();
  });

  it("treats an empty list as no discussion, not as an error", () => {
    expect(parseThreads({ paper: "sch:6sel-2dio-orm6", count: 0, threads: [] }).threads).toEqual([]);
  });

  it("refuses a body that is not a thread list: 'we don't know' is not 'nobody posted'", () => {
    for (const body of [null, undefined, "nope", 42, [], {}, { threads: "x" }, { threads: {} }]) {
      expect(() => parseThreads(body), JSON.stringify(body)).toThrow(DiscussionResponseError);
    }
  });

  it("drops one unreadable post without taking the rest down", () => {
    const parsed = parseThreads({
      threads: [
        null,
        "junk",
        { author: ME, text: "no id" },
        { post_cid: "ok", author: ME, text: "fine", replies: [7, { text: "no id" }, { post_cid: "kid", author: ME, text: "kid" }] },
      ],
    });
    expect(parsed.threads.map((thread) => thread.cid)).toEqual(["ok"]);
    expect(parsed.threads[0].replies.map((reply) => reply.cid)).toEqual(["kid"]);
  });

  it("shows a post once even when the node lists it twice", () => {
    const parsed = parseThreads({
      threads: [
        { post_cid: "dup", author: ME, text: "a", replies: [{ post_cid: "dup", author: ME, text: "again" }] },
        { post_cid: "dup", author: ME, text: "b" },
      ],
    });
    expect(countPosts(parsed.threads)).toBe(1);
  });

  it("clamps a negative or odd helpful count to a whole number of at least 0", () => {
    const parsed = parseThreads({
      threads: [
        { post_cid: "neg", author: ME, text: "a", helpful: -4 },
        { post_cid: "str", author: ME, text: "b", helpful: "9" },
        { post_cid: "frac", author: ME, text: "c", helpful: 1.5 },
      ],
    });
    expect(parsed.threads.map((thread) => thread.helpful)).toEqual([0, 0, 0]);
  });

  it("ignores a timestamp it cannot read", () => {
    const parsed = parseThreads({ threads: [{ post_cid: "a", author: ME, text: "x", created: "yesterday-ish" }] });
    expect(parsed.threads[0].createdAt).toBeNull();
  });

  it("survives absurdly deep nesting without overflowing the stack", () => {
    let node: Record<string, unknown> = { post_cid: "leaf", author: ME, text: "deep" };
    for (let depth = 0; depth < 5000; depth += 1) {
      node = { post_cid: `p${depth}`, author: ME, text: "x", replies: [node] };
    }
    const parsed = parseThreads({ threads: [node] });
    expect(parsed.threads).toHaveLength(1);
    expect(countPosts(parsed.threads)).toBeLessThan(5001);
  });
});

describe("ordering", () => {
  it("puts the most helpful first", () => {
    const ordered = orderThreads([post("low", { helpful: 1 }), post("high", { helpful: 5 }), post("none")]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["high", "low", "none"]);
  });

  it("breaks a tie on helpful with the oldest first", () => {
    const ordered = orderThreads([
      post("newer", { helpful: 2, createdAt: "2026-03-01T00:00:00Z" }),
      post("older", { helpful: 2, createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["older", "newer"]);
  });

  it("compares instants, not strings: 11:00+02:00 is 09:00Z, which is before 10:00Z", () => {
    // As text "…T10:00:00Z" sorts before "…T11:00:00+02:00"; as instants it is the other way.
    const ordered = orderThreads([
      post("later", { createdAt: "2026-01-01T10:00:00Z" }),
      post("earlier", { createdAt: "2026-01-01T11:00:00+02:00" }),
    ]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["earlier", "later"]);
  });

  it("breaks a tie on time with the node's arrival order", () => {
    const ordered = orderThreads([post("second", { seq: 9 }), post("first", { seq: 3 })]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["first", "second"]);
  });

  it("puts a post this browser just signed (no arrival order) after its same-second peers", () => {
    const ordered = orderThreads([post("mine", { seq: null }), post("theirs", { seq: 12 })]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["theirs", "mine"]);
  });

  it("puts a post with no time first, as the API does", () => {
    const ordered = orderThreads([post("dated"), post("undated", { createdAt: null })]);
    expect(ordered.map((entry) => entry.cid)).toEqual(["undated", "dated"]);
  });

  it("orders replies at every depth, and leaves the input alone", () => {
    const input = [
      post("root", {
        replies: [
          post("quiet", { helpful: 0 }),
          post("loud", { helpful: 4, replies: [post("deep-quiet"), post("deep-loud", { helpful: 2 })] }),
        ],
      }),
    ];
    const before = JSON.stringify(input);
    const [root] = orderThreads(input);

    expect(root.replies.map((entry) => entry.cid)).toEqual(["loud", "quiet"]);
    expect(root.replies[0].replies.map((entry) => entry.cid)).toEqual(["deep-loud", "deep-quiet"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is a stable sort: posts that compare equal keep the order they came in", () => {
    const same = ["a", "b", "c", "d"].map((cid) => post(cid));
    expect(orderThreads(same).map((entry) => entry.cid)).toEqual(["a", "b", "c", "d"]);
    expect(comparePosts(same[0], same[1])).toBe(0);
  });
});

describe("the tree", () => {
  const tree = () =>
    data([post("a", { replies: [post("a1", { parent: "a", replies: [post("a1x", { parent: "a1" })] })] }), post("b")]);

  it("counts every post, replies included", () => {
    expect(countPosts(tree().threads)).toBe(4);
    expect(countPosts([])).toBe(0);
  });

  it("counts hidden placeholders apart from the posts, at any depth", () => {
    const hidden = (cid: string, replies: DiscussionPost[] = []) =>
      post(cid, { hidden: true, text: null, replies });
    const threads = [
      hidden("h1", [post("under-h1"), hidden("h2")]),
      post("visible", { replies: [hidden("h3")] }),
    ];
    expect(countHiddenPosts(threads)).toBe(3);
    // A placeholder is still not a post.
    expect(countPosts(threads)).toBe(2);
    expect(countHiddenPosts([])).toBe(0);
    expect(countHiddenPosts(tree().threads)).toBe(0);
  });

  it("finds a post at any depth", () => {
    expect(findPost(tree().threads, "a1x")?.cid).toBe("a1x");
    expect(findPost(tree().threads, "nope")).toBeNull();
  });

  it("adds a reply under its parent, however deep", () => {
    const next = addPost(tree(), post("new", { parent: "a1x" }));
    expect(findPost(next.threads, "a1x")?.replies.map((entry) => entry.cid)).toEqual(["new"]);
    expect(countPosts(next.threads)).toBe(5);
  });

  it("adds a thread at the root", () => {
    const next = addPost(tree(), post("new"));
    expect(next.threads.map((entry) => entry.cid)).toEqual(["a", "b", "new"]);
  });

  it("puts a reply whose parent is not listed at the root, so it is never lost", () => {
    const next = addPost(tree(), post("orphan", { parent: "not-here" }));
    expect(next.threads.map((entry) => entry.cid)).toContain("orphan");
  });

  it("does not add the same post twice", () => {
    const once = addPost(tree(), post("new", { parent: "a" }));
    expect(addPost(once, post("new", { parent: "a" }))).toBe(once);
  });

  it("never mutates the data it was given", () => {
    const before = tree();
    const snapshot = JSON.stringify(before);
    addPost(before, post("new", { parent: "a1" }));
    withHelpful(before, "a1", 9);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("sets one post's helpful count, wherever it is", () => {
    const before = tree();
    const next = withHelpful(before, "a1x", 6);
    expect(findPost(next.threads, "a1x")?.helpful).toBe(6);
    expect(findPost(next.threads, "a")?.helpful).toBe(0);
    // A branch the change did not touch is shared, not copied.
    expect(next.threads[1]).toBe(before.threads[1]);
  });

  it("leaves the data as it was for a post that is not there", () => {
    const before = tree();
    expect(withHelpful(before, "nope", 3)).toBe(before);
  });

  it("will not set a negative count", () => {
    expect(findPost(withHelpful(tree(), "a", -3).threads, "a")?.helpful).toBe(0);
  });
});

describe("endpoints and the thread loader", () => {
  it("builds the paths the API serves", () => {
    expect(threadsEndpoint("sch:6sel-2dio-orm6")).toBe("/papers/sch%3A6sel-2dio-orm6/threads");
    expect(threadsEndpoint("  bafyrei/x  ")).toBe("/papers/bafyrei%2Fx/threads");
    expect(helpfulEndpoint("bafyrei-a")).toBe("/posts/bafyrei-a/helpful");
  });

  it("reads threads through the client, uncached, passing the abort signal", async () => {
    const get = vi.fn().mockResolvedValue({ threads: [{ post_cid: "a", author: ME, text: "hi" }] });
    const controller = new AbortController();
    const result = await loadThreads("sch:6sel-2dio-orm6", controller.signal, { get, post: vi.fn() });

    expect(get).toHaveBeenCalledWith("/papers/sch%3A6sel-2dio-orm6/threads", {
      cache: "no-store",
      signal: controller.signal,
    });
    expect(result.threads.map((thread) => thread.cid)).toEqual(["a"]);
  });

  it("rejects, rather than showing an empty tab, when the answer is not a thread list", async () => {
    const get = vi.fn().mockResolvedValue({ unexpected: true });
    await expect(loadThreads("x", undefined, { get, post: vi.fn() })).rejects.toBeInstanceOf(
      DiscussionResponseError,
    );
  });

  it("says why a load failed", () => {
    expect(describeLoadError(new DiscussionResponseError("Not a list."))).toBe("Not a list.");
    expect(describeLoadError(new NetworkError("http://x"))).toMatch(/reach the server/);
    expect(describeLoadError(problem(404))).toMatch(/no discussion for that paper/);
    expect(describeLoadError(problem(429))).toMatch(/Too many requests/);
    expect(describeLoadError(problem(500, "Database is down"))).toBe("Database is down");
    expect(describeLoadError(new Error("boom"))).toBe("boom");
    expect(describeLoadError("???")).toMatch(/could not be loaded/);
  });
});

describe("postTextProblem", () => {
  it("accepts ordinary text", () => {
    expect(postTextProblem("A fair point.")).toBeNull();
    expect(postTextProblem("x".repeat(POST_TEXT_MAX))).toBeNull();
  });

  it("asks for words, not whitespace", () => {
    expect(postTextProblem("")).toMatch(/Write something/);
    expect(postTextProblem("  \n\t ")).toMatch(/Write something/);
  });

  it("says by how much a post is too long", () => {
    expect(postTextProblem("x".repeat(POST_TEXT_MAX + 1))).toBe(
      "This post is 1 character over the 4,000 limit.",
    );
    expect(postTextProblem("x".repeat(POST_TEXT_MAX + 250))).toBe(
      "This post is 250 characters over the 4,000 limit.",
    );
  });

  it("measures what will be signed: surrounding space does not count", () => {
    expect(postTextProblem(`  ${"x".repeat(POST_TEXT_MAX)}  `)).toBeNull();
  });
});

describe("submitPost", () => {
  function signer(overrides: Partial<SignedRecord> = {}) {
    return vi.fn(
      async (type: string, body: Record<string, unknown>, prev: string | null): Promise<SignedRecord> => ({
        v: 1,
        type,
        id: "bafyrei-signed",
        author: ME,
        created: "2026-02-03T04:05:06Z",
        prev,
        body,
        proofs: [],
        sig: "c2ln",
        ...overrides,
      }),
    );
  }

  it("signs a discussion.post that starts its own chain, then submits that record", async () => {
    const sign = signer();
    const submit = vi.fn().mockResolvedValue({ post_cid: "bafyrei-from-server" });

    const made = await submitPost({
      paperId: "sch:6sel-2dio-orm6",
      text: "  The proof skips n = 0.  ",
      target: "bafyrei-v1",
      parent: null,
      sign,
      submit,
    });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(
      DISCUSSION_RECORD_TYPE,
      { target: "bafyrei-v1", anchor: "bafyrei-v1", text: "The proof skips n = 0.", parent: null },
      null,
    );
    expect(submit).toHaveBeenCalledWith(
      "sch:6sel-2dio-orm6",
      expect.objectContaining({ type: "discussion.post", id: "bafyrei-signed", prev: null }),
    );
    expect(made).toEqual({
      cid: "bafyrei-from-server",
      author: ME,
      authorName: null,
      text: "The proof skips n = 0.",
      createdAt: "2026-02-03T04:05:06Z",
      helpful: 0,
      parent: null,
      target: "bafyrei-v1",
      quote: null,
      seq: null,
      replies: [],
    });
  });

  it("shows the poster's profile name when the acceptance answers with it", async () => {
    const made = await submitPost({
      paperId: "sch:6sel-2dio-orm6",
      text: "Hello.",
      target: "bafyrei-v1",
      parent: null,
      sign: signer(),
      submit: vi.fn().mockResolvedValue({ post_cid: "bafyrei-new", author_name: "Sam Rivera" }),
    });
    expect(made.authorName).toBe("Sam Rivera");
  });

  it("names the parent when replying", async () => {
    const sign = signer();
    const made = await submitPost({
      paperId: "x",
      text: "Agreed.",
      target: "bafyrei-v1",
      parent: "bafyrei-root",
      sign,
      submit: vi.fn().mockResolvedValue({}),
    });
    expect(sign.mock.calls[0][1]).toMatchObject({ parent: "bafyrei-root" });
    expect(made.parent).toBe("bafyrei-root");
  });

  it("falls back to the signed record's own id when the server does not echo one", async () => {
    const made = await submitPost({
      paperId: "x",
      text: "Hi.",
      target: "t",
      parent: null,
      sign: signer(),
      submit: vi.fn().mockResolvedValue({}),
    });
    expect(made.cid).toBe("bafyrei-signed");
  });

  it("reads the id from whichever field the server uses", async () => {
    for (const answer of [{ postCid: "a" }, { cid: "a" }, { id: "a" }]) {
      const made = await submitPost({
        paperId: "x",
        text: "Hi.",
        target: "t",
        parent: null,
        sign: signer(),
        submit: vi.fn().mockResolvedValue(answer),
      });
      expect(made.cid).toBe("a");
    }
  });

  it("refuses empty or over-long text before any passkey prompt", async () => {
    const sign = signer();
    const submit = vi.fn();
    await expect(
      submitPost({ paperId: "x", text: "   ", target: "t", parent: null, sign, submit }),
    ).rejects.toBeInstanceOf(PostInputError);
    await expect(
      submitPost({ paperId: "x", text: "x".repeat(POST_TEXT_MAX + 1), target: "t", parent: null, sign, submit }),
    ).rejects.toBeInstanceOf(PostInputError);
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to sign a post with nothing to attach it to", async () => {
    const sign = signer();
    for (const target of [null, "", "   "]) {
      await expect(
        submitPost({ paperId: "x", text: "Hi.", target, parent: null, sign, submit: vi.fn() }),
      ).rejects.toBeInstanceOf(PostInputError);
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it("sends nothing when the signer returns the wrong kind of record", async () => {
    const submit = vi.fn();
    await expect(
      submitPost({
        paperId: "x",
        text: "Hi.",
        target: "t",
        parent: null,
        sign: signer({ type: "paper.version" }),
        submit,
      }),
    ).rejects.toBeInstanceOf(WrongPostRecordError);
    await expect(
      submitPost({
        paperId: "x",
        text: "Hi.",
        target: "t",
        parent: null,
        sign: signer({ prev: "bafyrei-other" }),
        submit,
      }),
    ).rejects.toBeInstanceOf(WrongPostRecordError);
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets a signing or submit failure through for the caller to describe", async () => {
    const cancelled = new PasskeyCancelledError();
    await expect(
      submitPost({
        paperId: "x",
        text: "Hi.",
        target: "t",
        parent: null,
        sign: vi.fn().mockRejectedValue(cancelled),
        submit: vi.fn(),
      }),
    ).rejects.toBe(cancelled);

    const refused = problem(403);
    await expect(
      submitPost({ paperId: "x", text: "Hi.", target: "t", parent: null, sign: signer(), submit: vi.fn().mockRejectedValue(refused) }),
    ).rejects.toBe(refused);
  });

  it("builds the body the discussion.post schema asks for", () => {
    expect(postBody({ text: " hi ", target: "t", parent: "p" })).toEqual({
      target: "t",
      anchor: "t",
      text: "hi",
      parent: "p",
    });
  });
});

describe("helpful and report calls", () => {
  it("marks helpful with a bodyless POST and returns the server's count", async () => {
    const send = vi.fn().mockResolvedValue({ post_cid: "a", helpful: 3, status: "recorded" });
    const count = await markPostHelpful("bafyrei-a", { get: vi.fn(), post: send });
    expect(send).toHaveBeenCalledWith("/posts/bafyrei-a/helpful");
    expect(count).toBe(3);
  });

  it("returns null when the server does not say the count", async () => {
    for (const body of [undefined, null, "ok", {}, { helpful: "3" }]) {
      const send = vi.fn().mockResolvedValue(body);
      expect(await markPostHelpful("a", { get: vi.fn(), post: send })).toBeNull();
    }
  });

  it("lets the 409 of a repeated mark through", async () => {
    const repeated = problem(409);
    await expect(
      markPostHelpful("a", { get: vi.fn(), post: vi.fn().mockRejectedValue(repeated) }),
    ).rejects.toBe(repeated);
  });

  it("reports a post to /flags with the post as target and the category as reason", async () => {
    const send = vi.fn().mockResolvedValue({ id: "flag-1", status: "pending" });
    const receipt = await reportPostFlag("bafyrei-a", "spam", { get: vi.fn(), post: send });
    expect(send).toHaveBeenCalledWith("/flags", { target: "bafyrei-a", reason: "spam" });
    expect(receipt).toEqual({ flagId: "flag-1" });
  });

  it("copes with a report answer that has no flag id", async () => {
    const receipt = await reportPostFlag("a", "other", { get: vi.fn(), post: vi.fn().mockResolvedValue(null) });
    expect(receipt).toEqual({ flagId: null });
  });

  it("offers a distinct, plainly worded set of reasons, each with a hint", () => {
    const ids = REPORT_REASONS.map((reason) => reason.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["spam", "abuse", "other"]));
    for (const reason of REPORT_REASONS) {
      expect(reason.label.length).toBeGreaterThan(3);
      expect(reason.hint.length).toBeGreaterThan(3);
      // The reason is stored as a category: no spaces or capitals.
      expect(reason.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
    expect(reportReason("spam")?.label).toBe("Spam or advertising");
    expect(reportReason("nope")).toBeNull();
  });
});

describe("describeActionError", () => {
  it("treats a dismissed passkey prompt as a choice, and says nothing was sent", () => {
    const failure = describeActionError(new PasskeyCancelledError(), "post");
    expect(failure.message).toMatch(/cancelled/i);
    expect(failure.message).toMatch(/nothing was sent/i);
    expect(failure.signIn).toBe(false);
  });

  it("explains a device with no key, a failed passkey and any other key failure", () => {
    expect(describeActionError(new DeviceKeyError("not-found", "x"), "post").message).toMatch(/no signing key/);
    expect(describeActionError(new DeviceKeyError("passkey-failed", "x"), "post").message).toMatch(/passkey could not be confirmed/);
    expect(describeActionError(new DeviceKeyError("signing-failed", "x"), "post").message).toMatch(/Nothing was sent/);
  });

  it("explains a record that could not be prepared", () => {
    expect(describeActionError(new RecordSigningError("invalid-record", "x"), "post").message).toMatch(
      /Could not prepare the post/,
    );
  });

  it("passes on input and signer-mismatch problems as they were written", () => {
    expect(describeActionError(new PostInputError("Write something before you post."), "post").message).toBe(
      "Write something before you post.",
    );
    expect(describeActionError(new WrongPostRecordError("Wrong."), "post").message).toBe("Wrong. Nothing was sent.");
  });

  it("offers to sign in again on a 401, for every action, and says whether anything was sent", () => {
    for (const action of ["post", "helpful", "report"] as const) {
      const failure = describeActionError(problem(401), action);
      expect(failure.signIn, action).toBe(true);
      expect(failure.message).toMatch(/^Your session has ended\. Nothing was (sent|changed)\.$/);
      // The link that follows carries the instruction; the sentence does not repeat it.
      expect(failure.message).not.toMatch(/sign in/i);
    }
    expect(describeActionError(problem(401), "post").message).toMatch(/Nothing was sent/);
    expect(describeActionError(problem(401), "helpful").message).toMatch(/Nothing was changed/);
  });

  it("explains a 403 by action: the trust level for posting and voting, a refusal for a report", () => {
    expect(describeActionError(problem(403), "post").message).toMatch(/tier 1/);
    expect(describeActionError(problem(403), "helpful").message).toMatch(/tier 1/);
    expect(describeActionError(problem(403), "report").message).toMatch(/would not take this report/);
  });

  it("treats a repeated helpful mark as already done, not as a failure to retry", () => {
    const failure = describeActionError(problem(409), "helpful");
    expect(failure.alreadyDone).toBe(true);
    expect(failure.message).toMatch(/already marked/);
    // A 409 on anything else is just a failure.
    expect(describeActionError(problem(409), "post").alreadyDone).toBe(false);
  });

  it("says the decision was already appealed, with the day it was filed", () => {
    const failure = describeActionError(
      problem(409, "Already appealed.", {
        type: "urn:scholium:problem:appeal-already-filed",
        filed_at: "2026-11-18T09:30:00Z",
      }),
      "appeal",
    );
    expect(failure.message).toBe("You already appealed this decision on 18 Nov 2026.");
    expect(failure.alreadyDone).toBe(true);
    // Never the report wording: an appeal is not a report.
    expect(failure.message).not.toMatch(/report/);
  });

  it("says a member cannot mark their own post helpful, from the API's own problem type", () => {
    const failure = describeActionError(
      problem(409, "You wrote this post.", { type: SELF_HELPFUL_TYPE }),
      "helpful",
    );
    expect(failure.message).toBe("You cannot mark your own post helpful.");
    // Nothing was recorded, so it is not "already done".
    expect(failure.alreadyDone).toBe(false);
  });

  it("says a post that vanished is no longer listed", () => {
    expect(describeActionError(problem(404), "helpful").message).toMatch(/no longer listed/);
  });

  it("quotes the server on a 422", () => {
    const failure = describeActionError(problem(422, "The record is not a discussion.post."), "post");
    expect(failure.message).toContain("The record is not a discussion.post.");
    expect(failure.message).toMatch(/Nothing was sent/);
    expect(describeActionError(problem(422, "Bad."), "report").message).toMatch(/Nothing was changed/);
  });

  it("says how long to wait when rate limited, using Retry-After", () => {
    const limited = new ApiError(
      429,
      { title: "Too Many Requests", status: 429, detail: "slow down" },
      { response: new Response(null, { status: 429, headers: { "retry-after": "90" } }) },
    );
    expect(describeActionError(limited, "post").message).toContain("Try again in 2 minutes.");
    expect(describeActionError(problem(429), "post").message).toContain("Try again in a moment.");
  });

  it("says plainly when the server cannot be reached", () => {
    const failure = describeActionError(new NetworkError("http://x"), "report");
    expect(failure.message).toMatch(/reach the server/);
    expect(failure.signIn).toBe(false);
  });

  it("has a calm sentence for a server error, per action, and for anything unknown", () => {
    expect(describeActionError(problem(500), "post").message).toMatch(/could not take the post/);
    expect(describeActionError(problem(500), "helpful").message).toMatch(/could not record that/);
    expect(describeActionError(problem(500), "report").message).toMatch(/could not take the report/);
    expect(describeActionError("???", "post").message).toMatch(/post was not sent/);
    expect(describeActionError("???", "report").message).toMatch(/Something went wrong/);
  });

  it("never leaks a stack trace or an internal class name", () => {
    for (const error of [new Error("TypeError: x is undefined at foo.ts:3"), problem(500, "Traceback (most recent call last)")]) {
      // An unknown Error is not echoed back; a server error uses our sentence.
      expect(describeActionError(error, "post").message).not.toMatch(/Traceback|undefined|\.ts:/);
    }
  });
});

describe("words and formats", () => {
  it("waits in seconds, then minutes", () => {
    expect(describeWait(0.2)).toBe("1 second");
    expect(describeWait(30)).toBe("30 seconds");
    expect(describeWait(60)).toBe("1 minute");
    expect(describeWait(61)).toBe("2 minutes");
  });

  it("formats dates in the reader's zone, with the same words in every locale", () => {
    // 23:59 UTC on 1 Feb is 2 Feb in Sydney (GMT+11): the post's own date and
    // the appeal label under it must name the same day.
    expect(formatDate("2026-02-01T23:59:00Z")).toBe("2 Feb 2026");
    // The `<time>` title names the instant itself, so it stays UTC-labelled.
    expect(formatDateTime("2026-02-01T04:00:00Z")).toBe("1 Feb 2026 04:00 UTC");
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatDateTime("not a date")).toBe("not a date");
  });

  it("files an appeal with an em dash and the panel state it knows", () => {
    const filed = (status: string, outcome: string | null = null) => ({
      filedAt: "2026-11-17T13:45:00Z",
      status,
      outcome,
      decidedWithoutPanel: false,
    });
    // 00:45 on 18 Nov in Sydney: the same day the post itself shows.
    expect(appealFiledLabel(filed("awaiting_panel"))).toBe(
      "Appeal filed on 18 Nov 2026 — awaiting panel",
    );
    expect(appealFiledLabel(filed("not_formed"))).toBe(
      "Appeal filed on 18 Nov 2026 — panel not yet formed",
    );
    // The filing response's own spelling names the same state at once.
    expect(appealFiledLabel(filed("panel_not_formed"))).toBe(
      "Appeal filed on 18 Nov 2026 — panel not yet formed",
    );
    expect(appealFiledLabel(filed("decided", "overturned"))).toBe(
      "Appeal filed on 18 Nov 2026 — decided: overturned the decision",
    );
    // No hyphen anywhere: the paper page's labels use the em dash too.
    for (const status of ["awaiting_panel", "not_formed", "panel_not_formed"]) {
      expect(appealFiledLabel(filed(status))).not.toContain(" - ");
    }
  });

  it("shortens a DID to something recognisable, and says so when there is none", () => {
    expect(shortDid(ME)).toBe("did:key:z6MkhaXg…ta2doK");
    expect(shortDid("did:key:z6Mk")).toBe("did:key:z6Mk");
    expect(authorLabel("")).toBe("Unknown author");
    expect(authorLabel("   ")).toBe("Unknown author");
    expect(authorLabel(ME)).toBe(shortDid(ME));
  });

  it("counts helpful marks in words", () => {
    expect(helpfulLabel(0)).toBe("No helpful marks yet");
    expect(helpfulLabel(1)).toBe("1 member found this helpful");
    expect(helpfulLabel(3)).toBe("3 members found this helpful");
    expect(postCountLabel(1)).toBe("1 post");
    expect(postCountLabel(3)).toBe("3 posts");
  });

  it("says how many hidden placeholders are listed alongside the posts", () => {
    expect(postCountLabel(1, 1)).toBe("1 post, 1 hidden");
    expect(postCountLabel(3, 2)).toBe("3 posts, 2 hidden");
    expect(postCountLabel(0, 1)).toBe("0 posts, 1 hidden");
    // Nothing hidden: the plain wording, unchanged.
    expect(postCountLabel(2, 0)).toBe("2 posts");
  });

  it("ends the author's hidden notice with exactly one full stop", () => {
    expect(hiddenOwnNotice("Needs the claim clarified")).toBe(
      "Your post was hidden: Needs the claim clarified.",
    );
    // A moderator's own sentence already ends in punctuation: no doubling.
    expect(hiddenOwnNotice("Needs the claim clarified.")).toBe(
      "Your post was hidden: Needs the claim clarified.",
    );
    expect(hiddenOwnNotice("Is this on topic?")).toBe("Your post was hidden: Is this on topic?");
    expect(hiddenOwnNotice("  Off topic!  ")).toBe("Your post was hidden: Off topic!");
    expect(hiddenOwnNotice("Quoted “as is.”")).toBe("Your post was hidden: Quoted “as is.”");
    expect(hiddenOwnNotice(null)).toBe("Your post was hidden.");
    expect(hiddenOwnNotice("   ")).toBe("Your post was hidden.");
    expect(hiddenOwnNotice(undefined)).toBe("Your post was hidden.");
  });

  it("builds page paths without the sch: prefix", () => {
    expect(paperPagePath("sch:6sel-2dio-orm6")).toBe("/p/6sel-2dio-orm6");
    expect(paperPagePath("  6sel-2dio-orm6 ")).toBe("/p/6sel-2dio-orm6");
    expect(discussionPath("sch:6sel-2dio-orm6")).toBe("/discussion/6sel-2dio-orm6");
    expect(discussionPath("sch:6sel-2dio-orm6", 2)).toBe("/discussion/6sel-2dio-orm6/v2");
    expect(discussionPath("sch:6sel-2dio-orm6", null)).toBe("/discussion/6sel-2dio-orm6");
  });

  it("sends a signed-out reader to sign in and back, with the way back encoded once", () => {
    expect(signInPath("/p/6sel-2dio-orm6")).toBe("/signin?next=%2Fp%2F6sel-2dio-orm6");
  });
});

describe("who wrote a post", () => {
  it("calls the author by their profile name, and by the short DID when there is none", () => {
    expect(postAuthorLabel(post("named", { authorName: "Sam Rivera" }))).toBe("Sam Rivera");
    expect(postAuthorLabel(post("nameless"))).toBe(authorLabel(ME));
    expect(postAuthorLabel(post("erased", { author: "", authorName: "  " }))).toBe("Unknown author");
  });

  it("links a member to the page their profile is on", () => {
    expect(profilePath(ME)).toBe(`/u/${encodeURIComponent(ME)}`);
    expect(profilePath("")).toBe("/u/");
  });
});

describe("signInReturnPath", () => {
  it("keeps the page, its query and its fragment when the reader is on this paper's page", () => {
    expect(
      signInReturnPath(SHORT, {
        pathname: "/p/6sel-2dio-orm6/v2",
        search: "?from=search",
        hash: "#discussion",
      }),
    ).toBe("/p/6sel-2dio-orm6/v2?from=search#discussion");
  });

  it("keeps the standalone discussion page too, with no fragment", () => {
    expect(
      signInReturnPath(SHORT, { pathname: "/discussion/6sel-2dio-orm6", search: "", hash: "" }),
    ).toBe("/discussion/6sel-2dio-orm6");
  });

  it("falls back to the paper page anywhere else, or when there is no address", () => {
    expect(signInReturnPath(SHORT, { pathname: "/", search: "", hash: "" })).toBe(
      "/p/6sel-2dio-orm6",
    );
    expect(
      signInReturnPath(SHORT, { pathname: "/p/other-paper-id/v2", search: "", hash: "#discussion" }),
    ).toBe("/p/6sel-2dio-orm6");
    expect(signInReturnPath(SHORT, null)).toBe("/p/6sel-2dio-orm6");
  });
});
