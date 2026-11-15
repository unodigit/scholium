/**
 * The reading column (docs/design.md §5.2): the paper itself, at most 720 px
 * wide, in the reading serif at 18/30 with lines capped at 72 characters.
 *
 * It shows the abstract first and then the version's text as paragraphs, each
 * with a margin marker when it has been annotated. The column is the HTML
 * rendition the HTML action points at (`#reading`); a screen reader gets it as
 * real paragraphs, not a PDF.
 *
 * If the text cannot be shown the column says so and keeps the abstract, which
 * is the part of the paper every version has. "Not available" (the node has no
 * text for this version) and "could not be loaded" (the read failed; reloading
 * may help) are different sentences, so the reader knows whether to wait.
 *
 * Server-safe except for {@link ReadingText}, the client island that owns the
 * paragraphs' markers and the `A` shortcut.
 */

import { READING_ID } from "./paper-links";
import type { PaperPageData } from "./paper-page-data";
import { ReadingText } from "./reading-text";

export interface ReadingColumnProps {
  readonly data: PaperPageData;
}

export function ReadingColumn({ data }: ReadingColumnProps) {
  const { paper, reading, shortId, version } = data;
  const paragraphs = reading.ok ? reading.data.paragraphs : [];

  return (
    <section
      id={READING_ID}
      className="ppg-reading"
      aria-label="Paper text"
      tabIndex={-1}
    >
      <section className="ppg-abstract" aria-labelledby="ppg-abstract-heading">
        <h2 id="ppg-abstract-heading" className="ppg-section-title">
          Abstract
        </h2>
        <p className="ppg-abstract-body">
          {paper.abstract.trim() !== ""
            ? paper.abstract
            : "This version has no abstract."}
        </p>
      </section>

      {paragraphs.length > 0 ? (
        <ReadingText
          paperId={shortId}
          version={version}
          versionCid={paper.versionCid}
          paragraphs={paragraphs}
        />
      ) : (
        <p className="ppg-reading-note" role={reading.ok ? undefined : "status"}>
          {reading.ok
            ? "The text of this version is not available to read here. Open the PDF to read it."
            : reading.error}
        </p>
      )}
    </section>
  );
}
