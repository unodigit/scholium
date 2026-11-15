/**
 * The paper page (docs/design.md §5.2): the paper on the left, its margin on
 * the right.
 *
 * ```text
 * ┌─────────────────────────────────────┬──────────────────────────┐
 * │ header: title, authors, status…     │ ✓ Verified   Details ›   │
 * │ reading column (max 720 px)         │ tabs (360 px)            │
 * └─────────────────────────────────────┴──────────────────────────┘
 * ```
 *
 * From 1280 px the two sit side by side: a reading column of at most 720 px
 * and a 360 px margin panel that stays in view while the paper scrolls. Below
 * that the page is one column and the margin panel follows the text.
 *
 * Server-safe, so a shared link shows the title, the byline and the abstract
 * in the first HTML response and works before JavaScript loads. The only
 * client islands are the margin panel and the paragraphs' markers.
 */

import { MarginPanel } from "./margin-panel";
import { PaperHeader } from "./paper-header";
import type { PaperPageData } from "./paper-page-data";
import { ReadingColumn } from "./reading-column";
import "./paper-page.css";

export interface PaperPageViewProps {
  readonly data: PaperPageData;
}

export function PaperPageView({ data }: PaperPageViewProps) {
  return (
    <div className="ppg">
      <div className="ppg-main">
        <PaperHeader data={data} />
        <ReadingColumn data={data} />
      </div>
      <aside className="ppg-margin" aria-label="Margin of the paper">
        <MarginPanel
          shortId={data.shortId}
          version={data.version}
          versionId={data.versionId}
          versionCid={data.paper.versionCid}
          reviews={data.reviews}
          discussion={data.discussion}
          versions={data.versions}
          manifest={data.manifest}
        />
      </aside>
    </div>
  );
}

export interface PaperPageNoticeProps {
  /** One sentence saying why there is no paper to show. */
  readonly message: string;
}

/**
 * The page when there is no paper to show: a bad address, a paper this node
 * does not list, a node that cannot be reached. One honest message and a way
 * back, rather than an empty shell.
 */
export function PaperPageNotice({ message }: PaperPageNoticeProps) {
  return (
    <section className="ppg-notice" role="alert">
      <h1 className="ppg-notice-title">Paper unavailable</h1>
      <p className="ppg-notice-message">{message}</p>
      <a className="ppg-notice-link" href="/search">
        Back to search
      </a>
    </section>
  );
}
