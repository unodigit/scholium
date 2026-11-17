/**
 * `ui-kit` — Scholium's shared interface components (docs/design.md §7).
 *
 * Components here are server-safe, read only the design tokens, and are
 * written in plain `.ts` (no JSX) so vitest can render them. Import from
 * `@/features/ui-kit`; route files for the gallery live in
 * `apps/web/src/app/(ui-kit)/`.
 *
 * ```tsx
 * import { DecisionBanner, EmptyState, IdPill, RecordLink, StatusChip, UnderReviewChip, VerifyBadge } from "@/features/ui-kit";
 *
 * <StatusChip status={paper.status} count={paper.reviewers} />
 * <UnderReviewChip count={3} />
 * <VerifyBadge state="anchor_pending" />   // "Signed · anchor pending"; opens the Proof tab
 * <RecordLink cid={paper.recordCid} />
 * <IdPill schId="sch:k3f9-q2xz-7mwd/v3" />   // click copies; toast says "Copied"
 * <DecisionBanner kind="retracted" recordCid={notice.id} clause="MOD-03" reason={notice.body.reason} />
 * <EmptyState sentence="No reviews yet." action={{ label: "Write a review", href: "/papers/123/review" }} />
 * ```
 */

export {
  ContestedChip,
  CorrectedChip,
  PreprintChip,
  RetractedChip,
  ReviewedChip,
  StatusChip,
  UnderReviewChip,
  type FixedStatusChipProps,
  type StatusChipProps,
} from "./status-chip";

export {
  PAPER_STATUSES,
  STATUS_CHIP_SPECS,
  isPaperStatus,
  normalizeReviewerCount,
  statusChipLabel,
  type PaperStatus,
  type StatusChipSpec,
  type StatusTone,
} from "./status";

export { VerifyBadge, type VerifyBadgeProps } from "./verify-badge";

export { formatBytes } from "./format-bytes";

export {
  PROOF_TAB_HREF,
  VERIFY_BADGE_SPECS,
  VERIFY_STATES,
  countedLabel,
  isVerifyState,
  proofTabHref,
  verifyBadgeTitle,
  type VerifyBadgeSpec,
  type VerifyCounts,
  type VerifyState,
  type VerifyTone,
} from "./verify";

export {
  ICON_GRID,
  ICON_NAMES,
  ICON_SHAPES,
  Icon,
  type IconName,
  type IconProps,
  type IconShape,
} from "./icons";

export {
  EmptyState,
  type EmptyStateAction,
  type EmptyStateProps,
} from "./empty-state";

export {
  RECORD_PATH,
  RecordLink,
  fetchRecordJson,
  formatRecordJson,
  recordErrorMessage,
  type RecordLinkProps,
  type RecordLoader,
} from "./record-link";

export {
  COPIED_MESSAGE,
  COPIED_RESET_MS,
  COPY_FAILED_MESSAGE,
  IdPill,
  type IdPillProps,
} from "./id-pill";

export {
  TOAST_DURATION_MS,
  TOAST_REGION_ID,
  dismissToast,
  ensureToastRegion,
  showToast,
  type ShowToastOptions,
} from "./toast";

export { BrandLogo, type BrandLogoProps } from "./brand-logo";
export { BrandMark, type BrandMarkProps } from "./brand-mark";
export type { BrandLogoSize } from "./brand-logo";
export type { BrandSize, BrandVariant } from "./brand-mark";

export { copyText } from "./clipboard";

export {
  DecisionBanner,
  type DecisionBannerProps,
} from "./decision-banner";

export {
  DECISION_BANNER_SPECS,
  DECISION_KINDS,
  decisionDetail,
  decisionPolicyLabel,
  decisionVersionLabel,
  isDecisionKind,
  normalizeClauseId,
  type DecisionBannerSpec,
  type DecisionContext,
  type DecisionKind,
  type DecisionTone,
} from "./decision";
