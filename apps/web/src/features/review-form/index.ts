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
 * The review card's actions live here too: {@link ReviewCardActions} puts a
 * point-by-point reply form in front of a paper's authors and a quality rating
 * in front of tier-3 members, on a revealed review.
 *
 * ```tsx
 * import { ReviewCardActions } from "@/features/review-form";
 *
 * <ReviewCardActions review={review} paperId="sch:k3f9-q2xz-7mwd" />
 * ```
 *
 * Committing seals the review; {@link revealReview} opens it once the gate is
 * open, and {@link SealedNotice} is the card that offers it. The sealed review
 * is kept on the device (`sealed-review.ts`) so a return to the page can
 * reveal it.
 *
 * The anonymity notice offers "Sign with my name instead", the form shows the
 * stylometry tip to a reviewer who stays anonymous, and selecting text in the
 * paper offers "Cite in review". The three share a {@link ReviewSession}.
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
  COMMIT_NOTE_ANONYMOUS,
  COMMIT_NOTE_SIGNED,
  SEALED_SIGNED_NOTE,
  SIGNED_DETAIL,
  SIGNED_HEADLINE,
  SIGNED_SEALED_DETAIL,
  SIGN_WITH_NAME_LABEL,
  STAY_ANONYMOUS_LABEL,
  STYLOMETRY_TIP,
} from "./identity";

export {
  ABSTRACT_SOURCE,
  CITE_ATTRIBUTE,
  CITE_LABEL,
  MAX_QUOTE_CHARS,
  PARAGRAPH_ID_CHARS,
  appendCitation,
  citationFromSelection,
  collapseWhitespace,
  describeCitation,
  formatCitation,
  paragraphSource,
  shortenQuote,
  sourceRange,
  type Citation,
  type SelectedCitation,
  type SelectionPoint,
} from "./citation";

export { CiteInReview, SELECTION_SETTLE_MS } from "./cite-in-review";

export {
  ReviewSessionProvider,
  useReviewSession,
  type CiteHandler,
  type FormPhase,
  type ReviewSession,
  type ReviewSessionProviderProps,
} from "./review-session";

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
  REVEAL_GATE_CLOSED_NOTE,
  REVEAL_ENDPOINT,
  REVEAL_LABEL,
  REVEAL_SIGNING_NOTE,
  REVEALED_HEADLINE,
  REVEALED_TEXT,
  REVIEW_FORMAL_TYPE,
  ReviewRevealInputError,
  WrongRevealRecordError,
  buildRevealBody,
  describeRevealError,
  loadRevealGate,
  parseRevealGate,
  revealReview,
  updateReview,
  reviseReview,
  updateFormalReview,
  reviewUpdate,
  type GateClient,
  type LoadRevealGate,
  type RevealAccepted,
  type RevealGate,
  type RevealReview,
  type UpdateReview,
  type UpdateReviewInput,
  type UpdateReviewResult,
  type RevealSeams,
  type ReviewFormalBody,
  type ReviewRevealInput,
  type ReviewRevealResult,
  type SignRevealRecord,
  type SubmitRevealRecord,
} from "./reveal";

export {
  SEALED_REVIEW_PREFIX,
  browserSealedReviewStorage,
  forgetSealedReview,
  loadSealedReview,
  parseSealedReview,
  saveSealedReview,
  sealedReviewFromCommit,
  sealedReviewKey,
  type SealedReview,
  type SealedReviewStorage,
} from "./sealed-review";

export {
  REVIEW_KEY_DOMAIN,
  REVIEW_KEY_SEED_LENGTH,
  REVIEW_KEY_STORAGE_PREFIX,
  REVIEW_NULLIFIER_DOMAIN,
  REVIEW_SIGN_REASON,
  DOWNLOAD_REVIEW_KEY_LABEL,
  IMPORT_REVIEW_KEY_LABEL,
  REVIEW_SECRET_LOCAL_NOTE,
  browserReviewKeyStorage,
  buildReviewKeyFile,
  deriveReviewKey,
  forgetReviewKey,
  loadReviewKey,
  nullifierForReviewKey,
  parseReviewKeyFile,
  reviewKeyFromSeed,
  reviewKeyStorageKey,
  saveReviewKey,
  signWithReviewKey,
  type DeriveReviewKey,
  type ReviewKeyFile,
  type ReviewKeyMaterial,
  type ReviewKeyStorage,
  type SignReviewChallenge,
} from "./review-key";

export {
  ReviewNotice,
  ReviewPage,
  type ReviewPageProps,
} from "./review-page";

export {
  ReviewCardActions,
  type ReviewCardActionsProps,
  type ReviewCardTarget,
} from "./review-actions";

export {
  EmptyReplyError,
  GENERAL_REPLY_ID,
  REPLY_LABEL,
  REPLY_POINTS,
  REPLY_SIGNING_NOTE,
  REPLY_SUBMIT_LABEL,
  REVIEW_RESPONSE_TYPE,
  ReplyInputError,
  WrongReplyRecordError,
  answeredPoints,
  buildReplyBody,
  describeReplyError,
  describeReplyProgress,
  emptyReplyDraft,
  isReplyComplete,
  respondToReview,
  responsePath,
  withReply,
  type ReplyAccepted,
  type ReplyDraft,
  type ReplyInput,
  type ReplyItem,
  type ReplyPoint,
  type ReplyPointId,
  type ReplyResult,
  type ReplySeams,
  type RespondToReview,
  type ReviewResponseBody,
  type SignReplyRecord,
  type SubmitReplyRecord,
} from "./reply";

export {
  InvalidRatingError,
  RATING_HINT,
  RATING_LABEL,
  RATING_SUBMIT_LABEL,
  RATING_VALUES,
  RatingInputError,
  describeRatingError,
  isRating,
  rateReview,
  ratingPath,
  ratingText,
  type RateReview,
  type RatingAccepted,
  type RatingInput,
  type RatingResult,
  type RatingSeams,
  type SubmitRating,
} from "./rating";

export {
  NOT_SENT,
  describeActionError,
  type ActionFailure,
  type ActionWords,
} from "./action-errors";

export {
  NO_OFFER,
  RATING_MIN_TIER,
  SIGNED_OUT,
  loadPaperAuthors,
  offerFor,
  parseAuthorDids,
  viewerFromToken,
  type AuthorsClient,
  type LoadPaperAuthors,
  type Offer,
  type Viewer,
} from "./viewer";

export { useViewer, usePaperAuthors, type AuthorsState } from "./use-viewer";
