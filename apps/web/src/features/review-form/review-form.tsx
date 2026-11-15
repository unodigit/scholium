"use client";

/**
 * The rubric form, on the right of the review page (docs/design.md §5.5).
 *
 * Six dimensions, each scored 1–5 with a justification the reviewer must
 * write; a confidence; a recommendation; and the declaration that AI
 * assistance was used. Nothing is chosen for the reviewer: every radio starts
 * unselected, so a score is always a decision.
 *
 * The form holds the draft and says how far along it is. It does not commit
 * anything — signing and sealing the review is a later feature of this plugin
 * (`review-form`), which reads the finished draft through
 * {@link toReviewBody}.
 *
 * Accessibility (design.md §9): every group is a `fieldset` with a `legend`,
 * every radio's name carries its text equivalent ("4 of 5") so it never
 * depends on the circle alone, targets are at least 44 px, and an error is
 * an icon plus words tied to its field with `aria-describedby`.
 */

import { useId, useState } from "react";

import { Icon } from "../ui-kit/icons";
import {
  CONFIDENCE_OPTIONS,
  RECOMMENDATION_OPTIONS,
  RUBRIC_DIMENSIONS,
  SCORES,
  SCORE_MAX,
  describeProgress,
  emptyDraft,
  progressOf,
  validateDraft,
  withDimension,
  type DimensionId,
  type DimensionProblems,
  type ReviewDraft,
  type RubricDimension,
  type Score,
} from "./rubric";
import "./review-form.css";

/** The words beside the AI checkbox: the declaration the design specifies. */
export const AI_ASSISTANCE_LABEL =
  "I used AI assistance in writing this review";

/** What the declaration does, so the reviewer knows it is public. */
export const AI_ASSISTANCE_HINT = "(declared on the report)";

export interface ReviewFormProps {
  /** Start from a draft other than a blank one. */
  initialDraft?: ReviewDraft;
}

/** The six-dimension rubric and the verdict beneath it. */
export function ReviewForm({ initialDraft }: ReviewFormProps = {}) {
  const uid = useId();
  const [draft, setDraft] = useState<ReviewDraft>(
    () => initialDraft ?? emptyDraft(),
  );
  // A dimension's problems are shown once the reviewer has left its
  // justification box, not while they are still typing in it.
  const [visited, setVisited] = useState<Partial<Record<DimensionId, true>>>({});

  const problems = validateDraft(draft);
  const progress = progressOf(draft);

  return (
    <form
      className="rf-form"
      aria-labelledby={`${uid}-title`}
      noValidate
      // Nothing is committed from here: Enter in a field must not reload.
      onSubmit={(event) => event.preventDefault()}
    >
      <h2 id={`${uid}-title`} className="rf-form-title">
        Your review
      </h2>
      <p className="rf-form-lede">
        Score each dimension from 1 (weakest) to {SCORE_MAX} (strongest) and
        say why. Every justification is required.
      </p>

      {RUBRIC_DIMENSIONS.map((dimension) => (
        <DimensionField
          key={dimension.id}
          idBase={`${uid}-${dimension.id}`}
          dimension={dimension}
          score={draft.scores[dimension.id].score}
          justification={draft.scores[dimension.id].justification}
          problems={
            visited[dimension.id] === true
              ? (problems.scores[dimension.id] ?? {})
              : {}
          }
          onScore={(score) =>
            setDraft((current) => withDimension(current, dimension.id, { score }))
          }
          onJustification={(justification) =>
            setDraft((current) =>
              withDimension(current, dimension.id, { justification }),
            )
          }
          onLeaveJustification={() =>
            setVisited((current) => ({ ...current, [dimension.id]: true }))
          }
        />
      ))}

      <fieldset className="rf-group">
        <legend className="rf-group-legend">Confidence</legend>
        <div className="rf-choices">
          {CONFIDENCE_OPTIONS.map((option) => (
            <label key={option.value} className="rf-choice">
              <input
                type="radio"
                name={`${uid}-confidence`}
                value={option.value}
                required
                checked={draft.confidence === option.value}
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    confidence: option.value,
                  }))
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="rf-group">
        <legend className="rf-group-legend">Recommendation</legend>
        <div className="rf-choices rf-choices--stacked">
          {RECOMMENDATION_OPTIONS.map((option) => (
            <label key={option.value} className="rf-choice">
              <input
                type="radio"
                name={`${uid}-recommendation`}
                value={option.value}
                required
                checked={draft.recommendation === option.value}
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    recommendation: option.value,
                  }))
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="rf-ai">
        <input
          type="checkbox"
          name={`${uid}-ai-assisted`}
          checked={draft.aiAssisted}
          onChange={(event) => {
            const aiAssisted = event.currentTarget.checked;
            setDraft((current) => ({ ...current, aiAssisted }));
          }}
        />
        <span>
          {AI_ASSISTANCE_LABEL}{" "}
          <span className="rf-ai-hint">{AI_ASSISTANCE_HINT}</span>
        </span>
      </label>

      <p className="rf-progress" role="status">
        {describeProgress(progress)}
      </p>
    </form>
  );
}

interface DimensionFieldProps {
  idBase: string;
  dimension: RubricDimension;
  score: Score | null;
  justification: string;
  problems: DimensionProblems;
  onScore: (score: Score) => void;
  onJustification: (text: string) => void;
  onLeaveJustification: () => void;
}

/** One rubric row: the 1–5 radios and the justification beneath them. */
function DimensionField({
  idBase,
  dimension,
  score,
  justification,
  problems,
  onScore,
  onJustification,
  onLeaveJustification,
}: DimensionFieldProps) {
  const scoreErrorId = `${idBase}-score-error`;
  const justificationId = `${idBase}-justification`;
  const justificationErrorId = `${idBase}-justification-error`;

  return (
    <fieldset
      className="rf-dimension"
      aria-describedby={problems.score === undefined ? undefined : scoreErrorId}
      data-dimension={dimension.id}
    >
      <legend className="rf-dimension-name">{dimension.label}</legend>

      <div className="rf-choices rf-choices--scale">
        {SCORES.map((value) => (
          <label key={value} className="rf-choice rf-choice--score">
            <input
              type="radio"
              name={`${idBase}-score`}
              value={value}
              required
              checked={score === value}
              onChange={() => onScore(value)}
            />
            {/* The digit is the picture; the words are the text equivalent. */}
            <span aria-hidden="true">{value}</span>
            <span className="rf-sr-only">
              {value} of {SCORE_MAX}
            </span>
          </label>
        ))}
      </div>
      {problems.score === undefined ? null : (
        <FieldError id={scoreErrorId} message={problems.score} />
      )}

      <div className="rf-field">
        <label className="rf-field-label" htmlFor={justificationId}>
          Justification <span className="rf-required">(required)</span>
        </label>
        <textarea
          id={justificationId}
          className="rf-textarea"
          rows={3}
          required
          value={justification}
          aria-invalid={problems.justification === undefined ? undefined : true}
          aria-describedby={
            problems.justification === undefined ? undefined : justificationErrorId
          }
          onChange={(event) => onJustification(event.currentTarget.value)}
          onBlur={onLeaveJustification}
        />
        {problems.justification === undefined ? null : (
          <FieldError id={justificationErrorId} message={problems.justification} />
        )}
      </div>
    </fieldset>
  );
}

/** An icon and words, never colour alone (docs/design.md §9). */
function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="rf-error">
      <Icon name="alert" className="rf-error-icon" />
      <span>{message}</span>
    </p>
  );
}

export default ReviewForm;
