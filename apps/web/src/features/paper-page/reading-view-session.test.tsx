// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveApiBaseUrl, tokenStore } from "../../lib/api";
import { fakePdf } from "./pdf-fixtures";

/**
 * The PDF in the reading column is fetched by PDF.js, which sends no
 * credentials of its own. An unlisted version's bytes are served only to its
 * authors and to moderators, so the column's default loader must hand PDF.js
 * the signed-in reader's token. (PDF.js itself is replaced: jsdom cannot run it.)
 */

const pdf = fakePdf();

vi.mock("./pdf-render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pdf-render")>()),
  loadPdfjs: () => pdf.loadPdf(),
}));

// Imported after the mock so the column's default loader wraps the stand-in.
const { ReadingViewProvider, ReadingViews } = await import("./reading-view");

const PDF_URL = `${resolveApiBaseUrl()}/v1/content/bafkrei-pdf`;

function Column() {
  return (
    <ReadingViewProvider pdfAvailable>
      <ReadingViews pdfUrl={PDF_URL}>
        <p>The paper's text</p>
      </ReadingViews>
    </ReadingViewProvider>
  );
}

beforeEach(() => {
  pdf.getDocument.mockClear();
  window.history.replaceState(null, "", "/p/6sel-2dio-orm6#pdf");
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
  window.history.replaceState(null, "", "/");
});

describe("the reading column's PDF", () => {
  it("is opened with the signed-in reader's bearer token", async () => {
    tokenStore.set({ accessToken: "author-access-token" });

    render(<Column />);

    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalledTimes(1));
    expect(pdf.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: PDF_URL,
        httpHeaders: { Authorization: "Bearer author-access-token" },
      }),
    );
  });

  it("is opened with no credentials when nobody is signed in", async () => {
    render(<Column />);

    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalledTimes(1));
    const [source] = pdf.getDocument.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(source.url).toBe(PDF_URL);
    expect(source).not.toHaveProperty("httpHeaders");
  });
});
