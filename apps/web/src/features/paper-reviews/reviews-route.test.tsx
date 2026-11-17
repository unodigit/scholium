// @vitest-environment node
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReviewsPage, {
  dynamic,
  generateMetadata,
} from "../../app/(paper-reviews)/reviews/[...ref]/page";
import { ReviewsTab } from "./reviews-tab";

/**
 * `/reviews/{id}[/v{n}]` is server-rendered: the first HTML response must
 * already contain the reviews, their labels, recommendations and rubric
 * scores, so the page reads before any JavaScript runs. These tests render
 * the route with a stubbed `fetch`, the way the public read answers.
 */

const SHORT = "sch:6sel-2dio-orm6";

const REVIEWS = {
  paper: SHORT,
  shortId: SHORT,
  versionCid: "bafyrei-v2",
  version: 2,
  gate_open: true,
  count: 2,
  reviews: [
    {
      review_cid: "bafyrei-a",
      label: "Reviewer A",
      recommendation: "minor_revisions",
      committed_at: "2027-03-02T04:00:00",
      scores: {
        soundness: { score: 4, justification: "Sound." },
        evidence: { score: 3, justification: "One gap." },
      },
      report: "Careful work; the code bundle runs.",
    },
    {
      review_cid: "bafyrei-b",
      label: "Reviewer B",
      recommendation: "major_concerns",
      committed_at: "2027-03-03T04:00:00",
      scores: {
        soundness: { score: 3, justification: "Partly sound." },
        evidence: { score: 4, justification: "Good evidence." },
      },
    },
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
  handler: (url: string) => Response = () =>
    new Response(JSON.stringify({ title: "Not Found", status: 404 }), {
      status: 404,
      headers: { "content-type": "application/problem+json" },
    }),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function page(ref: string[]): Promise<ReactElement> {
  return (await ReviewsPage({ params: Promise.resolve({ ref }) })) as ReactElement;
}

async function render(ref: string[]): Promise<string> {
  return renderToStaticMarkup(await page(ref));
}

/** The props the route handed the tab. */
async function tabProps(ref: string[]): Promise<Record<string, unknown>> {
  const element = await page(ref);
  const children = Children.toArray((element.props as { children: ReactNode }).children);
  const tab = children.find(
    (child): child is ReactElement => isValidElement(child) && child.type === ReviewsTab,
  );
  if (tab === undefined) throw new Error("The page did not render a ReviewsTab");
  return tab.props as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/reviews/[id]", () => {
  it("renders the reviews, recommendations and rubric scores in the first HTML", async () => {
    const fetchMock = stubApi((url) =>
      url.endsWith(`/papers/${encoded}/reviews`)
        ? json(REVIEWS)
        : json({ title: "Not Found", status: 404 }, 404),
    );

    const html = await render(["6sel-2dio-orm6"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(html).toContain("Reviewer A");
    expect(html).toContain("Reviewer B");
    expect(html).toContain("Minor revisions");
    expect(html).toContain("Major concerns");
    expect(html).toContain("4 of 5");
    expect(html).toContain("Median scores");
    // (4 + 3) / 2 = 3.5, and the half point is shown rather than rounded.
    expect(html).toContain("3.5 of 5");
    // The report is inside the expander.
    expect(html).toContain("<details");
    expect(html).toContain("Read the report");
    expect(html).toContain("Careful work; the code bundle runs.");
  });

  it("says in its lede what the sealed cards say: the rubric is sealed with the review", async () => {
    stubApi(() => json(REVIEWS));

    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("the rubric is sealed with the review");
    // Scores are not public until their review is: the lede must not say so.
    expect(html).not.toMatch(/public either way/);
  });

  it("hands the tab the parsed data and the paper id", async () => {
    stubApi(() => json(REVIEWS));

    const props = await tabProps(["6sel-2dio-orm6"]);

    expect(props.paperId).toBe(SHORT);
    expect(props.initialError).toBeUndefined();
    expect((props.initial as { reviews: unknown[] }).reviews).toHaveLength(2);
  });

  it("renders the listing of the version the URL names, not the newest", async () => {
    const versioned = `${SHORT}/v1`;
    const versionsPath = `/papers/${encodeURIComponent(SHORT)}/versions`;
    const v1Path = "/papers/bafyrei-v1/reviews";
    const fetchMock = stubApi((url) => {
      if (url.endsWith(versionsPath)) {
        return json({
          paper: SHORT,
          versions: [
            { n: 1, cid: "bafyrei-v1" },
            { n: 2, cid: "bafyrei-v2" },
          ],
        });
      }
      if (url.endsWith(v1Path)) {
        return json({ ...REVIEWS, version: 1, versionCid: "bafyrei-v1" });
      }
      return json({ title: "Not Found", status: 404 }, 404);
    });

    const props = await tabProps(["6sel-2dio-orm6", "v1"]);

    // The version number is resolved to its cid: the endpoint takes one segment.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toContain(v1Path);
    // The tab asks for that version's reviews; a later fetch keeps the suffix.
    expect(props.paperId).toBe(versioned);
    expect((props.initial as { version: number }).version).toBe(1);
  });

  it("treats a 404 as the calm no-reviews state, not a failure", async () => {
    stubApi((url) =>
      url.endsWith(`/papers/${encoded}/reviews`)
        ? json({ detail: `No paper ${SHORT} on this node.` }, 404)
        : json({ title: "Not Found", status: 404 }, 404),
    );

    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("No reviews yet");
    expect(html).toContain("Review this paper");
    expect(html).not.toContain('role="alert"');
  });

  it("passes a real failure on as a retryable message", async () => {
    stubApi(() => json({ detail: "The ledger is busy." }, 503));

    const props = await tabProps(["6sel-2dio-orm6"]);

    expect(props.initialError).toBe("The ledger is busy.");
  });

  it("answers a malformed id with a notice, without asking the API", async () => {
    const fetchMock = stubApi();

    const html = await render(["not-a-paper-id"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("That is not a paper id");
  });

  it("is dynamic: reviews change with every commit and reveal", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("generateMetadata", () => {
  it("names the paper in the title", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ ref: ["6sel-2dio-orm6", "v2"] }),
    });
    expect(metadata.title).toBe(`Reviews of ${SHORT}/v2`);
  });
});
