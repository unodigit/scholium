/**
 * `/p/{id}` — the paper page a `sch:` id in the search field opens
 * (feature 184).
 *
 * The page leads with what the reader came for: the title, its standing, and
 * an **Authors** section that names the people behind the version. The
 * catalog stores author DIDs; the profile service turns those into names, so
 * the Authors section shows each person's saved profile name, falling back to
 * the DID when there is no public profile (never saved, erased, or
 * unreachable). The DID is still a real identity, so showing it is honest —
 * inventing a name would not be.
 *
 * This is the presentational half: `paper.ts` fetches and parses, the route
 * file in `app/(search-page)/p/[...ref]` calls it on the server. Rendering is
 * server-safe (no hooks), like the ui-kit components, so a shared paper link
 * works before JavaScript loads.
 */

import { IdPill, StatusChip, isPaperStatus } from "../ui-kit";
import type { PaperView } from "./paper";
import "./paper-page.css";

/** Props for {@link PaperPage}. */
export interface PaperPageProps {
  /** The paper to show. Absent when the lookup failed. */
  readonly paper?: PaperView;
  /** A sentence explaining why the paper is not shown. */
  readonly error?: string;
}

/**
 * The paper page: title, status, version, Authors, abstract and notices.
 *
 * When `paper` is absent it renders a single honest message and a way back to
 * search, rather than an empty shell.
 */
export function PaperPage({ paper, error }: PaperPageProps) {
  if (paper === undefined) {
    return (
      <section className="sp-paper-error" role="alert">
        <h1 className="sp-paper-error-title">Paper unavailable</h1>
        <p className="sp-paper-error-message">
          {error ?? "The paper could not be loaded."}
        </p>
        <a className="sp-paper-back" href="/search">
          Back to search
        </a>
      </section>
    );
  }

  const facts = [
    paper.categories.length > 0 ? paper.categories.join(", ") : "",
    paper.licence !== "" ? paper.licence : "",
  ].filter((fact) => fact !== "");

  return (
    <article className="sp-paper" aria-labelledby="sp-paper-title">
      <header className="sp-paper-header">
        {paper.shortId !== "" ? (
          <div className="sp-paper-id">
            <IdPill schId={paper.shortId} />
          </div>
        ) : null}
        <h1 id="sp-paper-title" className="sp-paper-title">
          {paper.title}
        </h1>
        <div className="sp-paper-badges">
          {isPaperStatus(paper.status) ? (
            <StatusChip status={paper.status} />
          ) : null}
          <span className="sp-paper-version">Version {paper.n}</span>
        </div>
        {facts.length > 0 ? (
          <p className="sp-paper-facts">{facts.join(" · ")}</p>
        ) : null}
      </header>

      <section className="sp-authors" aria-labelledby="sp-authors-heading">
        <h2 id="sp-authors-heading" className="sp-authors-heading">
          Authors
        </h2>
        {paper.authors.length === 0 ? (
          <p className="sp-authors-empty">
            No authors are listed for this version.
          </p>
        ) : (
          <ol className="sp-author-list">
            {paper.authors.map((author, index) => (
              <li className="sp-author" key={`${author.did}-${index}`}>
                <span className="sp-author-name">
                  {author.name ?? author.did}
                </span>
                {author.affiliation !== null ? (
                  <span className="sp-author-affiliation">
                    {author.affiliation}
                  </span>
                ) : null}
                {author.creditRoles.length > 0 ? (
                  <span className="sp-author-roles">
                    {author.creditRoles.join(" · ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="sp-abstract" aria-labelledby="sp-abstract-heading">
        <h2 id="sp-abstract-heading" className="sp-abstract-heading">
          Abstract
        </h2>
        <p className="sp-abstract-body">
          {paper.abstract !== ""
            ? paper.abstract
            : "This version has no abstract."}
        </p>
      </section>

      {paper.notices.length > 0 ? (
        <section className="sp-notices" aria-labelledby="sp-notices-heading">
          <h2 id="sp-notices-heading" className="sp-notices-heading">
            Notices
          </h2>
          <ul className="sp-notice-list">
            {paper.notices.map((notice, index) => (
              <li className="sp-notice" key={`${notice.id}-${index}`}>
                <strong className="sp-notice-kind">{notice.kind}</strong>
                {notice.reason !== "" ? (
                  <span className="sp-notice-reason">{notice.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

export default PaperPage;
