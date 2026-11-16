// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, resolveApiBaseUrl, tokenStore } from "../../lib/api";
import { fakePdf } from "../paper-page/pdf-fixtures";
import type { ReadingText } from "../paper-page/reading";
import type { ModeratedPaper } from "./decision";
import { ModDetail } from "./mod-detail";
import type { VersionPdf } from "./paper-content";

/**
 * docs/design.md §5.7: "Detail view shows the paper beside a decision form."
 * A moderator who decides on the metadata and abstract alone decides blind, so
 * the detail view shows the version's PDF (the paper page's PDF viewer) and
 * its extracted text next to the form. Both are fetched in the browser with
 * the moderator's token, since neither is public while the version waits.
 */

const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";
const PDF_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const MANIFEST = "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli";

const PAPER: ModeratedPaper = {
  versionCid: VERSION,
  paperCid: "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",
  shortId: "sch:5jmi-pmva-4lmr",
  versionId: "sch:5jmi-pmva-4lmr/v2",
  version: 2,
  title: "Sparse attention without the quadratic cost",
  abstract: "We remove the quadratic term.",
  authors: [],
  categories: ["cs.LG"],
  licence: "CC-BY-4.0",
  changeNote: null,
  manifestCid: MANIFEST,
};

const CLAUSES = [
  { id: "MOD-01", title: "Out of scope", text: "A submission outside every open category is rejected." },
] as const;

const PDF: VersionPdf = {
  name: "paper.pdf",
  cid: PDF_CID,
  url: `${resolveApiBaseUrl()}/v1/content/${PDF_CID}`,
};

const TEXT: ReadingText = {
  versionCid: VERSION,
  paragraphs: [
    { id: "p1", text: "We study attention over long sequences." },
    { id: "p2", text: "Our method drops the quadratic term." },
  ],
};

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDetail(overrides: Partial<Parameters<typeof ModDetail>[0]> = {}) {
  const pdfjs = fakePdf({ pages: 2 });
  const props = {
    versionCid: VERSION,
    signedIn: true,
    tier: 4,
    loadPaper: vi.fn(async () => PAPER),
    loadClauses: vi.fn(async () => [...CLAUSES]),
    loadText: vi.fn(async () => TEXT),
    loadPdfFile: vi.fn(async () => PDF),
    loadPdfjs: pdfjs.loadPdf,
    ...overrides,
  };
  render(<ModDetail {...props} />);
  return { pdfjs, props };
}

describe("the paper beside the decision form", () => {
  it("draws the PDF's pages and shows the extracted text, next to the form", async () => {
    const { pdfjs } = renderDetail();

    // The PDF: one canvas per page, opened from the node's content route.
    expect(await screen.findByRole("img", { name: "Page 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Page 2 of 2" })).toBeTruthy();
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: PDF.url }));

    // The text: every paragraph, in order.
    const text = await screen.findByRole("region", { name: "Text of this version" });
    const paragraphs = within(text).getAllByText(/./).map((node) => node.textContent);
    expect(paragraphs).toEqual([
      "We study attention over long sequences.",
      "Our method drops the quadratic term.",
    ]);

    // The decision form is on the same page, in the same grid as the paper.
    const form = screen.getByRole("heading", { name: "Record your decision" }).closest("form");
    expect(form).toBeTruthy();
    const grid = form?.closest(".mc-detail-grid");
    expect(grid?.contains(text)).toBe(true);
    expect(grid?.contains(screen.getByRole("img", { name: "Page 1 of 2" }))).toBe(true);
  });

  it("asks for the PDF and the text of the version the record names", async () => {
    const { props } = renderDetail();

    await screen.findByRole("img", { name: "Page 1 of 2" });
    expect(props.loadText).toHaveBeenCalledWith(PAPER);
    expect(props.loadPdfFile).toHaveBeenCalledWith(PAPER);
  });

  it("makes the scrollable text reachable from the keyboard", async () => {
    renderDetail();

    const text = await screen.findByRole("region", { name: "Text of this version" });
    expect(text.getAttribute("tabindex")).toBe("0");
  });

  it("shows the form even while the PDF and text are still loading", async () => {
    renderDetail({
      loadText: vi.fn(() => new Promise<ReadingText>(() => {})),
      loadPdfFile: vi.fn(() => new Promise<VersionPdf | null>(() => {})),
    });

    expect(await screen.findByRole("heading", { name: "Record your decision" })).toBeTruthy();
    expect(screen.getByText("Loading the PDF…")).toBeTruthy();
    expect(screen.getByText("Loading the text…")).toBeTruthy();
  });
});

