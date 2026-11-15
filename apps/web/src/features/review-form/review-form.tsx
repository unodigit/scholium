"use client";

/**
 * The rubric form, on the right of the review page (docs/design.md §5.5).
 *
 * Six dimensions, each scored 1–5 with a justification the reviewer must
 * write; a confidence; a recommendation; and the declaration that AI
 * assistance was used. Nothing is chosen for the reviewer: every radio starts
 * unselected, so a score is always a decision.
 *
 * Beneath the rubric is **Commit review**. It validates the draft, signs a
 * `review.commit` with the reviewer's pseudonymous per-paper key (one passkey
 * prompt), sends it to `POST /v1/reviews/commit`, and replaces itself with
 * "Your review is sealed" and the date the review will be revealed. A failed
 * commit says what happened and that nothing was sent; the draft is kept.
 *
 * Two things around the rubric belong to feature 167 and share state with the
 * rest of the page through the review session (`review-session.tsx`):
 *
 * - **Who the review is credited to.** The anonymity notice above the form
 *   offers "Sign with my name instead"; the choice is sealed into the commit
 *   (`signed: true` in the revealed body, so inside the commitment). While the
 *   review is anonymous the form shows the stylometry tip, "avoid phrases that
 *   identify you or your lab"; a reviewer who signs has no use for it.
 * - **Cite in review.** Words selected in the paper arrive here as a quote,
 *   which is added to the justification the reviewer last had open (the first
 *   one before they have opened any) and focused, with the caret at the end,
 *   so they can carry on writing. A polite live region says where it went.
 *
 * Accessibility (design.md §9): every group is a `fieldset` with a `legend`,
 * every radio's name carries its text equivalent ("4 of 5") so it never
 * depends on the circle alone, targets are at least 44 px, and an error is
 * an icon plus words tied to its field with `aria-describedby`.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
} from "react";

import { useSignedIn } from "../../components/nav/session";
import { Icon } from "../ui-kit/icons";
import { appendCitation, describeCitation, type Citation } from "./citation";
import {
  SEALED_HEADLINE,
  commitReview,
  describeCommitError,
  formatRevealDate,
  type CommitFailure,
  type ReviewCommitInput,
  type ReviewCommitResult,
} from "./commit";
import {
  COMMIT_NOTE_ANONYMOUS,
  COMMIT_NOTE_SIGNED,
  SEALED_SIGNED_NOTE,
  STYLOMETRY_TIP,
} from "./identity";
import { reviewSignInHref } from "./links";
import {
  ReviewSessionProvider,
  useReviewSession,
  type ReviewSession,
} from "./review-session";
import {
  CONFIDENCE_OPTIONS,
  RECOMMENDATION_OPTIONS,
  RUBRIC_DIMENSIONS,
  SCORES,
  SCORE_MAX,
  describeProgress,
  emptyDraft,
  isComplete,
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

/** The button that seals the review (docs/design.md §5.5). */
export const COMMIT_LABEL = "Commit review";

/**
 * Said under the button so the reviewer knows what committing does. (A reviewer
 * who chose to sign with their name is told so as well: `COMMIT_NOTE_SIGNED`.)
 */
export const COMMIT_NOTE = COMMIT_NOTE_ANONYMOUS;

/** Signs and sends the review; replaceable in tests. */
export type CommitReview = (input: ReviewCommitInput) => Promise<ReviewCommitResult>;

export interface ReviewFormProps {
  /**
   * Start from a draft other than a blank one. Its `signed` choice is used only
   * when the form is on its own: inside a `ReviewSessionProvider` (as on the
   * review page) the session holds that choice, so the notice and the form
   * cannot disagree.
   */
  initialDraft?: ReviewDraft;
  /** The paper being reviewed, for the commit's nullifier and sign-in link. */
  paperId?: string;
  /** The version a commit targets; without it the commit is refused. */
  versionCid?: string;
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /** Where "Sign in" goes; defaults to sign-in, then back to this review. */
  signInHref?: string;
  /** Replace the commit flow (derive key, sign and send), for tests. */
  commit?: CommitReview;
}

type Phase = "editing" | "signing" | "sealed";

/**
 * The six-dimension rubric, the verdict beneath it, and Commit review.
 *
 * On the review page the form shares a session with the notice and the paper.
 * On its own it brings one, so it behaves the same either way.
 */
export function ReviewForm(props: ReviewFormProps = {}) {
  const parent = useReviewSession();
  if (parent !== null) return <ReviewFormBody {...props} session={parent} />;
  return (
    <ReviewSessionProvider initialSigned={props.initialDraft?.signed === true}>
      <OwnSession {...props} />
    </ReviewSessionProvider>
  );
}

