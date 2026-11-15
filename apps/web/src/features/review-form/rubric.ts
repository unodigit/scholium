/**
 * The review rubric: what a reviewer fills in, when it is complete, and the
 * `review.formal` body it becomes.
 *
 * docs/design.md §5.5 fixes the form: six dimensions scored 1–5, each with a
 * justification the reviewer must write; a confidence; a recommendation; and a
 * declaration that AI assistance was used. The record schema
 * (`apps/api/packages/record-core/schemas/review.formal.json`) and
 * `POST /v1/reviews/reveal` hold the same line: a score without a
 * justification, or free text without scores, is not a formal review.
 *
 * This module is the single place those rules live. The form renders from
 * {@link RUBRIC_DIMENSIONS}, {@link CONFIDENCE_OPTIONS} and
 * {@link RECOMMENDATION_OPTIONS}, decides what to flag with
 * {@link validateDraft}, and hands a finished review on as
 * {@link toReviewBody}. Pure data and functions, no React.
 */

/** A rubric score, from 1 (weakest) to 5 (strongest). */
export type Score = 1 | 2 | 3 | 4 | 5;

/** Every score, in the order the radios appear. */
export const SCORES: readonly Score[] = [1, 2, 3, 4, 5];

/** The number of points on the scale (the "5" in "4 of 5"). */
export const SCORE_MAX = 5;

/** The wire key of a rubric dimension (`review.formal` `scores.<key>`). */
export type DimensionId =
  | "soundness"
  | "evidence"
  | "reproducibility"
  | "novelty"
  | "clarity"
  | "limitations";

/** One row of the rubric. */
export interface RubricDimension {
  readonly id: DimensionId;
  /** The label shown to the reviewer (docs/design.md §5.5). */
  readonly label: string;
}

/** The six dimensions, in the order the form shows them. */
export const RUBRIC_DIMENSIONS: readonly RubricDimension[] = [
  { id: "soundness", label: "Soundness of method" },
  { id: "evidence", label: "Evidence for claims" },
  { id: "reproducibility", label: "Reproducibility" },
  { id: "novelty", label: "Novelty" },
  { id: "clarity", label: "Clarity" },
  { id: "limitations", label: "Limitations & ethics" },
];

/** How sure the reviewer is of their own assessment. */
export type Confidence = "low" | "medium" | "high";

export interface ConfidenceOption {
  readonly value: Confidence;
  readonly label: string;
}

export const CONFIDENCE_OPTIONS: readonly ConfidenceOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * The reviewer's verdict. The values are the spellings the record schema and
 * the status computation agree on (`status/compute.py` reads these four as
 * supportive, supportive, concerned and rejecting).
 */
export type Recommendation =
  | "sound_as_is"
  | "minor_revisions"
  | "major_concerns"
  | "fundamentally_flawed";

export interface RecommendationOption {
  readonly value: Recommendation;
  readonly label: string;
}

export const RECOMMENDATION_OPTIONS: readonly RecommendationOption[] = [
  { value: "sound_as_is", label: "Sound as is" },
  { value: "minor_revisions", label: "Minor revisions" },
  { value: "major_concerns", label: "Major concerns" },
  { value: "fundamentally_flawed", label: "Fundamentally flawed" },
];

/** One dimension as the reviewer has filled it in so far. */
export interface DimensionDraft {
  /** `null` until a radio is chosen. */
  readonly score: Score | null;
  /** Raw text as typed; trimmed only when it is checked or sent. */
  readonly justification: string;
}

/** A review in progress. Nothing is chosen by default. */
export interface ReviewDraft {
  readonly scores: Readonly<Record<DimensionId, DimensionDraft>>;
  readonly confidence: Confidence | null;
  readonly recommendation: Recommendation | null;
  /** The reviewer used AI assistance; declared on the report. */
  readonly aiAssisted: boolean;
}

/** A blank review: no score, no confidence, no recommendation, no AI. */
export function emptyDraft(): ReviewDraft {
  const scores = {} as Record<DimensionId, DimensionDraft>;
  for (const { id } of RUBRIC_DIMENSIONS) {
    scores[id] = { score: null, justification: "" };
  }
  return {
    scores,
    confidence: null,
    recommendation: null,
    aiAssisted: false,
  };
}

/** Return `draft` with one dimension's fields changed. */
export function withDimension(
  draft: ReviewDraft,
  id: DimensionId,
  change: Partial<DimensionDraft>,
): ReviewDraft {
  return {
    ...draft,
    scores: { ...draft.scores, [id]: { ...draft.scores[id], ...change } },
  };
}

/** What is wrong with one dimension. Absent keys are fine. */
export interface DimensionProblems {
  readonly score?: string;
  readonly justification?: string;
}

/** Everything wrong with a draft, in the words the form shows. */
export interface DraftProblems {
  readonly scores: Readonly<Partial<Record<DimensionId, DimensionProblems>>>;
  readonly confidence?: string;
  readonly recommendation?: string;
}

