import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, createApiClient } from "../../lib/api";
import {
  CITE_FORMATS,
  CitationResponseError,
  citeFormat,
  citePath,
  describeCiteError,
  loadCitation,
  parseCitation,
} from "./cite";
import { BIBTEX_BODY, RIS_BODY, SHORT_ID } from "./paper-page-fixtures";

/**
 * The citation the Cite dialog shows and copies: `GET /v1/papers/{id}/cite`
 * answers with plain text, so the loader must ask for text, name the version
 * on screen, and never edit what the node wrote.
 */

describe("the formats", () => {
  it("are BibTeX then RIS, the two the node serves", () => {
    expect(CITE_FORMATS.map((format) => [format.id, format.label])).toEqual([
      ["bibtex", "BibTeX"],
      ["ris", "RIS"],
    ]);
  });

  it("finds a format by id", () => {
    expect(citeFormat("ris").label).toBe("RIS");
    expect(() => citeFormat("endnote" as never)).toThrow(RangeError);
  });
});

describe("citePath", () => {
  it("names the version on screen, with the id escaped as one segment", () => {
    expect(citePath(SHORT_ID, 2)).toBe("/papers/sch%3A6sel-2dio-orm6/v2/cite");
  });

  it("ignores stray whitespace around the id", () => {
    expect(citePath(`  ${SHORT_ID} `, 1)).toBe("/papers/sch%3A6sel-2dio-orm6/v1/cite");
  });
});

describe("parseCitation", () => {
  it("keeps the node's text exactly, line breaks and trailing newline included", () => {
    expect(parseCitation(BIBTEX_BODY)).toBe(BIBTEX_BODY);
    expect(parseCitation(RIS_BODY)).toBe(RIS_BODY);
  });

  it.each([
    ["an empty body", ""],
    ["a blank body", "  \n "],
    ["JSON the client already decoded", { title: "x" }],
    ["no body", undefined],
  ])("refuses %s, rather than offering to copy nothing", (_name, payload) => {
    expect(() => parseCitation(payload)).toThrow(CitationResponseError);
  });
});

describe("loadCitation", () => {
  function clientFor(respond: (url: URL) => Response) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => respond(new URL(String(input))));
    const client = createApiClient({ baseUrl: "http://node.test", fetch: fetchMock });
    return { client, fetchMock };
  }

  const text = (body: string, type: string) =>
    new Response(body, { status: 200, headers: { "content-type": type } });

  it("asks the cite route for the version and the format, publicly", async () => {
    const { client, fetchMock } = clientFor(() => text(BIBTEX_BODY, "application/x-bibtex"));

    await loadCitation(SHORT_ID, 2, "bibtex", client);

    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("http://node.test/v1/papers/sch%3A6sel-2dio-orm6/v2/cite");
    expect(url.searchParams.get("format")).toBe("bibtex");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(init.cache).toBe("no-store");
  });

  it("returns BibTeX and RIS as the text the node sent", async () => {
    const { client } = clientFor((url) =>
      url.searchParams.get("format") === "ris"
        ? text(RIS_BODY, "application/x-research-info-systems; charset=utf-8")
        : text(BIBTEX_BODY, "application/x-bibtex; charset=utf-8"),
    );

    expect(await loadCitation(SHORT_ID, 2, "bibtex", client)).toBe(BIBTEX_BODY);
    expect(await loadCitation(SHORT_ID, 2, "ris", client)).toBe(RIS_BODY);
  });

  it("reads a citation as text even when it happens to start with a brace", async () => {
    // The client's default sniffing would try to parse this as JSON.
    const braced = "{not json, just a citation that starts oddly}\n";
    const { client } = clientFor(() => text(braced, "text/plain"));

    expect(await loadCitation(SHORT_ID, 2, "bibtex", client)).toBe(braced);
  });

  it("fails with the node's problem when the paper is not listed", async () => {
    const { client } = clientFor(
      () =>
        new Response(JSON.stringify({ title: "Not Found", status: 404, detail: "No listed paper." }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        }),
    );

    const failure = await loadCitation(SHORT_ID, 2, "ris", client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).isNotFound).toBe(true);
  });

  it("fails when the body is empty", async () => {
    const { client } = clientFor(() => text("", "application/x-bibtex"));

    await expect(loadCitation(SHORT_ID, 2, "bibtex", client)).rejects.toBeInstanceOf(
      CitationResponseError,
    );
  });
});

describe("describeCiteError", () => {
  it("says what was wrong with the answer in the answer's own words", () => {
    expect(describeCiteError(new CitationResponseError("The server did not return a citation."), "RIS")).toBe(
      "The server did not return a citation.",
    );
  });

  it("says the server could not be reached, and names the format", () => {
    expect(describeCiteError(new NetworkError("http://node.test/x"), "BibTeX")).toBe(
      "Couldn’t reach the server to load the BibTeX. Check your connection and try again.",
    );
  });

  it("says there is no citation for a paper the node does not list", () => {
    const missing = new ApiError(404, { title: "Not Found", status: 404, detail: "No listed paper." });
    expect(describeCiteError(missing, "RIS")).toBe("This server has no citation for that version.");
  });

  it("repeats the node's reason for any other refusal", () => {
    const refused = new ApiError(422, {
      title: "Unprocessable",
      status: 422,
      detail: "Unsupported citation format 'endnote': use 'bibtex' or 'ris'.",
    });
    expect(describeCiteError(refused, "RIS")).toBe(
      "Unsupported citation format 'endnote': use 'bibtex' or 'ris'.",
    );
  });

  it("falls back to a plain sentence for anything else", () => {
    expect(describeCiteError(new Error("boom"), "RIS")).toBe("The RIS could not be loaded. Try again.");
  });
});
