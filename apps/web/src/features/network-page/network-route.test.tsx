// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import NetworkRoutePage from "../../app/(network-page)/network/page";

/**
 * The route is server-rendered: the first HTML response must already contain
 * the whole transparency document, so a reader (and a crawler) sees the node's
 * standing, log head, anchor state, replicas and moderation counts before any
 * JavaScript runs.
 */

const PAYLOAD = {
  node_did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  standing: "local",
  log_head: { seq: 41, entry_hash: "9f86d081884c7d659a2feaa0c55ad015a" },
  last_anchor: { status: "pending" },
  replicas: { have: 1, of: 1, local: true, summary: "1 of 1 local" },
  moderation: { total: 3, by_clause: { "MOD-01": 2, "MOD-04": 1 } },
};

function stubApi(payload: unknown = PAYLOAD): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("network route (server render)", () => {
  it("renders the whole status document in the HTML", async () => {
    const fetchMock = stubApi();

    const html = renderToStaticMarkup(await NetworkRoutePage());

    // Standing, node DID, log head, anchor, replicas, moderation counts.
    expect(html).toContain("Network");
    expect(html).toContain("Local");
    expect(html).toContain("no federation yet");
    expect(html).toContain(PAYLOAD.node_did);
    expect(html).toContain("Log head");
    expect(html).toContain(PAYLOAD.log_head.entry_hash);
    expect(html).toContain("Anchor pending");
    expect(html).toContain("public timestamp will be added");
    expect(html).toContain("1 of 1 local");
    expect(html).toContain("3 accepted decisions");
    expect(html).toContain(`href="/policies#MOD-01"`);
    expect(html).toContain(`href="/policies#MOD-04"`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/network");
  });

  it("renders the log head's sequence in the HTML", async () => {
    stubApi();

    const html = renderToStaticMarkup(await NetworkRoutePage());

    // The sequence is its own fact, not only part of a longer line.
    expect(html).toMatch(/<p[^>]*>41<\/p>/);
  });

  it("renders a retryable notice instead of throwing when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const html = renderToStaticMarkup(await NetworkRoutePage());

    expect(html).toContain("Couldn’t load the network status");
    expect(html).toContain("Try again");
  });

  it("renders a notice when the API returns something that is not a status document", async () => {
    stubApi([PAYLOAD]);

    const html = renderToStaticMarkup(await NetworkRoutePage());

    expect(html).toContain("Couldn’t load the network status");
    expect(html).toContain("did not return a network status document");
  });
});
