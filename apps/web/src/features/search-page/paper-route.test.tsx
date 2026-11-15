// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import PaperRoutePage from "../../app/(search-page)/p/[...ref]/page";

/**
 * `/p/{id}` is server-rendered: a shared paper link must contain the title and
 * the Authors section in the first HTML response, with each author's name
 * taken from their profile. These tests render the route with stubbed fetch.
 */

const PAPER = {
  paper: "sch:abcd-efgh-jklm",
  shortId: "sch:abcd-efgh-jklm",
  paperCid: "bafy-paper",
  versionCid: "bafy-version-2",
  cid: "bafy-version-2",
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "An evaluation framework for meta-agents.",
  authors: [
    { did: "did:key:zMei", author: "did:key:zMei", position: 1, creditRoles: [] },
    { did: "did:key:zAnon", author: "did:key:zAnon", position: 2, creditRoles: [] },
  ],
  categories: ["cs.AI"],
  licence: "CC-BY-4.0",
  status: "reviewed",
  notices: [],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubPaperApi(paper: unknown = PAPER): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/profiles/")) {
      const did = decodeURIComponent(url.slice(url.indexOf("/v1/profiles/") + 13));
      if (did === "did:key:zMei") {
        return json({
          did,
          name: "Mei Zhang",
          affiliation: "Example University",
          tier: 2,
        });
      }
      return json({ status: 404, detail: "no profile" }, 404);
    }
    if (url.includes("/v1/papers/")) {
      return json(paper);
    }
    return json({ status: 404, detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function params(...ref: string[]) {
  return Promise.resolve({ ref });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paper route (server render)", () => {
  it("renders the paper with an Authors section of profile names", async () => {
    const fetchMock = stubPaperApi();

    const html = renderToStaticMarkup(
      await PaperRoutePage({ params: params("sch:abcd-efgh-jklm", "v2") }),
    );

    expect(html).toContain(PAPER.title);
    expect(html).toContain("Authors");
    expect(html).toContain("Mei Zhang");
    expect(html).toContain("Example University");
    // A DID with no readable profile is still listed.
    expect(html).toContain("did:key:zAnon");

    const urls = fetchMock.mock.calls.map((call) => decodeURIComponent(String(call[0])));
    expect(urls.some((url) => url.includes("/v1/papers/sch:abcd-efgh-jklm/v2"))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes("/v1/profiles/did:key:zMei"))).toBe(true);
  });

  it("renders one honest message when the paper is not listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: 404, detail: "gone" }, 404)),
    );

    const html = renderToStaticMarkup(
      await PaperRoutePage({ params: params("sch:abcd-efgh-jklm") }),
    );

    expect(html).toContain("Paper unavailable");
    expect(html).toContain("No paper with that id is listed on this node.");
  });

  it("rejects an address that is not a paper id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(
      await PaperRoutePage({ params: params("not a paper") }),
    );

    expect(html).toContain("That is not a paper address.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
