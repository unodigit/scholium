/**
 * `review-form` — the formal review form (`/review/[id]`).
 *
 * The feature owns the route group `app/(review-form)/` and this module. The
 * page is a split view: the paper on the left, read on the server from
 * `GET /v1/papers/{id}` and `GET /v1/papers/{id}/v/{n}/text`, and — on the
 * right — the conflict check above the rubric form, which seals the review as
 * a signed `review.commit`.
 *
 * ```tsx
 * import { ReviewForm, commitReview, toReviewBody } from "@/features/review-form";
 *
 * <ReviewForm paperId="sch:k3f9-q2xz-7mwd" versionCid="bafyrei…" />
 * ```
 *
 * Later features of this plugin (the "sign with my name" option and "Cite in
 * review", author replies and review ratings) add files here and extend
 * {@link ReviewPage}.
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
  reviewSignInHref,
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
  COMMIT_LABEL,
  COMMIT_NOTE,
  ReviewForm,
  SealedNotice,
  type CommitReview,
  type ReviewFormProps,
} from "./review-form";

export {
  CONFLICT_CHECK_TITLE,
  CONFLICT_STATUSES,
  CONFLICT_STATUS_SPECS,
  ConflictReportError,
  conflictEndpoint,
  describeConflictError,
  describeConflictSummary,
  loadConflictCheck,
  parseConflictReport,
  type ConflictCheck as ConflictCheckResult,
  type ConflictClient,
  type ConflictReport,
  type ConflictStatus,
  type ConflictStatusSpec,
  type LoadConflictCheck,
} from "./conflict";

export {
  ConflictCheck,
  conflictSignInHref,
  type ConflictCheckProps,
} from "./conflict-check";

export {
  REVEAL_WINDOW_DAYS,
  REVIEW_COMMIT_TYPE,
  SEALED_HEADLINE,
  ReviewCommitInputError,
  WrongCommitRecordError,
  buildReviewCommit,
  canonicalJson,
  commitmentDigest,
  commitReview,
  describeCommitError,
  formatRevealDate,
  revealDateFor,
  reviewCommitment,
  reviewRecordSigner,
  reviewRevealBody,
  type CommitAccepted,
  type CommitFailure,
  type ReviewCommitBody,
  type ReviewCommitInput,
  type ReviewCommitResult,
  type ReviewCommitSeams,
  type SignCommitRecord,
  type SubmitCommitRecord,
} from "./commit";

export {
  REVIEW_KEY_DOMAIN,
  REVIEW_KEY_SEED_LENGTH,
  REVIEW_NULLIFIER_DOMAIN,
  REVIEW_SIGN_REASON,
  deriveReviewKey,
  nullifierForReviewKey,
  reviewKeyFromSeed,
  signWithReviewKey,
  type DeriveReviewKey,
  type ReviewKeyMaterial,
  type SignReviewChallenge,
} from "./review-key";

export {
  ReviewNotice,
  ReviewPage,
  type ReviewPageProps,
} from "./review-page";
