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
 * that the page is one column and the margin panel is put away until asked
 * for: a collapsible drawer from 1024 to 1279 px, a bottom sheet with the same
 * tabs under 1024 px (`margin-drawer.tsx`). Before JavaScript runs it simply
 * follows the text.
 *
 * Server-safe, so a shared link shows the title, the byline and the abstract
 * in the first HTML response and works before JavaScript loads. The only
 * client islands are the margin panel (and its frame) and the paragraphs'
 * markers.
 */

import { MarginDrawer } from "./margin-drawer";
import { MarginPanel } from "./margin-panel";
import { pdfAccess } from "./paper-facts";
import { PaperHeader } from "./paper-header";
import type { PaperPageData } from "./paper-page-data";
import { ReadingColumn } from "./reading-column";
import { ReadingViewProvider } from "./reading-view";
import "./paper-page.css";

export interface PaperPageViewProps {
  readonly data: PaperPageData;
}

export function PaperPageView({ data }: PaperPageViewProps) {
  const pdf = pdfAccess(data.manifest.ok ? data.manifest.data : undefined);

  return (
    <div className="ppg">
      <div className="ppg-main">
        {/* The header's PDF and HTML actions and the column share which
            rendition is showing, so the provider sits above both. */}
        <ReadingViewProvider pdfAvailable={pdf.kind === "available"}>
          <PaperHeader data={data} />
          <ReadingColumn data={data} />
        </ReadingViewProvider>
      </div>
      <MarginDrawer>
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
      </MarginDrawer>
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