/** The justification as it will be sent: surrounding whitespace is not text. */
export function justificationOf(entry: DimensionDraft): string {
  return entry.justification.trim();
}

/** Whether a dimension has both its score and its justification. */
export function isDimensionComplete(entry: DimensionDraft): boolean {
  return entry.score !== null && justificationOf(entry) !== "";
}

/**
 * Check a draft against the rubric's rules.
 *
 * Every dimension needs a score *and* a justification; so do confidence and
 * recommendation. The messages are written for the reviewer and name the
 * dimension, so they still make sense read out of context by a screen reader.
 */
export function validateDraft(draft: ReviewDraft): DraftProblems {
  const scores: Partial<Record<DimensionId, DimensionProblems>> = {};

  for (const { id, label } of RUBRIC_DIMENSIONS) {
    const entry = draft.scores[id];
    const problems: { score?: string; justification?: string } = {};
    if (entry.score === null) {
      problems.score = `Choose a score from 1 to ${SCORE_MAX} for ${label}.`;
    }
    if (justificationOf(entry) === "") {
      problems.justification = `Add a justification for ${label}.`;
    }
    if (problems.score !== undefined || problems.justification !== undefined) {
      scores[id] = problems;
    }
  }

  return {
    scores,
    ...(draft.confidence === null
      ? { confidence: "Choose how confident you are." }
      : {}),
    ...(draft.recommendation === null
      ? { recommendation: "Choose a recommendation." }
      : {}),
  };
}

/** Whether {@link validateDraft} found nothing to fix. */
export function isComplete(problems: DraftProblems): boolean {
  return (
    Object.keys(problems.scores).length === 0 &&
    problems.confidence === undefined &&
    problems.recommendation === undefined
  );
}

/** How far along a draft is, for the form's progress line. */
export interface Progress {
  /** Dimensions with both a score and a justification. */
  readonly dimensionsDone: number;
  readonly dimensionsTotal: number;
  readonly confidenceChosen: boolean;
  readonly recommendationChosen: boolean;
}

export function progressOf(draft: ReviewDraft): Progress {
  return {
    dimensionsDone: RUBRIC_DIMENSIONS.filter(({ id }) =>
      isDimensionComplete(draft.scores[id]),
    ).length,
    dimensionsTotal: RUBRIC_DIMENSIONS.length,
    confidenceChosen: draft.confidence !== null,
    recommendationChosen: draft.recommendation !== null,
  };
}

/** The progress line: what is done and what is still missing. */
export function describeProgress(progress: Progress): string {
  const done = `${progress.dimensionsDone} of ${progress.dimensionsTotal} rubric dimensions complete`;
  const missing: string[] = [];
  if (!progress.confidenceChosen) missing.push("confidence");
  if (!progress.recommendationChosen) missing.push("recommendation");

  if (progress.dimensionsDone === progress.dimensionsTotal && missing.length === 0) {
    return "Every part of the review is filled in.";
  }
  return missing.length === 0
    ? done
    : `${done} · still needed: ${missing.join(" and ")}`;
}

/** A rubric entry as `review.formal` carries it. */
export interface ReviewScoreBody {
  readonly score: Score;
  readonly justification: string;
}

/**
 * The rubric part of a `review.formal` record body: the shape
 * `review.formal.json` and `POST /v1/reviews/reveal` accept.
 *
 * `aiAssisted` is not named by the schema (it allows extra properties); it is
 * how the declaration "I used AI assistance in writing this review" travels on
 * the report.
 */
export interface ReviewBody {
  readonly scores: Readonly<Record<DimensionId, ReviewScoreBody>>;
  readonly confidence: Confidence;
  readonly recommendation: Recommendation;
  readonly aiAssisted: boolean;
}

/** Thrown by {@link toReviewBody} when the draft is not a complete review. */
export class IncompleteReviewError extends Error {
  readonly problems: DraftProblems;

  constructor(problems: DraftProblems) {
    super("The review is not complete.");
    this.name = "IncompleteReviewError";
    this.problems = problems;
  }
}

/**
 * Turn a finished draft into the body of a `review.formal` record.
 *
 * @throws {IncompleteReviewError} if anything is missing — a review with no
 *   scores, or scores with no justification, is never produced.
 */
export function toReviewBody(draft: ReviewDraft): ReviewBody {
  const problems = validateDraft(draft);
  if (
    !isComplete(problems) ||
    draft.confidence === null ||
    draft.recommendation === null
  ) {
    throw new IncompleteReviewError(problems);
  }

  const scores = {} as Record<DimensionId, ReviewScoreBody>;
  for (const { id } of RUBRIC_DIMENSIONS) {
    const entry = draft.scores[id];
    // `validateDraft` has just proved the score is set.
    scores[id] = { score: entry.score as Score, justification: justificationOf(entry) };
  }

  return {
    scores,
    confidence: draft.confidence,
    recommendation: draft.recommendation,
    aiAssisted: draft.aiAssisted,
  };
}
