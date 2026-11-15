/**
 * The paper, on the left of the review form (docs/design.md §5.5).
 *
 * The reviewer reads the HTML rendition here while they fill in the rubric on
 * the right: the paper's id, version and categories, its abstract, then the
 * full text paragraph by paragraph. Each paragraph carries its stable id as
 * `data-paragraph-id`, which is what a citation in the review will name.
 *
 * If the node has no text for this version the pane says so and the form still
 * works: a reviewer may be reading the PDF instead.
 *
 * Server-safe (the id pill is the only client piece, and it brings its own
 * `"use client"`).
 */

import { IdPill } from "../ui-kit/id-pill";
import type { ReviewPaper } from "./paper";

export function PaperPane({ paper }: { paper: ReviewPaper }) {
  return (
    <article className="rf-paper" aria-label="The paper under review">
      <p className="rf-paper-meta meta">
        <IdPill schId={paper.shortId} />
        <span>Version {paper.version}</span>
        {paper.categories.length > 0 ? (
          <span>{paper.categories.join(", ")}</span>
        ) : null}
      </p>

      {paper.abstract !== "" ? (
        <section className="rf-paper-section" aria-labelledby="rf-abstract-heading">
          <h2 id="rf-abstract-heading" className="rf-pane-heading">
            Abstract
          </h2>
          <p className="reading rf-abstract">{paper.abstract}</p>
        </section>
      ) : null}

      <section className="rf-paper-section" aria-labelledby="rf-text-heading">
        <h2 id="rf-text-heading" className="rf-pane-heading">
          Full text
        </h2>
        <PaperText paragraphs={paper.paragraphs} />
      </section>
    </article>
  );
}

function PaperText({ paragraphs }: { paragraphs: ReviewPaper["paragraphs"] }) {
  if (paragraphs === null) {
    return (
      <p className="rf-paper-note" role="status">
        The full text of this version could not be loaded here. You can still
        write your review; read the paper from its page or the PDF.
      </p>
    );
  }
  if (paragraphs.length === 0) {
    return (
      <p className="rf-paper-note">This version has no text to show.</p>
    );
  }
  return (
    <div className="rf-paper-text">
      {paragraphs.map((paragraph, index) => (
        <p
          // The id is a hash of the text, so a repeated paragraph repeats it.
          key={`${index}:${paragraph.id}`}
          className="reading rf-paragraph"
          data-paragraph-id={paragraph.id}
        >
          {paragraph.text}
        </p>
      ))}
    </div>
  );
}