/** The form inside the session {@link ReviewForm} just made for it. */
function OwnSession(props: ReviewFormProps) {
  const session = useReviewSession();
  if (session === null) {
    // Unreachable: this renders only inside the provider above.
    throw new Error("ReviewForm: the review session is missing.");
  }
  return <ReviewFormBody {...props} session={session} />;
}

function ReviewFormBody({
  initialDraft,
  paperId = "",
  versionCid,
  signedIn: signedInOverride,
  signInHref: signInHrefOverride,
  commit: commitOverride,
  session,
}: ReviewFormProps & { session: ReviewSession }) {
  const uid = useId();
  const signedIn = useSignedIn(signedInOverride);
  const signInHref = signInHrefOverride ?? reviewSignInHref(paperId);
  const { signed, attachForm, setPhase: reportPhase } = session;

  const [draft, setDraft] = useState<ReviewDraft>(
    () => initialDraft ?? emptyDraft(),
  );
  // A dimension's problems are shown once the reviewer has left its
  // justification box, not while they are still typing in it. A commit attempt
  // shows every problem at once.
  const [visited, setVisited] = useState<Partial<Record<DimensionId, true>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<Phase>("editing");
  const [sealed, setSealed] = useState<ReviewCommitResult | null>(null);
  const [error, setError] = useState<CommitFailure | null>(null);

  // Cite in review: the box a quote goes into, and the last quote placed.
  const citeTarget = useRef<DimensionId>(RUBRIC_DIMENSIONS[0].id);
  const boxes = useRef<Partial<Record<DimensionId, HTMLTextAreaElement | null>>>({});
  const [cited, setCited] = useState<CitedState | null>(null);

  // Tell the rest of the page where the form is, so the choice to sign and
  // the paper's Cite in review stop changing the draft once it is being signed.
  useEffect(() => {
    reportPhase(phase);
  }, [phase, reportPhase]);
  useEffect(() => () => reportPhase("editing"), [reportPhase]);

  // The paper hands a quote to the form through the session.
  const takeCitation = useCallback((citation: Citation) => {
    const id = citeTarget.current;
    setDraft((current) =>
      withDimension(current, id, {
        justification: appendCitation(current.scores[id].justification, citation),
      }),
    );
    const label =
      RUBRIC_DIMENSIONS.find((dimension) => dimension.id === id)?.label ?? id;
    setCited((previous) => ({
      id,
      nonce: (previous?.nonce ?? 0) + 1,
      message: describeCitation(citation, label),
    }));
  }, []);
  useEffect(() => attachForm(takeCitation), [attachForm, takeCitation]);

  // Put the reviewer where the quote went, ready to carry on writing.
  useEffect(() => {
    if (cited === null) return;
    const box = boxes.current[cited.id];
    if (box === null || box === undefined) return;
    box.focus();
    const end = box.value.length;
    box.setSelectionRange(end, end);
    box.scrollTop = box.scrollHeight;
  }, [cited]);

  const problems = validateDraft(draft);
  const progress = progressOf(draft);
  const complete = isComplete(problems);

  if (phase === "sealed" && sealed !== null) {
    return <SealedNotice result={sealed} signed={signed} />;
  }

  const commit = async (): Promise<void> => {
    if (phase === "signing") return;

    setSubmitted(true);
    if (!complete) {
      // The messages beside the fields say what is missing; nothing is signed.
      setError(null);
      return;
    }
    if (!signedIn && commitOverride === undefined) {
      setError({
        message:
          "Sign in to commit your review. Nothing was sent.",
        signIn: true,
      });
      return;
    }

    setError(null);
    setPhase("signing");
    try {
      const result = await (commitOverride ?? commitReview)({
        paperId,
        versionCid,
        // The choice on the page, not whatever the draft started with: what the
        // reviewer sees is what the commitment covers.
        draft: { ...draft, signed },
      });
      setSealed(result);
      setPhase("sealed");
    } catch (thrown) {
      setError(describeCommitError(thrown));
      setPhase("editing");
    }
  };

  return (
    <form
      className="rf-form"
      aria-labelledby={`${uid}-title`}
      noValidate
      onSubmit={(event) => {
        // Committing is the only submit; Enter in a field must not reload.
        event.preventDefault();
        void commit();
      }}
    >
      <h2 id={`${uid}-title`} className="rf-form-title">
        Your review
      </h2>
      <p className="rf-form-lede">
        Score each dimension from 1 (weakest) to {SCORE_MAX} (strongest) and
        say why. Every justification is required.
      </p>

      {/* The design's hint to a reviewer who kept their anonymity. A reviewer
          who signs with their name has no use for it. */}
      {signed ? null : (
        <p className="rf-tip" data-tip="stylometry">
          <Icon name="eye" className="rf-tip-icon" />
          <span>{STYLOMETRY_TIP}</span>
        </p>
      )}

      {/* Says where a cited quote went: the box may be out of sight. Always
          present, so the first message is announced. Not a `status` role: the
          progress line is the form's one. */}
      <p className="rf-sr-only" aria-live="polite" data-cite-status>
        {cited === null ? "" : cited.message}
      </p>

      {RUBRIC_DIMENSIONS.map((dimension) => (
        <DimensionField
          key={dimension.id}
          idBase={`${uid}-${dimension.id}`}
          dimension={dimension}
          boxRef={(element) => {
            boxes.current[dimension.id] = element;
          }}
          onFocusJustification={() => {
            citeTarget.current = dimension.id;
          }}
          score={draft.scores[dimension.id].score}
          justification={draft.scores[dimension.id].justification}
          problems={
            submitted || visited[dimension.id] === true
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

      <fieldset
        className="rf-group"
        aria-describedby={
          submitted && problems.confidence !== undefined
            ? `${uid}-confidence-error`
            : undefined
        }
        aria-invalid={
          submitted && problems.confidence !== undefined ? true : undefined
        }
      >
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
        {submitted && problems.confidence !== undefined ? (
          <FieldError id={`${uid}-confidence-error`} message={problems.confidence} />
        ) : null}
      </fieldset>

      <fieldset
        className="rf-group"
        aria-describedby={
          submitted && problems.recommendation !== undefined
            ? `${uid}-recommendation-error`
            : undefined
        }
        aria-invalid={
          submitted && problems.recommendation !== undefined ? true : undefined
        }
      >
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
        {submitted && problems.recommendation !== undefined ? (
          <FieldError
            id={`${uid}-recommendation-error`}
            message={problems.recommendation}
          />
        ) : null}
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

      {error !== null ? (
        <p className="rf-error rf-commit-error" role="alert">
          <Icon name="alert" className="rf-error-icon" />
          <span>
            {error.message}
            {error.signIn ? (
              <>
                {" "}
                <a className="rf-link" href={signInHref}>
                  Sign in
                </a>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      <div className="rf-commit">
        <p className="rf-commit-note">
          {signed ? COMMIT_NOTE_SIGNED : COMMIT_NOTE}
        </p>
        <button
          type="submit"
          className="rf-button"
          disabled={phase === "signing"}
          aria-busy={phase === "signing" ? true : undefined}
        >
          {phase === "signing" ? "Signing…" : COMMIT_LABEL}
        </button>
      </div>
    </form>
  );
}

/**
 * What replaces the form once the commit is accepted. A review that will carry
 * its reviewer's name (`signed`) says so; an anonymous one says nothing more.
 */
export function SealedNotice({
  result,
  signed = false,
}: {
  result: ReviewCommitResult;
  signed?: boolean;
}) {
  const revealDate = formatRevealDate(result.revealAt);
  return (
    <section
      className="rf-sealed"
      role="status"
      aria-live="polite"
      data-state="sealed"
    >
      <h2 className="rf-form-title">{SEALED_HEADLINE}</h2>
      <p className="rf-sealed-text">
        It will be revealed with the others when a second review is committed,
        or on{" "}
        <time className="rf-sealed-date" dateTime={result.revealAt}>
          {revealDate}
        </time>
        .
      </p>
      {signed ? <p className="rf-sealed-text">{SEALED_SIGNED_NOTE}</p> : null}
      <p className="rf-sealed-id mono-id">Review {result.reviewCid}</p>
    </section>
  );
}

/** The last quote the paper handed the form, and the box it went into. */
interface CitedState {
  readonly id: DimensionId;
  /** Changes with every quote, so the box is focused again for each. */
  readonly nonce: number;
  /** Where it went, for the live region. */
  readonly message: string;
}

interface DimensionFieldProps {
  idBase: string;
  dimension: RubricDimension;
  score: Score | null;
  justification: string;
  problems: DimensionProblems;
  /** The justification box, so a cited quote can focus it. */
  boxRef: Ref<HTMLTextAreaElement>;
  /** The reviewer opened this box: the next quote goes here. */
  onFocusJustification: () => void;
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
  boxRef,
  onFocusJustification,
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
          ref={boxRef}
          className="rf-textarea"
          rows={3}
          required
          value={justification}
          aria-invalid={problems.justification === undefined ? undefined : true}
          aria-describedby={
            problems.justification === undefined ? undefined : justificationErrorId
          }
          onChange={(event) => onJustification(event.currentTarget.value)}
          onFocus={onFocusJustification}
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
