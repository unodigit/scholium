"use client";

/**
 * What a reader can do on a revealed review card (spec feature 168,
 * docs/design.md §5.2):
 *
 * - **Authors** get a point-by-point reply form: one box per rubric dimension
 *   (plus a general reply), signed with their own key and sent as a
 *   `review.response`.
 * - **Tier-3 members** who are neither the reviewer nor an author get a
 *   quality rating, 1–5, sent as a `review.rating`.
 *
 * ```tsx
 * <ReviewCardActions review={review} paperId="sch:k3f9-q2xz-7mwd" />
 * ```
 *
 * The component sits at the foot of a review card and offers nothing until it
 * has something to offer: a sealed review has nothing to answer or rate, a
 * signed-out reader is not asked, and a reader who is not an author or a
 * tier-3 member sees the card as it was. Who may do what is the API's call —
 * this only chooses which control to show (see `viewer.ts`) — so a refusal is
 * shown in the API's own words and the control stays where it was.
 *
 * Accessibility (docs/design.md §9): the reply form is a `details` expander
 * (like the report) with a labelled box per point, the rating is a `fieldset`
 * of radios each named with its text equivalent ("4 of 5"), every target is at
 * least 44 px, and an outcome is an icon plus words in a live region, never
 * colour alone.
 */

import { useId, useState } from "react";
import type { FormEvent } from "react";

import { Icon } from "../ui-kit/icons";
import type { ActionFailure } from "./action-errors";
import {
  RATING_HINT,
  RATING_LABEL,
  RATING_SUBMIT_LABEL,
  RATING_VALUES,
  describeRatingError,
  isRating,
  ratingText,
  rateReview,
  type RateReview,
  type RatingResult,
} from "./rating";
import {
  REPLY_LABEL,
  REPLY_POINTS,
  REPLY_SIGNING_NOTE,
  REPLY_SUBMIT_LABEL,
  describeReplyError,
  describeReplyProgress,
  emptyReplyDraft,
  isReplyComplete,
  respondToReview,
  withReply,
  type ReplyDraft,
  type ReplyPointId,
  type ReplyResult,
  type RespondToReview,
} from "./reply";
import { SCORE_MAX, type Score } from "./rubric";
import { usePaperAuthors, useViewer } from "./use-viewer";
import { offerFor, type LoadPaperAuthors, type Viewer } from "./viewer";
import "./review-actions.css";

/** Said when the author tries to send an empty reply. */
const EMPTY_REPLY_HINT = "Write a reply to at least one point before sending.";

/**
 * The part of a review the actions need. The reviews tab's own `Review`
 * satisfies it, so this feature does not import that one.
 */
export interface ReviewCardTarget {
  /** The review's cid: what a reply or a rating names. */
  readonly reviewCid: string | null;
  /** `Reviewer A`, for headings and accessible names. */
  readonly label: string;
  /** The report body; `null` while the review is still sealed. */
  readonly report: string | null;
  /**
   * The instant the review was revealed; `null` while it is only sealed.
   * When a host omits it, a served report is the signal that it is revealed.
   */
  readonly revealedAt?: string | null;
  /** What the reviewer scored, so the author sees the point being answered. */
  readonly scores?: readonly {
    readonly dimension: string;
    readonly score: number;
  }[];
}

export interface ReviewCardActionsProps {
  review: ReviewCardTarget;
  /** The paper (a `sch:` id, with or without `/vN`): its byline says who may reply. */
  paperId: string;
  /** Pin the viewer instead of reading it from the signed-in session. */
  viewer?: Viewer;
  /** The paper's authors' DIDs, when the host already has them. */
  authorDids?: readonly string[];
  /** Replace the byline read, for tests. */
  loadAuthors?: LoadPaperAuthors;
  /** Replace the reply flow (sign and send), for tests. */
  respond?: RespondToReview;
  /** Replace the rating flow, for tests. */
  rate?: RateReview;
  /** Called once a reply has been accepted, so a host can reload the reviews. */
  onResponded?: (result: ReplyResult) => void;
  /** Called once a rating has been accepted. */
  onRated?: (result: RatingResult) => void;
  /** Where "Sign in" goes when a session has ended. */
  signInHref?: string;
}

const DEFAULT_SIGN_IN_HREF = "/signin";

