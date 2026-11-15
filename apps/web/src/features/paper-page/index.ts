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
 *
 * The reading column shows the version's text as HTML paragraphs (from
 * `GET /v1/papers/{id}/v/{n}/text`) with the math typeset by KaTeX, and the PDF
 * and HTML actions switch it between that and the PDF drawn by PDF.js.
 *
 * The Versions tab links to `/p/{id}/compare/{from}..{to}`, the paragraph diff
 * the node computes for that pair (`GET /v1/papers/{id}/compare`): changed,
 * added and removed paragraphs plus both versions' change notes.
 *
 * Authors on the byline also get an **Invite reviewer** action under the
 * header's four, which sends a reviewer's DID to
 * `POST /v1/papers/{id}/review-invitations` for the version on screen.
 *
 * **Cite** opens a dialog with the version on screen as BibTeX and as RIS, each
 * read from `GET /v1/papers/{id}/cite?format=bibtex|ris` and copied with a
 * click; **Download** opens a menu whose item saves the paper's archive
 * (`GET /v1/export/paper/{id}.car`). Both are plain links until the page runs.
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
export {
  MARGIN_BODY_ID,
  MARGIN_TOGGLE_LABEL,
  MarginDrawer,
  type MarginDrawerProps,
} from "./margin-drawer";
export { PaperActions, type PaperActionsProps } from "./paper-actions";
export {
  CITE_DIALOG_TITLE,
  CITE_LABEL,
  COPIED_FOR_MS,
  CiteDialog,
  type CiteDialogProps,
} from "./cite-dialog";
export {
  ARCHIVE_ITEM_HINT,
  ARCHIVE_ITEM_LABEL,
  DOWNLOAD_LABEL,
  DownloadMenu,
  type DownloadMenuProps,
} from "./download-menu";
export {
  CITE_FORMATS,
  CitationResponseError,
  citeFormat,
  citePath,
  describeCiteError,
  loadCitation,
  parseCitation,
  type CiteClient,
  type CiteFormat,
  type CiteFormatId,
  type LoadCitation,
} from "./cite";
export { InviteReviewer, type InviteReviewerProps } from "./invite-reviewer";
export {
  INVITEE_PROBLEMS,
  INVITE_LABEL,
  INVITE_SUBMIT_LABEL,
  NOT_INVITED,
  canInvite,
  checkInvitee,
  describeInviteError,
  inviteBody,
  invitationsPath,
  parseInvitation,
  sendInvitation,
  type Invitation,
  type InviteBody,
  type InviteClient,
  type InviteFailure,
  type InviteRequest,
  type InviteeCheck,
  type InviteeProblem,
  type SendInvitation,
} from "./invitation";
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
  comparePagePath,
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

export {
  CompareResponseError,
  comparePath,
  describeCompareError,
  describeCompareSummary,
  loadCompare,
  parseCompare,
  type CompareChange,
  type CompareData,
  type CompareParagraph,
} from "./compare";

export {
  NOT_A_COMPARE_ADDRESS,
  compareRouteMetadata,
  parseCompareAddress,
  renderCompareRoute,
  type CompareAddress,
} from "./compare-route";

export {
  CompareNotice,
  CompareView,
  type CompareNoticeProps,
  type CompareViewProps,
} from "./compare-view";

export {
  MAX_MATH_LENGTH,
  mathPlan,
  splitMath,
  type MathSegment,
  type ParagraphSegment,
  type TextSegment,
} from "./math";

export {
  TYPESET_ATTRIBUTE,
  hasMath,
  loadKatex,
  typesetParagraph,
  typesetParagraphs,
  type LoadMath,
  type MathRenderer,
} from "./math-typeset";

export {
  MAX_CANVAS_PIXELS,
  MAX_PIXEL_RATIO,
  describePdfError,
  isRenderCancelled,
  loadPdfjs,
  planPageRender,
  type LoadPdfjs,
  type PageRenderPlan,
  type PdfjsLike,
} from "./pdf-render";

export { PdfView, type PdfViewProps } from "./pdf-view";

export {
  PDF_HASH,
  ReadingViewLink,
  ReadingViewProvider,
  ReadingViews,
  viewFromHash,
  type ReadingViewId,
  type ReadingViewLinkProps,
  type ReadingViewProviderProps,
  type ReadingViewsProps,
} from "./reading-view";