describe("when part of the paper cannot be shown", () => {
  it("says the version has no PDF, and still shows the text and the form", async () => {
    renderDetail({ loadPdfFile: vi.fn(async () => null) });

    expect(await screen.findByText(/has no PDF to show/i)).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Text of this version" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Record your decision" })).toBeTruthy();
  });

  it("says why the text is missing, offers a retry, and keeps the PDF and form", async () => {
    const loadText = vi
      .fn<(paper: ModeratedPaper) => Promise<ReadingText>>()
      .mockRejectedValueOnce(new ApiError(404, { status: 404 }))
      .mockResolvedValue(TEXT);
    renderDetail({ loadText });

    expect(await screen.findByText(/no readable text for that version/i)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Page 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Record your decision" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try the text again" }));

    expect(await screen.findByRole("region", { name: "Text of this version" })).toBeTruthy();
    expect(loadText).toHaveBeenCalledTimes(2);
  });

  it("says when no text has been extracted yet", async () => {
    renderDetail({ loadText: vi.fn(async () => ({ versionCid: VERSION, paragraphs: [] })) });

    expect(await screen.findByText(/no text has been extracted/i)).toBeTruthy();
  });

  it("says why the PDF's manifest could not be read, with a retry", async () => {
    const loadPdfFile = vi
      .fn<(paper: ModeratedPaper) => Promise<VersionPdf | null>>()
      .mockRejectedValueOnce(new ApiError(500, { status: 500 }))
      .mockResolvedValue(PDF);
    renderDetail({ loadPdfFile });

    fireEvent.click(await screen.findByRole("button", { name: "Try the PDF again" }));

    expect(await screen.findByRole("img", { name: "Page 1 of 2" })).toBeTruthy();
    expect(loadPdfFile).toHaveBeenCalledTimes(2);
  });
});

describe("the moderator's token", () => {
  /** Answers each route the detail view reads, and records every request. */
  function stubNode() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/text")) {
        return json({
          paragraphs: [{ paragraph_id: "p1", position: 0, text: "Text read with a token." }],
        });
      }
      if (url.includes(`/records/${MANIFEST}`)) {
        return json({
          body: {
            files: [
              {
                path: "paper.pdf",
                cid: PDF_CID,
                size: 10,
                mediaType: "application/pdf",
                role: "manuscript",
              },
            ],
          },
        });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is sent with the text request, so a version in moderation is not a 404", async () => {
    tokenStore.set({ accessToken: "moderator-access-token" });
    const fetchMock = stubNode();
    const pdfjs = fakePdf({ pages: 1 });

    render(
      <ModDetail
        versionCid={VERSION}
        signedIn
        tier={4}
        loadPaper={async () => PAPER}
        loadClauses={async () => [...CLAUSES]}
        loadPdfjs={pdfjs.loadPdf}
      />,
    );

    expect(await screen.findByText("Text read with a token.")).toBeTruthy();
    const textCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/text"));
    expect(String(textCall?.[0])).toContain("/v1/papers/sch%3A5jmi-pmva-4lmr/v/2/text");
    expect(new Headers(textCall?.[1]?.headers).get("Authorization")).toBe(
      "Bearer moderator-access-token",
    );
    await waitFor(() =>
      expect(pdfjs.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({ url: `${resolveApiBaseUrl()}/v1/content/${PDF_CID}` }),
      ),
    );
  });
});