/** The reply form and the rating, for whoever may use them; otherwise nothing. */
export function ReviewCardActions({
  review,
  paperId,
  viewer: viewerOverride,
  authorDids,
  loadAuthors,
  respond,
  rate,
  onResponded,
  onRated,
  signInHref = DEFAULT_SIGN_IN_HREF,
}: ReviewCardActionsProps) {
  const viewer = useViewer(viewerOverride);

  const reviewCid = review.reviewCid?.trim() ?? "";
  // A review is answered and rated once it is revealed. The reveal date is the
  // signal: a revealed review may legitimately carry no written report, so the
  // report cannot stand in for reveal state (older hosts sent only the report).
  const revealed =
    reviewCid !== "" &&
    ((typeof review.revealedAt === "string" && review.revealedAt !== "") ||
      review.report !== null);

  // The byline is only worth a request for someone who could act on it.
  const authors = usePaperAuthors(
    paperId,
    revealed && viewer.signedIn,
    authorDids,
    loadAuthors,
  );

  if (!revealed || !viewer.signedIn) return null;
  // Waiting for the byline: showing the rating now and taking it away if the
  // viewer turns out to be an author would be a control that flickers.
  if (authors.status === "loading") return null;

  const offer = offerFor(viewer, authors.status === "ready" ? authors.dids : null);
  if (!offer.reply && !offer.rate) return null;

  return (
    <section className="ra-actions" aria-label={`Your response to ${review.label}`}>
      {offer.reply ? (
        <ReplyForm
          reviewCid={reviewCid}
          label={review.label}
          scores={review.scores}
          respond={respond ?? respondToReview}
          onResponded={onResponded}
          signInHref={signInHref}
        />
      ) : null}
      {offer.rate ? (
        <RatingControl
          reviewCid={reviewCid}
          label={review.label}
          rate={rate ?? rateReview}
          onRated={onRated}
          signInHref={signInHref}
        />
      ) : null}
    </section>
  );
}

/** An icon and words, never colour alone (docs/design.md §9). */
function Failure({
  id,
  failure,
  signInHref,
}: {
  id?: string;
  failure: ActionFailure;
  signInHref: string;
}) {
  return (
    <p id={id} className="ra-error" role="alert">
      <Icon name="alert" className="ra-error__icon" />
      <span>
        {failure.message}
        {failure.signIn ? (
          <>
            {" "}
            <a className="ra-link" href={signInHref}>
              Sign in
            </a>
          </>
        ) : null}
      </span>
    </p>
  );
}

// ---- The reply form --------------------------------------------------------

interface ReplyFormProps {
  reviewCid: string;
  label: string;
  scores: ReviewCardTarget["scores"];
  respond: RespondToReview;
  onResponded?: (result: ReplyResult) => void;
  signInHref: string;
}

type ReplyPhase = "editing" | "signing" | "sent";

/** What the reviewer scored a point, as the words the card uses (`4 of 5`). */
function scoredText(
  scores: ReviewCardTarget["scores"],
  point: ReplyPointId,
): string | null {
  const found = scores?.find((entry) => entry.dimension === point);
  if (found === undefined || !Number.isFinite(found.score)) return null;
  const shown = Number.isInteger(found.score)
    ? String(found.score)
    : found.score.toFixed(1);
  return `Reviewer scored ${shown} of ${SCORE_MAX}`;
}

/** The point-by-point reply form, behind an expander so the card stays short. */
function ReplyForm({
  reviewCid,
  label,
  scores,
  respond,
  onResponded,
  signInHref,
}: ReplyFormProps) {
  const uid = useId();
  const [draft, setDraft] = useState<ReplyDraft>(emptyReplyDraft);
  const [phase, setPhase] = useState<ReplyPhase>("editing");
  const [sent, setSent] = useState<ReplyResult | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<ActionFailure | null>(null);

  const complete = isReplyComplete(draft);
  const emptyId = `${uid}-empty`;

  const send = async (): Promise<void> => {
    if (phase === "signing") return;

    setAttempted(true);
    if (!complete) {
      // The message under the boxes says what is missing; nothing is signed.
      setError(null);
      return;
    }

    setError(null);
    setPhase("signing");
    try {
      const result = await respond({ reviewCid, draft });
      setSent(result);
      setPhase("sent");
      onResponded?.(result);
    } catch (thrown) {
      setError(describeReplyError(thrown));
      setPhase("editing");
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // Sending is the only submit; Enter must not reload the page.
    event.preventDefault();
    void send();
  };

  return (
    <details className="ra-reply">
      <summary className="ra-summary">{REPLY_LABEL}</summary>

      {phase === "sent" && sent !== null ? (
        <ReplySent result={sent} label={label} />
      ) : (
        <form
          className="ra-form"
          aria-label={`Reply to ${label}`}
          noValidate
          onSubmit={onSubmit}
        >
          <p className="ra-lede">
            Answer the points you want to answer. Points you leave blank are not
            sent.
          </p>

          {REPLY_POINTS.map((point) => {
            const boxId = `${uid}-${point.id}`;
            const context = scoredText(scores, point.id);
            return (
              <div className="ra-point" key={point.id} data-point={point.id}>
                <label className="ra-point__label" htmlFor={boxId}>
                  {point.label}
                </label>
                {context !== null ? (
                  <p className="ra-point__context" id={`${boxId}-context`}>
                    {context}
                  </p>
                ) : null}
                <textarea
                  id={boxId}
                  className="ra-textarea"
                  rows={3}
                  value={draft[point.id]}
                  disabled={phase === "signing"}
                  aria-describedby={
                    [
                      context !== null ? `${boxId}-context` : null,
                      attempted && !complete ? emptyId : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" ") || undefined
                  }
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setDraft((current) => withReply(current, point.id, text));
                  }}
                />
              </div>
            );
          })}

          <p className="ra-progress" role="status">
            {describeReplyProgress(draft)}
          </p>

          {attempted && !complete ? (
            <p id={emptyId} className="ra-error" role="alert">
              <Icon name="alert" className="ra-error__icon" />
              <span>{EMPTY_REPLY_HINT}</span>
            </p>
          ) : null}

          {error !== null ? (
            <Failure failure={error} signInHref={signInHref} />
          ) : null}

          <div className="ra-submit">
            <p className="ra-note">{REPLY_SIGNING_NOTE}</p>
            <button
              type="submit"
              className="ra-button"
              disabled={phase === "signing"}
              aria-busy={phase === "signing" ? true : undefined}
            >
              {phase === "signing" ? "Signing…" : REPLY_SUBMIT_LABEL}
            </button>
          </div>
        </form>
      )}
    </details>
  );
}

