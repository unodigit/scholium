/**
 * `paper-page` — the paper page, `/p/{id}` and `/p/{id}/v{n}`
 * (docs/design.md §5.2).
 *
 * The feature owns this module and the route group `app/(paper-page)/`. The
 * two route files are thin: they hand the URL's segments to
 * `renderPaperRoute` and `paperRouteMetadata`.
 *
 * ```tsx
 * import { paperRouteMetadata, renderPaperRoute } from "@/features/paper-page";
 *
 * export const generateMetadata = async ({ params }) =>
 *   paperRouteMetadata([(await params).id]);
 * export default async ({ params }) => renderPaperRoute([(await params).id]);
 * ```
 *
 * The page is the paper's title, authors, status chip, "v2 of 2", licence and
 * the PDF, HTML, Cite and Download actions; a reading column of at most 720 px;
 * and a 360 px margin panel whose tabs are the Reviews, AI, Discussion,
 * Versions, Files and Proof tabs of the features that own them.
 */

export {
  NOT_A_PAPER_ADDRESS,
  paperRouteMetadata,
  renderPaperRoute,
} from "./paper-route";

export {
  PaperPageNotice,
  PaperPageView,
  type PaperPageNoticeProps,
  type PaperPageViewProps,
} from "./paper-page-view";

export { MarginPanel, type MarginPanelProps } from "./margin-panel";
export { PaperActions, type PaperActionsProps } from "./paper-actions";
export { PaperHeader, type PaperHeaderProps } from "./paper-header";
export { ReadingColumn, type ReadingColumnProps } from "./reading-column";

export {
  DEFAULT_LOADERS,
  describePageError,
  loadPaperPageData,
  type PaperPageData,
  type PaperPageLoaders,
  type Part,
} from "./paper-page-data";

export { parsePaperAddress, type PaperAddress } from "./paper-address";

export {
  authorDetail,
  authorLabel,
  latestVersionNumber,
  pdfAccess,
  shortDid,
  versionOfTotal,
  type PdfAccess,
} from "./paper-facts";

export {
  MARGIN_TAB_IDS,
  READING_ID,
  archiveHref,
  categoryHref,
  citeHref,
  isMarginTabId,
  tabFromHash,
  tabHash,
  versionPagePath,
  type MarginTabId,
} from "./paper-links";

export {
  ReadingResponseError,
  describeReadingError,
  loadReadingText,
  parseReadingText,
  readingPath,
  type ReadingParagraph,
  type ReadingText as ReadingTextData,
} from "./reading";
