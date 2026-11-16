// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiBaseUrl, tokenStore } from "../../lib/api";
import { fakePdf } from "../paper-page/pdf-fixtures";
import type { ModeratedPaper } from "./decision";
import type { VersionPdf } from "./paper-content";

/**
 * The moderation detail draws the PDF with the paper page's viewer, and PDF.js
 * fetches the file itself, sending no credentials of its own. While the version
 * waits in moderation `GET /v1/content/{cid}` answers `404` to anyone but its
 * authors and moderators, so the view's default loader must hand PDF.js the
 * moderator's token. (PDF.js itself is replaced: jsdom cannot run it.)
 */

const pdfjs = fakePdf({ pages: 1 });

vi.mock("../paper-page/pdf-render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paper-page/pdf-render")>()),
  loadPdfjs: () => pdfjs.loadPdf(),
}));

// Imported after the mock so the default loader wraps the stand-in.
const { ModDetail } = await import("./mod-detail");

const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";
const PDF_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const PAPER: ModeratedPaper = {
  versionCid: VERSION,
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
  manifestCid: "bafyreidjpnwems6u37wwjmckcpcgjiiq5lfghta2ujf3ogs22kcxws7vli",
};

const PDF: VersionPdf = {
  name: "paper.pdf",
  cid: PDF_CID,
  url: `${resolveApiBaseUrl()}/v1/content/${PDF_CID}`,
};

afterEach(() => {
  cleanup();
  tokenStore.clear();
  pdfjs.getDocument.mockClear();
});

function renderDetail() {
  render(
    <ModDetail
      versionCid={VERSION}
      signedIn
      tier={4}
      loadPaper={async () => PAPER}
      loadClauses={async () => []}
      loadText={async () => ({ versionCid: VERSION, paragraphs: [] })}
      loadPdfFile={async () => PDF}
    />,
  );
}

describe("the moderation detail's PDF", () => {
  it("is opened with the moderator's bearer token", async () => {
    tokenStore.set({ accessToken: "moderator-access-token" });

    renderDetail();

    await waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(1));
    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: PDF.url,
        httpHeaders: { Authorization: "Bearer moderator-access-token" },
      }),
    );
    expect(await screen.findByRole("img", { name: "Page 1 of 1" })).toBeTruthy();
  });
});
