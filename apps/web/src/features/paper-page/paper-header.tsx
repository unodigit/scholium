/**
 * The top of the paper page (docs/design.md §5.2):
 *
 * ```text
 * ← cs.AI
 * Can a Meta-Agent Choose the Safer Branch?
 * Mei Zhang · A. Okafor · R. Silva · J. Tan
 * ✓ Reviewed · v2 of 2 · CC BY 4.0
 * [ PDF ] [ HTML ] [ Cite ] [ Download ]
 * ```
 *
 * The paper comes first (principle 1): the title is the page's `<h1>` in the
 * reading serif, and everything around it is one quiet line each.
 *
 * - **Authors** are the names people saved in their profile, falling back to
 *   the DID when there is none (`authorLabel`). The list has a real, visually
 *   hidden "Authors" heading, so it is a section a screen-reader user can jump
 *   to, and each name carries the affiliation, roles and full DID as its
 *   title.
 * - **Status** is the chip with its icon and word (never colour alone), with
 *   the reviewer count on "Under review".
 * - **Version** reads `v2 of 2`, from the version timeline; if the timeline
 *   could not be read it is just `v2`.
 * - **Licence** is the signed version's, in words (`CC BY 4.0`).
 *
 * Server-safe: no hooks, no state, so the first HTML already has the title and
 * the byline.
 */

import { StatusChip, isPaperStatus } from "../ui-kit";
import { licenceLabel } from "../paper-meta/meta";
import { PaperActions } from "./paper-actions";
import {
  authorDetail,
  authorLabel,
  pdfAccess,
  versionOfTotal,
} from "./paper-facts";
import { archiveHref, categoryHref, citeHref } from "./paper-links";
import type { PaperPageData } from "./paper-page-data";

export interface PaperHeaderProps {
  readonly data: PaperPageData;
}

export function PaperHeader({ data }: PaperHeaderProps) {
  const { paper, shortId, version, totalVersions } = data;
  const category = paper.categories[0];
  const reviewerCount = data.reviews.ok ? data.reviews.data.count : undefined;
  const pdf = pdfAccess(data.manifest.ok ? data.manifest.data : undefined);

  return (
    <header className="ppg-header">
      {category !== undefined ? (
        <p className="ppg-back">
          <a href={categoryHref(category)}>
            <span aria-hidden="true">← </span>
            {category}
            <span className="ppg-visually-hidden"> papers</span>
          </a>
        </p>
      ) : null}

      <h1 id="ppg-title" className="ppg-title">
        {paper.title}
      </h1>

      <section className="ppg-authors" aria-labelledby="ppg-authors-heading">
        <h2 id="ppg-authors-heading" className="ppg-visually-hidden">
          Authors
        </h2>
        {paper.authors.length === 0 ? (
          <p className="ppg-authors-empty">No authors are listed for this version.</p>
        ) : (
          <ol className="ppg-byline">
            {paper.authors.map((author, index) => (
              <li
                className="ppg-author"
                key={`${author.did}-${index}`}
                title={authorDetail(author)}
              >
                {authorLabel(author)}
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="ppg-facts">
        {isPaperStatus(paper.status) ? (
          <StatusChip status={paper.status} count={reviewerCount} />
        ) : null}
        <span className="ppg-fact ppg-version">
          {versionOfTotal(version, totalVersions)}
        </span>
        <span className="ppg-fact ppg-licence">{licenceLabel(paper.licence)}</span>
      </p>

      <PaperActions
        pdf={pdf}
        citeUrl={citeHref(shortId, version)}
        archiveUrl={archiveHref(shortId)}
      />
    </header>
  );
}
