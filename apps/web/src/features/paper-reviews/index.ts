/**
 * `paper-reviews` — the Reviews tab of the paper page (docs/design.md §5.2).
 *
 * The feature owns this module and the route group `app/(paper-reviews)/`. A
 * paper page mounts the tab in its margin panel:
 *
 * ```tsx
 * import { ReviewsTab } from "@/features/paper-reviews";
 *
 * <ReviewsTab paperId="sch:k3f9-q2xz-7mwd/v2" />
 * ```
 *
 * The tab shows formal reviews as cards — reviewer label, recommendation,
 * rubric dots with their text equivalent (`4 of 5`), an expandable report and
 * any author replies — under a median-per-dimension summary bar, from
 * `GET /v1/papers/{id}/reviews`. `/reviews/{id}[/v{n}]` shows it on a page of
 * its own.
 */

export { ReviewsTab, type ReviewsTabProps } from "./reviews-tab";

export {
  DIMENSION_ORDER,
  confidenceLabel,
  dimensionLabel,
  dimensionMedians,
  emptyReviews,
  formatReviewDate,
  median,
  medianText,
  parseReviews,
  parseScores,
  recommendationLabel,
  recommendationTone,
  reportGateDate,
  reviewerLabelAt,
  scoreFraction,
  scoreText,
  type AuthorReply,
  type AuthorReplyItem,
  type DimensionMedian,
  type RecommendationTone,
  type Review,
  type ReviewScore,
  type ReviewsData,
} from "./review";

export {
  NO_REVIEWS_YET,
  classifyReviewsError,
  describeLoadError,
  loadReviews,
  reviewsPath,
  type LoadReviews,
  type LoadReviewsOptions,
  type ReviewsClient,
  type ReviewsFailure,
} from "./reviews-api";

export { paperHref, reviewHref, reviewsTabHref } from "./links";
