// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import MetaPage, {
  dynamic,
  generateMetadata,
} from "../../app/(paper-meta)/meta/[...ref]/page";

/**
 * `/meta/{id}[/v{n}]` is server-rendered: the first HTML response must already
 * contain the version timeline and the file list, so the page works before any
 * JavaScript runs. These tests render the route with a stubbed `fetch`, the
 * way the two catalog reads answer.
 */

const SHORT = "sch:6sel-2dio-orm6";

const VERSIONS = {
  paper: SHORT,
  shortId: SHORT,
  paperCid: "bafyrei-paper",
  versions: [
    {
      n: 1,
      version: 1,
      cid: "bafyrei-v1",
      versionCid: "bafyrei-v1",
      change_note: null,
      changeNote: null,
      listed_at: "2026-01-01T00:00:00",
      listedAt: "2026-01-01T00:00:00",
      anchor: "pending",
      anchorStatus: "pending",
      anchor_status: "pending",
    },
    {
      n: 2,
      version: 2,
      cid: "bafyrei-v2",
      versionCid: "bafyrei-v2",
      change_note: "Fixed the proof of Lemma 2.",
      changeNote: "Fixed the proof of Lemma 2.",
      listed_at: "2026-02-01T00:00:00",
      listedAt: "2026-02-01T00:00:00",
      anchor: "pending",
      anchorStatus: "pending",
      anchor_status: "pending",
    },
  ],
};

const MANIFEST = {
  paper: SHORT,
  shortId: SHORT,
  versionCid: "bafyrei-v2",
  n: 2,
  version: 2,
  manifestCid: "bafyrei-manifest",
  licence: "CC-BY-4.0",
  files: [
    {
      path: "paper.pdf",
      cid: "bafkrei-pdf",
      size: 1048576,
      mediaType: "application/pdf",
      role: "manuscript",
      licence: "CC-BY-4.0",
      scanStatus: "passed",
      scan_status: "passed",
    },
  ],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": status === 200 ? "application/json" : "application/problem+json",
    },
  });
}

function stubApi(
  handler: (url: string) => Response = (url) =>
    url.endsWith(`/papers/${encodeURIComponent(SHORT)}/versions`)
      ? json(VERSIONS)
      : url.endsWith("/manifest")
        ? json(MANIFEST)
        : json({ title: "Not Found", status: 404 }, 404),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function render(ref: string[]): Promise<string> {
  const element = await MetaPage({ params: Promise.resolve({ ref }) });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/meta/[id]", () => {
  it("renders the newest version's timeline and file list in the first HTML", async () => {
    stubApi();
    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("Version 1");
    expect(html).toContain("Version 2");
    expect(html).toContain("Fixed the proof of Lemma 2.");
    expect(html).toContain("Anchor pending");
    expect(html).toContain("paper.pdf");
    expect(html).toContain("Scan passed");
    expect(html).toContain("1.0 MB");
    expect(html).toContain("Download");
    expect(html).toContain("sch:6sel-2dio-orm6");
  });

  it("uses the version in the URL for the file list, and marks it Viewing", async () => {
    const fetchMock = stubApi();
    const html = await render(["6sel-2dio-orm6", "v1"]);

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/v/1/manifest"))).toBe(true);
    // The version being read is "Viewing" (bug_spec_verify4 bug 4): only the
    // newest version is "Latest", and reading v1 does not make v1 current.
    expect(html).toContain("Viewing");
  });

  it("says a bad id is not a paper, instead of asking the API", async () => {
    const fetchMock = stubApi();
    const html = await render(["not-a-paper"]);

    expect(html).toContain("That is not a paper id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a failed read down as a retryable message, not a 500", async () => {
    stubApi(() => json({ title: "Catalog unavailable", status: 503 }, 503));
    const html = await render(["6sel-2dio-orm6"]);

    expect(html).toContain("Catalog unavailable");
    expect(html).toContain("Try again");
  });

  it("is dynamic: the version list and scan results change between requests", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("titles the page after the paper named in the URL", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ ref: ["6sel-2dio-orm6"] }) });
    expect(meta.title).toBe(`Versions and files of ${SHORT}`);

    const bad = await generateMetadata({ params: Promise.resolve({ ref: ["nope"] }) });
    expect(bad.title).toBe("Versions and files");
  });
});
