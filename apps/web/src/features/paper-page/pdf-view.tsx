"use client";

/**
 * The PDF of the version on screen, drawn by PDF.js in the reading column
 * (docs/design.md §5.2: `[ PDF ] [ HTML ]`).
 *
 * The pages are stacked down the column, one canvas each, so the page scrolls
 * like any other and the reader's scroll position, find-in-page for the rest
 * of the page, and zoom all keep working. They are drawn **as they come near
 * the viewport** and let go of when they are far from it: not all at once, and
 * not kept, so a long paper costs what is near the reader (a drawn page is
 * megabytes of memory), not what it contains. Every page has its place (and its
 * size, from the first page) from the start, so scrolling does not jump as pages
 * arrive or are let go.
 *
 * It is a view for looking at the paper as typeset. The HTML rendition is the
 * one with selectable, searchable text and the margin markers (and the default
 * for screen readers, docs/design.md §9), and the bar above the pages says so.
 * Each canvas is announced as "Page 3 of 12" and nothing more.
 *
 * Nothing here can break the page: if PDF.js cannot be loaded, or the file
 * cannot be fetched or read, the view says why in a sentence and offers the
 * file in a new tab and a retry. The HTML view is untouched, one click away.
 *
 * What is drawn is an untrusted upload, so `eval` is off for PDF.js; it parses
 * and draws in its own worker, and no script in the file ever runs.
 */

import { useEffect, useRef, useState } from "react";

import {
  describePdfError,
  isRenderCancelled,
  loadPdfjs,
  planPageRender,
  type LoadPdfjs,
  type PdfDocumentLike,
  type PdfLoadingTaskLike,
  type PdfRenderTaskLike,
} from "./pdf-render";

export interface PdfViewProps {
  /** Where the node serves the PDF's bytes. */
  readonly url: string;
  /** How to fetch PDF.js. Tests pass their own. */
  readonly loadPdf?: LoadPdfjs;
}

type Load =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly pdf: PdfDocumentLike;
      /** Width over height of the first page: the shape every page waits in. */
      readonly ratio: number;
    }
  | { readonly phase: "error"; readonly message: string };

/** The shape of a US Letter page, until a real page says otherwise. */
const FALLBACK_RATIO = 612 / 792;

function validRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_RATIO;
}

export function PdfView({ url, loadPdf = loadPdfjs }: PdfViewProps) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // An object, not a `let`: the cleanup reads what the async work wrote, and
    // the compiler cannot see a closure's assignment through a `let`.
    const running: { task: PdfLoadingTaskLike | null } = { task: null };
    setLoad({ phase: "loading" });

    (async () => {
      try {
        const pdfjs = await loadPdf();
        if (cancelled) {
          return;
        }
        running.task = pdfjs.getDocument({ url, isEvalSupported: false });
        const pdf = await running.task.promise;
        if (pdf.numPages < 1) {
          throw Object.assign(new Error("The PDF has no pages."), {
            name: "InvalidPDFException",
          });
        }
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (!cancelled) {
          setLoad({
            phase: "ready",
            pdf,
            ratio: validRatio(first.width / first.height),
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLoad({ phase: "error", message: describePdfError(error) });
        }
      }
    })();

    return () => {
      cancelled = true;
      // Frees the worker's copy of the file. A destroy that fails (it was
      // already torn down, or never got going) has nothing left to free.
      Promise.resolve(running.task?.destroy()).catch(() => {});
    };
  }, [url, loadPdf, attempt]);

  const pages = load.phase === "ready" ? load.pdf.numPages : 0;

  return (
    <section className="ppg-pdf" aria-label="PDF of this version">
      <div className="ppg-pdf-bar">
        {load.phase === "ready" ? (
          <p className="ppg-pdf-summary">
            {pages} {pages === 1 ? "page" : "pages"} · pictures of the pages; the HTML view has
            the text
          </p>
        ) : load.phase === "loading" ? (
          <p className="ppg-pdf-summary" role="status">
            Loading the PDF…
          </p>
        ) : (
          <p className="ppg-pdf-summary" role="status">
            {load.message}
          </p>
        )}
        <a className="ppg-pdf-link" href={url} target="_blank" rel="noopener noreferrer">
          Open in a new tab
        </a>
      </div>

      {load.phase === "error" ? (
        <button
          type="button"
          className="ppg-action ppg-pdf-retry"
          onClick={() => setAttempt((count) => count + 1)}
        >
          Try again
        </button>
      ) : null}

      {load.phase === "ready" ? (
        <ol className="ppg-pdf-pages">
          {Array.from({ length: pages }, (_, index) => (
            <PdfPage
              key={index + 1}
              pdf={load.pdf}
              number={index + 1}
              total={pages}
              ratio={load.ratio}
            />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

interface PdfPageProps {
  readonly pdf: PdfDocumentLike;
  readonly number: number;
  readonly total: number;
  readonly ratio: number;
}

/** One page: a place in the column from the start, drawn when it comes near. */
function PdfPage({ pdf, number, total, ratio }: PdfPageProps) {
  const box = useRef<HTMLLIElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  // The page's own shape once drawn; until then, the first page's.
  const [shape, setShape] = useState(ratio);
  const [failed, setFailed] = useState(false);

  // Near the viewport, with a screenful to spare either side so a page is
  // ready before the reader gets to it. The page is watched for as long as it
  // is on screen at all: it is let go of again once it is far away (below).
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // Several reports can arrive together; the last is how things are now.
        const latest = entries[entries.length - 1];
        if (latest !== undefined) {
          setNear(latest.isIntersecting);
        }
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const holder = box.current;
    if (!near || element === null || holder === null) {
      return;
    }
    let cancelled = false;
    const running: { task: PdfRenderTaskLike | null } = { task: null };
    setFailed(false);

    (async () => {
      try {
        const page = await pdf.getPage(number);
        if (cancelled) {
          return;
        }
        const base = page.getViewport({ scale: 1 });
        const plan = planPageRender({
          pageWidth: base.width,
          pageHeight: base.height,
          containerWidth: holder.clientWidth,
          pixelRatio: window.devicePixelRatio,
        });
        element.width = plan.width;
        element.height = plan.height;
        setShape(plan.width / plan.height);
        running.task = page.render({
          canvas: element,
          viewport: page.getViewport({ scale: plan.scale }),
        });
        await running.task.promise;
      } catch (error) {
        // Leaving, or scrolling away mid-draw, cancels the draw: not a failure.
        if (!cancelled && !isRenderCancelled(error)) {
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      running.task?.cancel();
      // A drawn page is megapixels of memory (a retina page at the column's
      // width is about 11 MB). Resizing a canvas to nothing frees its pixels,
      // so a page that has gone far away costs nothing, and a long paper is
      // never held in memory page by page. The page keeps its place (its
      // box's aspect ratio) and is drawn again if the reader comes back.
      element.width = 0;
      element.height = 0;
    };
  }, [near, pdf, number]);

  return (
    <li
      ref={box}
      className="ppg-pdf-page"
      data-page={number}
      style={{ aspectRatio: validRatio(shape) }}
    >
      <canvas
        ref={canvas}
        className="ppg-pdf-canvas"
        role="img"
        aria-label={`Page ${number} of ${total}`}
      />
      {failed ? (
        <p className="ppg-pdf-page-note" role="status">
          This page could not be drawn.
        </p>
      ) : null}
    </li>
  );
}
