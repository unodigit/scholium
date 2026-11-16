"use client";

/**
 * The paper itself in the moderation detail view: its PDF, drawn by the paper
 * page's PDF viewer, and its extracted text (docs/design.md §5.7, "Detail view
 * shows the paper beside a decision form").
 *
 * Both are fetched in the browser with the moderator's token, because neither
 * is public while the version waits in moderation (see `paper-content.ts`).
 * They load independently of each other and of the form: a PDF that cannot be
 * read says why and offers a retry, and the text and the decision form carry
 * on. A moderator is never left with a blank where the paper should be, and
 * never locked out of deciding by a slow download.
 *
 * The text is plain paragraphs, not the paper page's annotated reading column:
 * a moderator reads it, and has no use for margin markers or the `A` shortcut
 * on a version nobody has seen yet.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { PdfView } from "../paper-page/pdf-view";
import type { LoadPdfjs } from "../paper-page/pdf-render";
import {
  describeReadingError,
  loadPdfjsWithSession,
  type ReadingText,
} from "../paper-page/reading";
import type { ModeratedPaper } from "./decision";
import {
  loadVersionPdf,
  loadVersionText,
  type VersionPdf,
} from "./paper-content";
// The PDF viewer's own rules (`ppg-pdf*`); the console draws it unchanged.
import "../paper-page/paper-page.css";
import "./mod-console.css";

/** Reads the version's text; replaceable in tests. */
export type LoadText = (paper: ModeratedPaper) => Promise<ReadingText>;

/** Finds the version's PDF; replaceable in tests. */
export type LoadPdfFile = (paper: ModeratedPaper) => Promise<VersionPdf | null>;

/** Props for {@link VersionContent}. */
export interface VersionContentProps {
  readonly paper: ModeratedPaper;
  readonly loadText?: LoadText;
  readonly loadPdfFile?: LoadPdfFile;
  /** How to fetch PDF.js; the default opens the file with the moderator's token. */
  readonly loadPdfjs?: LoadPdfjs;
}

type Remote<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed"; readonly message: string };

/**
 * One read for the view: `loading` until it settles, then its value or the
 * sentence for why there is none. `retry` asks again.
 */
function useRemote<T>(
  read: () => Promise<T>,
  describe: (error: unknown) => string,
): { state: Remote<T>; retry: () => void } {
  const [state, setState] = useState<Remote<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    read().then(
      (value) => {
        if (!cancelled) {
          setState({ status: "ready", value });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", message: describe(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `read` and `describe` are rebuilt on every render; only a new paper or a
    // retry starts the read over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return { state, retry };
}

/** The PDF and the text of one version, each with its own loading and failure. */
export function VersionContent({
  paper,
  loadText = loadVersionText,
  loadPdfFile = loadVersionPdf,
  loadPdfjs = loadPdfjsWithSession,
}: VersionContentProps) {
  return (
    <div className="mc-content">
      <PdfSection paper={paper} loadPdfFile={loadPdfFile} loadPdfjs={loadPdfjs} />
      <TextSection paper={paper} loadText={loadText} />
    </div>
  );
}

function describePdfError(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? `The PDF's file list could not be read. ${error.message}`
    : "The PDF's file list could not be read.";
}

function PdfSection({
  paper,
  loadPdfFile,
  loadPdfjs,
}: {
  paper: ModeratedPaper;
  loadPdfFile: LoadPdfFile;
  loadPdfjs: LoadPdfjs;
}) {
  const headingId = useId();
  const { state, retry } = useRemote(() => loadPdfFile(paper), describePdfError);

  return (
    <section className="mc-content-card" aria-labelledby={headingId}>
      <p className="mc-section-kicker">The paper</p>
      <h2 id={headingId} className="mc-content-title">
        PDF
      </h2>

      {state.status === "loading" ? (
        <p className="mc-paper-muted" role="status">
          Loading the PDF…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <div className="mc-content-note">
          <p className="mc-paper-muted" role="status">
            {state.message}
          </p>
          <button type="button" className="mc-button mc-button--quiet" onClick={retry}>
            Try the PDF again
          </button>
        </div>
      ) : null}

      {state.status === "ready" && state.value === null ? (
        <p className="mc-paper-muted" role="status">
          This version has no PDF to show. Its files are listed in the signed
          record.
        </p>
      ) : null}

      {state.status === "ready" && state.value !== null ? (
        <PdfView url={state.value.url} loadPdf={loadPdfjs} />
      ) : null}
    </section>
  );
}

function TextSection({
  paper,
  loadText,
}: {
  paper: ModeratedPaper;
  loadText: LoadText;
}) {
  const headingId = useId();
  const { state, retry } = useRemote(() => loadText(paper), describeReadingError);

  return (
    <section className="mc-content-card" aria-labelledby={headingId}>
      <p className="mc-section-kicker">The paper</p>
      <h2 id={headingId} className="mc-content-title">
        Extracted text
      </h2>

      {state.status === "loading" ? (
        <p className="mc-paper-muted" role="status">
          Loading the text…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <div className="mc-content-note">
          <p className="mc-paper-muted" role="status">
            {state.message}
          </p>
          <button type="button" className="mc-button mc-button--quiet" onClick={retry}>
            Try the text again
          </button>
        </div>
      ) : null}

      {state.status === "ready" && state.value.paragraphs.length === 0 ? (
        <p className="mc-paper-muted" role="status">
          No text has been extracted for this version yet. The PDF above is the
          paper as submitted.
        </p>
      ) : null}

      {state.status === "ready" && state.value.paragraphs.length > 0 ? (
        // A scrollable region is not reachable by keyboard unless it takes
        // focus itself, so it is a labelled, focusable region.
        <div
          className="mc-text"
          role="region"
          aria-label="Text of this version"
          tabIndex={0}
        >
          {state.value.paragraphs.map((paragraph) => (
            <p key={paragraph.id} className="mc-text-paragraph">
              {paragraph.text}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default VersionContent;
