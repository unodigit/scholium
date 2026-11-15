/**
 * `review-form` — the formal review form (`/review/[id]`).
 *
 * The feature owns the route group `app/(review-form)/` and this module. The
 * page is a split view: the paper on the left, read on the server from
 * `GET /v1/papers/{id}` and `GET /v1/papers/{id}/v/{n}/text`, and the rubric
 * form on the right, with the anonymity notice above it.
 *
 * ```tsx
 * import { ReviewForm, toReviewBody } from "@/features/review-form";
 *
 * <ReviewForm />
 * ```
 *
 * Later features of this plugin (the conflict check and the commit, the
 * "sign with my name" option and "Cite in review", author replies and review
 * ratings) add files here and extend {@link ReviewPage}.
 */

export {
  CONFIDENCE_OPTIONS,
  IncompleteReviewError,
  RECOMMENDATION_OPTIONS,
  RUBRIC_DIMENSIONS,
  SCORES,
  SCORE_MAX,
  describeProgress,
  emptyDraft,
  isComplete,
  isDimensionComplete,
  justificationOf,
  progressOf,
  toReviewBody,
  validateDraft,
  withDimension,
  type Confidence,
  type ConfidenceOption,
  type DimensionDraft,
  type DimensionId,
  type DimensionProblems,
  type DraftProblems,
  type Progress,
  type Recommendation,
  type RecommendationOption,
  type ReviewBody,
  type ReviewDraft,
  type ReviewScoreBody,
  type RubricDimension,
  type Score,
} from "./rubric";

export {
  InvalidPaperIdError,
  REVIEW_PATH,
  REVIEW_TITLE,
  ReviewPaperError,
  describePaperError,
  loadReviewPaper,
  parseParagraphs,
  parsePaperHead,
  parseReviewTarget,
  reviewHref,
  type PaperClient,
  type PaperFailure,
  type PaperHead,
  type PaperParagraph,
  type ReviewPaper,
} from "./paper";

export {
  ANONYMITY_DETAIL,
  ANONYMITY_HEADLINE,
  AnonymityNotice,
} from "./anonymity-notice";

export { PaperPane } from "./paper-pane";

export {
  AI_ASSISTANCE_HINT,
  AI_ASSISTANCE_LABEL,
  ReviewForm,
  type ReviewFormProps,
} from "./review-form";

export {
  ReviewNotice,
  ReviewPage,
  type ReviewPageProps,
} from "./review-page";
