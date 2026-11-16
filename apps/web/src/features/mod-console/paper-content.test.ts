import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiBaseUrl, tokenStore } from "../../lib/api";
import type { ModeratedPaper } from "./decision";
import {
  loadVersionPdf,
  loadVersionText,
  parseManifestPdf,
  textAddress,
} from "./paper-content";

/**
 * What a moderator reads beside the decision form: the version's PDF and its
 * extracted text. Neither is public while the version waits in moderation
 * (`/content/{cid}` and `/papers/{id}/v/{n}/text` answer `404` to anyone but
 * the authors and moderators), so both are fetched with the moderator's token,
 * and the PDF is found from the signed manifest record, not from the catalog's
 * manifest route (which lists only listed versions).
 */

const PDF_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const ZIP_CID = "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy";
const MANIFEST = "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli";

const PAPER: ModeratedPaper = {
  versionCid: "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey",
  paperCid: "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",
  shortId: "sch:5jmi-pmva-4lmr",
  versionId: "sch:5jmi-pmva-4lmr/v2",
  version: 2,
  title: "Sparse attention without the quadratic cost",
  abstract: "",
  authors: [],
  categories: [],
  licence: null,
  changeNote: null,
  manifestCid: MANIFEST,
};

const record = (files: unknown[]) => ({ id: MANIFEST, type: "manifest", body: { files } });

const file = (overrides: Record<string, unknown>) => ({
  path: "paper.pdf",
  cid: PDF_CID,
  size: 1024,
  mediaType: "application/pdf",
  role: "manuscript",
  ...overrides,
});

afterEach(() => {
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("parseManifestPdf", () => {
  it("finds the manuscript PDF and says where the node serves its bytes", () => {
    const pdf = parseManifestPdf(
      record([
        file({ path: "source.zip", cid: ZIP_CID, mediaType: "application/zip", role: "source" }),
        file({}),
      ]),
    );

    expect(pdf).toEqual({
      name: "paper.pdf",
      cid: PDF_CID,
      url: `${resolveApiBaseUrl()}/v1/content/${PDF_CID}`,
    });
  });

  it("prefers the manuscript over another PDF, and falls back to the first PDF", () => {
    const other = "bafkreiother";
    expect(
      parseManifestPdf(
        record([
          file({ path: "appendix.pdf", cid: other, role: "supplementary" }),
          file({ path: "main.pdf" }),
        ]),
      )?.name,
    ).toBe("main.pdf");
    expect(
      parseManifestPdf(record([file({ path: "appendix.pdf", cid: other, role: "supplementary" })]))
        ?.cid,
    ).toBe(other);
  });

  it("recognises a PDF by its extension when the media type is missing", () => {
    expect(parseManifestPdf(record([file({ mediaType: undefined })]))?.cid).toBe(PDF_CID);
  });

  it("is null when the version has no PDF, or the body is not a manifest", () => {
    expect(
      parseManifestPdf(
        record([file({ path: "source.zip", cid: ZIP_CID, mediaType: "application/zip" })]),
      ),
    ).toBeNull();
    expect(parseManifestPdf(record([]))).toBeNull();
    expect(parseManifestPdf({ id: MANIFEST, body: {} })).toBeNull();
    expect(parseManifestPdf("<html>")).toBeNull();
    expect(parseManifestPdf(null)).toBeNull();
  });
});

describe("loadVersionPdf", () => {
  it("reads the manifest record by its id and returns the PDF", async () => {
    const get = vi.fn().mockResolvedValue(record([file({})]));

    const pdf = await loadVersionPdf(PAPER, { get });

    expect(get).toHaveBeenCalledWith(`/records/${MANIFEST}`, { auth: false, cache: "no-store" });
    expect(pdf?.cid).toBe(PDF_CID);
  });

  it("is null, with no request, when the version record names no manifest", async () => {
    const get = vi.fn();

    expect(await loadVersionPdf({ ...PAPER, manifestCid: null }, { get })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("textAddress", () => {
  it("names the paper by its short id and the version by its number", () => {
    expect(textAddress(PAPER)).toEqual({ paper: "sch:5jmi-pmva-4lmr", version: 2 });
  });

  it("falls back to the genesis record id when the short id could not be derived", () => {
    expect(textAddress({ ...PAPER, shortId: null })).toEqual({
      paper: PAPER.paperCid,
      version: 2,
    });
  });

  it("is null when the record does not say which paper or version it is", () => {
    expect(textAddress({ ...PAPER, shortId: null, paperCid: null })).toBeNull();
    expect(textAddress({ ...PAPER, version: null })).toBeNull();
  });
});

describe("loadVersionText", () => {
  it("reads the text of the version the record names", async () => {
    const get = vi.fn().mockResolvedValue({
      paper: PAPER.shortId,
      version: 2,
      paragraphs: [{ paragraph_id: "p1", position: 0, text: "First." }],
    });

    const text = await loadVersionText(PAPER, { get });

    expect(get).toHaveBeenCalledWith("/papers/sch%3A5jmi-pmva-4lmr/v/2/text", {
      cache: "no-store",
    });
    expect(text.paragraphs).toEqual([{ id: "p1", text: "First." }]);
  });

  it("sends the moderator's bearer token: the text of a version in moderation is 404 without it", async () => {
    tokenStore.set({ accessToken: "moderator-access-token" });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ paragraphs: [{ paragraph_id: "p1", position: 0, text: "First." }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loadVersionText(PAPER);

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer moderator-access-token");
  });

  it("says so, rather than guessing, when the record does not name its paper", async () => {
    const get = vi.fn();

    await expect(loadVersionText({ ...PAPER, version: null }, { get })).rejects.toThrow(
      /which paper and version/,
    );
    expect(get).not.toHaveBeenCalled();
  });
});