/** The label of a point, as the form showed it. */
function pointLabel(id: ReplyPointId): string {
  return REPLY_POINTS.find((point) => point.id === id)?.label ?? id;
}

/** After a reply is accepted: say so, and show what was sent. */
function ReplySent({ result, label }: { result: ReplyResult; label: string }) {
  return (
    <div className="ra-sent" role="status">
      <p className="ra-sent__headline">
        <Icon name="check" className="ra-sent__icon" />
        <span>Reply sent to {label}</span>
      </p>
      <p className="ra-note">
        It is signed with your key and will appear under the review when the
        reviews reload.
      </p>
      <dl className="ra-sent__items">
        {result.body.items.map((item) => (
          <div className="ra-sent__item" key={item.dimension}>
            <dt className="ra-sent__label">{pointLabel(item.dimension)}</dt>
            <dd className="ra-sent__answer">{item.reply}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---- The rating ------------------------------------------------------------

interface RatingControlProps {
  reviewCid: string;
  label: string;
  rate: RateReview;
  onRated?: (result: RatingResult) => void;
  signInHref: string;
}

type RatingPhase = "editing" | "sending" | "rated";

/** The quality rating: five radios and one button, once per review. */
function RatingControl({
  reviewCid,
  label,
  rate,
  onRated,
  signInHref,
}: RatingControlProps) {
  const uid = useId();
  const [rating, setRating] = useState<Score | null>(null);
  const [phase, setPhase] = useState<RatingPhase>("editing");
  const [recorded, setRecorded] = useState<Score | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<ActionFailure | null>(null);

  const missing = attempted && rating === null;
  const hintId = `${uid}-hint`;
  const missingId = `${uid}-missing`;

  const send = async (): Promise<void> => {
    if (phase === "sending") return;

    setAttempted(true);
    if (rating === null || !isRating(rating)) {
      setError(null);
      return;
    }

    setError(null);
    setPhase("sending");
    try {
      const result = await rate({ reviewCid, rating });
      setRecorded(result.rating);
      setPhase("rated");
      onRated?.(result);
    } catch (thrown) {
      setError(describeRatingError(thrown));
      setPhase("editing");
    }
  };

  if (phase === "rated" && recorded !== null) {
    return (
      <div className="ra-rating ra-rating--done" role="status">
        <p className="ra-sent__headline">
          <Icon name="check" className="ra-sent__icon" />
          <span>
            You rated {label} {ratingText(recorded)}
          </span>
        </p>
        <p className="ra-note">
          Thank you. A rating is about the review’s quality. It is recorded with
          the review and never changes the paper’s status.
        </p>
      </div>
    );
  }

  return (
    <form
      className="ra-rating"
      aria-label={`Rate ${label}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <fieldset
        className="ra-group"
        aria-describedby={[hintId, missing ? missingId : null]
          .filter((part): part is string => part !== null)
          .join(" ")}
        aria-invalid={missing ? true : undefined}
      >
        <legend className="ra-legend">{RATING_LABEL}</legend>
        <p className="ra-note" id={hintId}>
          {RATING_HINT}
        </p>

        <div className="ra-choices">
          {RATING_VALUES.map((value) => (
            <label key={value} className="ra-choice">
              <input
                type="radio"
                name={`${uid}-rating`}
                value={value}
                required
                checked={rating === value}
                disabled={phase === "sending"}
                onChange={() => setRating(value)}
              />
              {/* The digit is the picture; the words are the text equivalent. */}
              <span aria-hidden="true">{value}</span>
              <span className="ra-sr-only">{ratingText(value)}</span>
            </label>
          ))}
        </div>

        {missing ? (
          <p id={missingId} className="ra-error" role="alert">
            <Icon name="alert" className="ra-error__icon" />
            <span>Choose a rating from 1 to {SCORE_MAX} before sending.</span>
          </p>
        ) : null}
      </fieldset>

      {error !== null ? <Failure failure={error} signInHref={signInHref} /> : null}

      <button
        type="submit"
        className="ra-button"
        disabled={phase === "sending"}
        aria-busy={phase === "sending" ? true : undefined}
      >
        {phase === "sending" ? "Sending…" : RATING_SUBMIT_LABEL}
      </button>
    </form>
  );
}
