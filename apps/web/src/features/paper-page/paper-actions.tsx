/**
 * The header's four actions: PDF, HTML, Cite and Download
 * (docs/design.md §5.2: `[ PDF ] [ HTML ] [ Cite ] [ Download ]`).
 *
 * Each one is a real link, so the row works before any JavaScript runs and is
 * reachable by keyboard like any other link:
 *
 * - **PDF** opens the version's PDF file, served by the node, in a new tab.
 *   What the browser then does with it (show it or save it) is the node's
 *   content endpoint's call: it serves every file inert, as a sandboxed,
 *   unsniffed download, because uploads are untrusted. Reading the PDF on the
 *   page itself is a later feature (a PDF.js view). When the PDF cannot be
 *   opened (no PDF, still being scanned, scan failed) the word stays and says
 *   why, in text, rather than becoming a button that does nothing.
 * - **HTML** is the rendition the page is already showing, so it is marked as
 *   the current view and jumps to the reading column.
 * - **Cite** opens the BibTeX of this exact version.
 * - **Download** saves the paper's archive.
 *
 * Cite and Download are plain links for now; the Cite dialog (BibTeX and RIS,
 * copy) and the Download menu are a later feature that replaces these two
 * elements and keeps the endpoints.
 *
 * Server-safe: no hooks, no state.
 */

import type { PdfAccess } from "./paper-facts";
import { READING_ID } from "./paper-links";

export interface PaperActionsProps {
  /** Whether, and where, the PDF can be opened. */
  readonly pdf: PdfAccess;
  /** The BibTeX of the version on screen. */
  readonly citeUrl: string;
  /** The paper's archive. */
  readonly archiveUrl: string;
}

export function PaperActions({ pdf, citeUrl, archiveUrl }: PaperActionsProps) {
  return (
    <div className="ppg-actions-block">
      <div className="ppg-actions" role="group" aria-label="Read, cite and download">
        {pdf.kind === "available" ? (
          <a
            className="ppg-action"
            href={pdf.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            PDF
            <span className="ppg-visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          // A link with no destination: announced as a disabled link, and the
          // reason is on the page below, not only in a tooltip.
          <a
            className="ppg-action"
            role="link"
            aria-disabled="true"
            aria-describedby="ppg-pdf-note"
          >
            PDF
          </a>
        )}
        <a className="ppg-action" href={`#${READING_ID}`} aria-current="true">
          HTML
        </a>
        <a
          className="ppg-action"
          href={citeUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Cite
          <span className="ppg-visually-hidden"> as BibTeX (opens in a new tab)</span>
        </a>
        <a
          className="ppg-action"
          href={archiveUrl}
          download
          title="The whole paper as one archive: its signed records, files and log entries."
        >
          Download
        </a>
      </div>
      {pdf.kind === "unavailable" ? (
        <p id="ppg-pdf-note" className="ppg-actions-note">
          {pdf.reason}
        </p>
      ) : null}
    </div>
  );
}
