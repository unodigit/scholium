/**
 * `ui-kit` — Scholium's shared interface components (docs/design.md §7).
 *
 * Components here are server-safe, read only the design tokens, and are
 * written in plain `.ts` (no JSX) so vitest can render them. Import from
 * `@/features/ui-kit`; route files for the gallery live in
 * `apps/web/src/app/(ui-kit)/`.
 *
 * ```tsx
 * import { EmptyState, RecordLink, StatusChip, UnderReviewChip } from "@/features/ui-kit";
 *
 * <StatusChip status={paper.status} count={paper.reviewers} />
 * <UnderReviewChip count={3} />
 * <RecordLink cid={paper.recordCid} />
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
