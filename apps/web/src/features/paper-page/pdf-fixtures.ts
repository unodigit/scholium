/**
 * A stand-in for PDF.js, for the PDF view's tests.
 *
 * jsdom has no canvas and the real PDF.js needs a browser, so the viewer's
 * tests give it a document that answers like one: pages of a known size, a
 * `render` that records what it was asked to draw, and a loading task that
 * records being destroyed. `loadPdf` is the `LoadPdfjs` to pass the viewer.
 *
 * The one cast to PDF.js's own types is here, so a test reads as plain data.
 */

import { vi } from "vitest";

import type {
  LoadPdfjs,
  PdfDocumentLike,
  PdfLoadingTaskLike,
  PdfPageLike,
  PdfRenderTaskLike,
} from "./pdf-render";

export interface FakePdfOptions {
  /** How many pages the document has. Default 3. */
  readonly pages?: number;
  /** A page's size at scale 1. Default US Letter in points. */
  readonly width?: number;
  readonly height?: number;
  /** Reject the load (`getDocument(…).promise`) with this. */
  readonly loadFails?: unknown;
  /** Reject loading PDF.js itself with this. */
  readonly importFails?: unknown;
  /** Reject every page's draw with this. */
  readonly renderFails?: unknown;
}

export interface FakePdf {
  readonly loadPdf: LoadPdfjs;
  /** `getDocument`, to read the URL it was given. */
  readonly getDocument: ReturnType<typeof vi.fn>;
  /** The loading task's `destroy`, to see the file was released. */
  readonly destroy: ReturnType<typeof vi.fn>;
  /** `page.render`, to see what was drawn where. */
  readonly render: ReturnType<typeof vi.fn>;
  /** The cancel of every draw that was started. */
  readonly cancel: ReturnType<typeof vi.fn>;
  /** `document.getPage`, to see which pages were asked for. */
  readonly getPage: ReturnType<typeof vi.fn>;
}

export function fakePdf(options: FakePdfOptions = {}): FakePdf {
  const { pages = 3, width = 612, height = 792 } = options;
  const cancel = vi.fn();
  const destroy = vi.fn(async () => {});

  const render = vi.fn((): PdfRenderTaskLike => ({
    promise:
      options.renderFails !== undefined
        ? Promise.reject(options.renderFails)
        : Promise.resolve(),
    cancel,
  }));

  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    }),
    render,
  } as unknown as PdfPageLike;

  const getPage = vi.fn(async () => page);
  const document: PdfDocumentLike = { numPages: pages, getPage };

  const getDocument = vi.fn((): PdfLoadingTaskLike => ({
    promise:
      options.loadFails !== undefined
        ? Promise.reject(options.loadFails)
        : Promise.resolve(document),
    destroy,
  }));

  const loadPdf: LoadPdfjs = async () => {
    if (options.importFails !== undefined) {
      throw options.importFails;
    }
    return { getDocument };
  };

  return { loadPdf, getDocument, destroy, render, cancel, getPage };
}
