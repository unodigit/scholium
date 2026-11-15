/**
 * The top of the paper page (docs/design.md §5.2):
 *
 * ```text
 * ← cs.AI
 * Can a Meta-Agent Choose the Safer Branch?
 * Mei Zhang · A. Okafor · R. Silva · J. Tan
 * ✓ Reviewed · v2 of 2 · CC BY 4.0
 * [ PDF ] [ HTML ] [ Cite ] [ Download ▾ ]
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
 * - **Invite reviewer** is offered to the paper's authors only, beneath the
 *   four actions (`invite-reviewer.tsx`).
 *
 * Server-safe: no hooks, no state, so the first HTML already has the title and
 * the byline. The one client island, Invite reviewer, renders nothing in that
 * first HTML.
 */

import { DecisionBanner, StatusChip, isPaperStatus } from "../ui-kit";
import type { ReactElement } from "react";
import { licenceLabel } from "../paper-meta/meta";
import { InviteReviewer } from "./invite-reviewer";
import { PaperActions } from "./paper-actions";
import {
  authorDetail,
  authorLabel,
  pdfAccess,
  versionOfTotal,
} from "./paper-facts";
import { archiveHref, categoryHref, citeHref, versionPagePath } from "./paper-links";
import type { PaperPageData } from "./paper-page-data";

export interface PaperHeaderProps {
  readonly data: PaperPageData;
}

export function PaperHeader({ data }: PaperHeaderProps) {
  const { paper, shortId, version, totalVersions } = data;
  const category = paper.categories[0];
  const reviewerCount = data.reviews.ok ? data.reviews.data.count : undefined;
  const pdf = pdfAccess(data.manifest.ok ? data.manifest.data : undefined);

  const statusBanners = buildStatusBanners(data);

  return (
    <header className="ppg-header">
      {statusBanners}
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
        paperId={shortId}
        version={version}
        citeUrl={citeHref(shortId, version)}
        archiveUrl={archiveHref(shortId)}
      />

      {/* A client island that renders nothing unless the reader is on the
          byline, so the first HTML is the same for everyone. */}
      <InviteReviewer
        paperId={shortId}
        version={version}
        categories={paper.categories}
        authorDids={paper.authors.map((author) => author.did)}
      />
    </header>
  );
}


function noticeDecisionKind(kind: string): "retracted" | "corrected" | "removed_legal" | null {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "retraction" || normalized === "retracted") return "retracted";
  if (normalized === "correction" || normalized === "corrected") return "corrected";
  if (
    normalized === "tombstone" ||
    normalized === "tombstoned" ||
    normalized === "withdrawal" ||
    normalized === "withdrawn" ||
    normalized === "removed" ||
    normalized === "removed_legal" ||
    normalized === "removal"
  ) {
    return "removed_legal";
  }
  return null;
}

function buildStatusBanners(data: PaperPageData): ReactElement[] {
  const banners: ReactElement[] = [];

  for (const notice of data.paper.notices ?? []) {
    const kind = noticeDecisionKind(notice.kind);
    if (kind === null) continue;
    const recordCid = typeof notice.id === "string" ? notice.id.trim() : "";
    if (recordCid === "") continue;
    banners.push(
      <DecisionBanner
        key={`notice-${recordCid}`}
        kind={kind}
        recordCid={recordCid}
        reason={typeof notice.reason === "string" && notice.reason.trim() !== "" ? notice.reason.trim() : undefined}
        clause={typeof notice.clause === "string" && notice.clause.trim() !== "" ? notice.clause.trim() : undefined}
        category={typeof notice.category === "string" && notice.category.trim() !== "" ? notice.category.trim() : undefined}
        removedOn={typeof notice.removedOn === "string" && notice.removedOn.trim() !== "" ? notice.removedOn.trim() : undefined}
      />,
    );
  }

  const totalVersions = data.totalVersions;
  if (typeof totalVersions === "number" && totalVersions > data.version) {
    let newestCid = "";
    if (data.versions.ok) {
      const entries = data.versions.data.versions;
      const entry =
        entries.find((item) => item.n === totalVersions) ??
        [...entries].sort((a, b) => b.n - a.n)[0];
      if (entry !== undefined && entry.n > data.version && typeof entry.cid === "string") {
        newestCid = entry.cid.trim();
      }
    }
    if (newestCid !== "") {
      banners.push(
        <DecisionBanner
          key="newer-version"
          kind="newer_version"
          recordCid={newestCid}
          versionHref={versionPagePath(data.shortId, totalVersions)}
          versionLabel={`v${totalVersions}`}
        />,
      );
    }
  }

  // A paper whose status itself records a removal still gets the banner, using
  // the version on screen as the record to open.
  const status = data.paper.status;
  if (status === "tombstoned" || status === "removed" || status === "removed_legal") {
    const recordCid = typeof data.paper.versionCid === "string" ? data.paper.versionCid.trim() : "";
    if (recordCid !== "") {
      banners.push(
        <DecisionBanner
          key="removed-status"
          kind="removed_legal"
          recordCid={recordCid}
        />,
      );
    }
  }

  return banners;
}
