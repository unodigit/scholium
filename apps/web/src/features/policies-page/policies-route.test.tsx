// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import PoliciesRoutePage from "../../app/(policies-page)/policies/page";

/**
 * The route is server-rendered: the first HTML response must already contain
 * every clause and its anchor, so a decision banner's `/policies#MOD-02` link
 * works before any JavaScript runs.
 */

const PAYLOAD = [
  {
    id: "MOD-01",
    title: "Out of scope",
    text: "Scholium lists scholarly manuscripts within the categories the node has opened.",
  },
  {
    id: "MOD-02",
    title: "Plagiarism and unattributed overlap",
    text: "A submission must attribute every source it draws on.",
  },
];

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

describe("policies route (server render)", () => {
  it("renders every clause, its id anchor and its permalink in the HTML", async () => {
    const fetchMock = stubApi();

    const html = renderToStaticMarkup(await PoliciesRoutePage());

    expect(html).toContain("Moderation policies");
    expect(html).toContain("2 clauses");
    for (const clause of PAYLOAD) {
      expect(html).toContain(clause.title);
      expect(html).toContain(clause.text);
      expect(html).toContain(`id="${clause.id}"`);
      expect(html).toContain(`href="/policies#${clause.id}"`);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/v1/moderation/policies",
    );
  });

  it("renders a retryable notice instead of throwing when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const html = renderToStaticMarkup(await PoliciesRoutePage());

    expect(html).toContain("Couldn’t load the policies");
    expect(html).toContain("Try again");
  });

  it("renders a notice when the API returns something that is not a clause list", async () => {
    stubApi({ clauses: PAYLOAD });

    const html = renderToStaticMarkup(await PoliciesRoutePage());

    expect(html).toContain("Couldn’t load the policies");
    expect(html).toContain("did not return a policy clause list");
  });
});
