/**
 * What the PDF view needs that is not React: loading PDF.js, sizing a page's
 * canvas, and saying in words why a PDF could not be shown.
 *
 * - **PDF.js loads only when a reader asks for the PDF** ({@link loadPdfjs}): it
 *   and its worker are large, and most readers read the HTML. It is never
 *   imported while the page is server-rendered.
 * - The viewer asks for only the parts of PDF.js it calls (the `Like` types
 *   below are `Pick`s of PDF.js's own types, erased at build time), so it does
 *   not depend on the rest of PDF.js's surface and a test can stand a small
 *   fake in for a real document.
 *
 * Pure data and functions (plus the loader), no React.
 */

import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";

/** One page of a PDF: its size, and drawing it. */
export type PdfPageLike = Pick<PDFPageProxy, "getViewport" | "render">;

/** A loaded PDF. */
export type PdfDocumentLike = Pick<PDFDocumentProxy, "numPages"> & {
  getPage(number: number): Promise<PdfPageLike>;
};

/** A running draw of one page. */
export type PdfRenderTaskLike = Pick<RenderTask, "promise" | "cancel">;

/** A PDF being fetched and parsed. */
export type PdfLoadingTaskLike = Pick<PDFDocumentLoadingTask, "destroy"> & {
  readonly promise: Promise<PdfDocumentLike>;
};

/** The slice of PDF.js the viewer calls. */
export interface PdfjsLike {
  getDocument(source: {
    url: string;
    /** Off: PDF.js need not `eval` anything to draw an untrusted file. */
    isEvalSupported?: boolean;
  }): PdfLoadingTaskLike;
}

/** Loads PDF.js. Rejects if it cannot be fetched or started. */
export type LoadPdfjs = () => Promise<PdfjsLike>;

/**
 * Fetch PDF.js and point it at its worker.
 *
 * The worker is a separate file PDF.js starts to parse and draw off the main
 * thread; the bundler emits it next to the page's other assets and
 * `new URL(…, import.meta.url)` is how it is told where.
 */
export const loadPdfjs: LoadPdfjs = async () => {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }
  return pdfjs;
};

/* -------------------------------------------------------------------------- */
/* Sizing                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The most pixels one page's canvas may have (16 Mpx). A browser refuses, or
 * silently blanks, a canvas much larger than this, and a poster-sized page at
 * a high pixel ratio would ask for one.
 */
export const MAX_CANVAS_PIXELS = 16_777_216;

/** The highest pixel ratio drawn for. Above 2 the extra sharpness is not worth the memory. */
export const MAX_PIXEL_RATIO = 2;

export interface PageRenderPlan {
  /** The scale to ask PDF.js's viewport for: CSS fit times pixel ratio. */
  readonly scale: number;
  /** The canvas's width in device pixels. */
  readonly width: number;
  /** The canvas's height in device pixels. */
  readonly height: number;
}

/**
 * How to draw a page so it fills `containerWidth` and stays sharp on a dense
 * screen.
 *
 * The canvas is drawn at `containerWidth × pixelRatio` and shown at the
 * container's width by CSS, so it is crisp without being measured again when
 * the window changes size. A page that would need more than
 * {@link MAX_CANVAS_PIXELS} is drawn smaller rather than not at all.
 *
 * `pageWidth` and `pageHeight` are the page at scale 1. A width or size that
 * is not a positive number (a container not laid out yet, a broken page) falls
 * back to the page's own size, so a plan is always a drawable canvas.
 */
export function planPageRender(input: {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly containerWidth: number;
  readonly pixelRatio: number;
}): PageRenderPlan {
  const pageWidth = input.pageWidth > 0 ? input.pageWidth : 612;
  const pageHeight = input.pageHeight > 0 ? input.pageHeight : 792;
  const containerWidth = input.containerWidth > 0 ? input.containerWidth : pageWidth;
  const ratio = Math.min(
    Math.max(input.pixelRatio > 0 ? input.pixelRatio : 1, 1),
    MAX_PIXEL_RATIO,
  );

  let scale = (containerWidth / pageWidth) * ratio;
  const pixels = pageWidth * scale * (pageHeight * scale);
  if (pixels > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  }
  return {
    scale,
    width: Math.max(1, Math.floor(pageWidth * scale)),
    height: Math.max(1, Math.floor(pageHeight * scale)),
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A field of a thrown value, if it is an object that has it.
 *
 * PDF.js's exceptions are read by their `name` and fields, not with
 * `instanceof`: the ones that come back from its worker are rebuilt on this
 * side, and a test's stand-in is just an object with a name.
 */
function field(error: unknown, key: "name" | "status" | "missing"): unknown {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** A render that was cancelled (the reader left, or scrolled away) is not a failure. */
export function isRenderCancelled(error: unknown): boolean {
  return field(error, "name") === "RenderingCancelledException";
}

/**
 * One plain sentence for why the PDF could not be shown here.
 *
 * PDF.js names its failures (`name`), and that is what is read here: the
 * wording of its messages is for developers. Each sentence says what is wrong
 * with the file or the server, and the viewer always offers the file in a new
 * tab beside it, so none needs to say what to do next.
 */
export function describePdfError(error: unknown): string {
  const name = field(error, "name");

  if (name === "ResponseException") {
    const status = Number(field(error, "status"));
    return field(error, "missing") === true || status === 404 || status === 410
      ? "This server no longer has the PDF."
      : "The server could not send the PDF.";
  }
  if (name === "InvalidPDFException") {
    return "This file is not a PDF the viewer can read.";
  }
  if (name === "PasswordException") {
    return "This PDF is password-protected, so it cannot be shown here.";
  }
  return "The PDF could not be shown here.";
}
