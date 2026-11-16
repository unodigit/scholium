"use client";

/**
 * ReviewsTab: the Reviews margin tab of the paper page
 * (docs/design.md §5.2, §7).
 *
 * ```tsx
 * <ReviewsTab paperId="sch:k3f9-q2xz-7mwd/v2" />
 * ```
 *
 * Formal reviews as cards — reviewer label, recommendation, rubric dots with
 * their text equivalent (`4 of 5`), an expandable report, and any author
 * replies — under a summary bar that shows the median score per rubric
 * dimension.
 *
 * The panel is deliberately quiet: a review is a person's considered
 * judgement, so the card leads with who and what they concluded, and the
 * rubric is reinforcement, never a score out of nowhere. Dots are decorative;
 * the words beside them (`4 of 5`) are the accessible value, so colour and
 * shape are never the only signal (§9).
 *
 * Report bodies stay sealed until the endpoint's gate opens (two reviews on
 * the version, or 21 days after the first). The card says which state it is
 * in rather than showing an empty expander; the rubric scores are public
 * either way, which is what makes the median bar useful before the gate
 * opens.
 *
 * The server route may pass `initial` (and `initialError` when its read
 * failed) so the first HTML already contains the reviews; on its own the tab
 * loads from `GET /v1/papers/{id}/reviews` and offers a retry. Every network
 * seam is injectable for tests.
 */

import { useEffect, useRef, useState } from "react";

import { ReviewCardActions, useViewer } from "../review-form";
import { SCORE_MAX } from "../review-form/rubric";
import { EmptyState, Icon, type IconName } from "../ui-kit";
import {
  dimensionMedians,
  formatReviewDate,
  medianText,
  recommendationTone,
  scoreFraction,
  scoreText,
  type AuthorReply,
  type RecommendationTone,
  type Review,
  type ReviewsData,
  type ReviewScore,
} from "./review";
import {
  classifyReviewsError,
  loadReviews,
  type LoadReviews,
  type ReviewsFailure,
} from "./reviews-api";
import { paperHref, reviewHref } from "./links";

import "./reviews-tab.css";

/** The icon that reinforces each recommendation family (never carries it alone). */
const TONE_ICONS: Readonly<Record<RecommendationTone, IconName>> = {
  supportive: "check",
  concerned: "alert",
  rejecting: "cross",
  neutral: "circle",
};

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ReviewsData }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function initialView(initial: ReviewsData | undefined, initialError: string | undefined): View {
  if (initialError !== undefined && initialError !== "") {
    return { kind: "error", message: initialError };
  }
  if (initial !== undefined) return { kind: "ready", data: initial };
  return { kind: "loading" };
}

function failureView(failure: ReviewsFailure): View {
  return failure.kind === "missing"
    ? { kind: "missing", message: failure.message }
    : { kind: "error", message: failure.message };
}

export interface ReviewsTabProps {
  /**
   * The paper whose reviews these are: a `sch:` id, a version id
   * (`sch:xxxx-xxxx-xxxx/v2`) or a bare short id.
   */
  paperId: string;
  /** The server's read, so the first HTML already has the reviews. */
  initial?: ReviewsData;
  /** Why the server's read failed; the tab offers a retry. */
  initialError?: string;
  /** The paper's newest listed version, for the Update action. */
  latestVersion?: number | null;
  /** Replace the loader, for tests or another source. Keep it stable. */
  load?: LoadReviews;
}

export function ReviewsTab({ paperId, initial, initialError, latestVersion, load }: ReviewsTabProps) {
  const [view, setView] = useState<View>(() => initialView(initial, initialError));
  const [attempt, setAttempt] = useState(0);

  // A host may swap `paperId` (an SPA navigating between papers) without
  // remounting: start over from this paper's data, never show the old one's.
  const [sourceKey, setSourceKey] = useState(paperId);
  if (sourceKey !== paperId) {
    setSourceKey(paperId);
    setView(initialView(initial, initialError));
    setAttempt(0);
  }

  // The latest loader without making an inline function restart the request.
  const loadRef = useRef<LoadReviews>(load ?? loadReviews);
  useEffect(() => {
    loadRef.current = load ?? loadReviews;
  }, [load]);

  // The server already asked: with an answer, or with a failure the reader is
  // looking at. Either way only a retry asks again, so an error the server
  // reported is not replaced by a spinner the moment the page hydrates.
  const serverAnswered =
    initial !== undefined || (initialError !== undefined && initialError !== "");

  useEffect(() => {
    if (attempt === 0 && serverAnswered) return;
    const controller = new AbortController();
    setView({ kind: "loading" });
    loadRef.current(paperId, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setView({ kind: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setView(failureView(classifyReviewsError(error)));
      },
    );
    return () => controller.abort();
  }, [paperId, attempt, serverAnswered]);

  const retry = () => setAttempt((count) => count + 1);
  const busy = view.kind === "loading";

  return (
    <section className="pr-tab" aria-label="Reviews" aria-busy={busy}>
      {view.kind === "loading" ? (
        <p className="pr-loading" role="status">
          Loading the reviews…
        </p>
      ) : null}

      {view.kind === "missing" ? (
        <div className="pr-empty">
          <EmptyState
            sentence="No reviews yet. Qualified in this paper's category? Review this paper."
            action={{ label: "Review this paper", href: reviewHref(paperId) }}
          />
        </div>
      ) : null}

      {view.kind === "error" ? (
        <div className="pr-failure" role="alert">
          <p className="pr-failure__text">{view.message}</p>
          <button type="button" className="pr-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {view.kind === "ready" ? (
        <ReviewsView
          data={view.data}
          paperId={paperId}
          latestVersion={latestVersion ?? view.data.version}
        />
      ) : null}
    </section>
  );
}

/** The loaded panel: the summary bar, the gate note, and the review cards. */
function ReviewsView({
  data,
  paperId,
  latestVersion,
}: {
  data: ReviewsData;
  paperId: string;
  latestVersion?: number | null;
}) {
  const reviews = data.reviews;
  const medians = dimensionMedians(reviews);

  if (reviews.length === 0) {
    return (
      <div className="pr-empty">
        <EmptyState
          sentence="No reviews yet. Qualified in this paper's category? Review this paper."
          action={{ label: "Review this paper", href: reviewHref(paperId) }}
        />
      </div>
    );
  }

  return (
    <>
      <p className="pr-summary-line">
        {data.version !== null ? `Version ${data.version} · ` : ""}
        {reviews.length} {reviews.length === 1 ? "review" : "reviews"}
        {!data.gateOpen ? " · reports sealed" : ""}
      </p>

      {!data.gateOpen ? (
        <p className="pr-gate" role="note">
          Report bodies stay sealed until two reviews are committed on this
          version, or 21 days after the first. The rubric scores are already
          public.
        </p>
      ) : null}

      {medians.length > 0 ? <MedianSummary rows={medians} /> : null}

      <ol className="pr-list">
        {reviews.map((review) => (
          <li className="pr-list__item" key={review.key}>
            <ReviewCard
              review={review}
              gateOpen={data.gateOpen}
              paperId={paperId}
              latestVersion={latestVersion ?? data.version}
            />
          </li>
        ))}
      </ol>

      <p className="pr-footnote">
        <a className="pr-link" href={paperHref(paperId)}>
          Read the paper
        </a>
      </p>
    </>
  );
}

/** The median-per-dimension summary bar (docs/design.md §5.2). */
function MedianSummary({ rows }: { rows: ReturnType<typeof dimensionMedians> }) {
  return (
    <section className="pr-summary" aria-labelledby="pr-summary-title">
      <h3 className="pr-summary__title" id="pr-summary-title">
        Median scores
      </h3>
      <p className="pr-summary__note">
        Median per rubric dimension, across the reviews that served a score.
      </p>
      <dl className="pr-summary__rows">
        {rows.map((row) => (
          <div className="pr-summary__row" key={row.dimension}>
            <dt className="pr-summary__label">{row.label}</dt>
            <dd className="pr-summary__reading">
              <span className="pr-meter" aria-hidden="true">
                <span
                  className="pr-meter__fill"
                  style={{ width: `${Math.round(scoreFraction(row.median) * 1000) / 10}%` }}
                />
              </span>
              <span className="pr-summary__value">
                <strong>{medianText(row.median)}</strong>
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** One formal review as a card. */
function ReviewCard({
  review,
  gateOpen,
  paperId,
  latestVersion,
}: {
  review: Review;
  gateOpen: boolean;
  paperId: string;
  latestVersion: number | null;
}) {
  const headingId = `pr-review-${review.key.replace(/[^a-z0-9]+/gi, "-").slice(-48)}`;
  const tone = recommendationTone(review.recommendation);
  const date = formatReviewDate(review.committedAt);
  const viewer = useViewer();

  const meta: string[] = ["Anonymous reviewer"];
  if (date !== null) meta.push(`Reviewed ${date}`);
  if (review.confidenceLabel !== null) meta.push(`Confidence: ${review.confidenceLabel}`);

  return (
    <article className="pr-card" aria-labelledby={headingId}>
      <header className="pr-card__header">
        <h4 className="pr-card__label" id={headingId}>
          {review.label}
        </h4>
        <p className="pr-card__meta">{meta.join(" · ")}</p>
        <p className={`pr-recommendation pr-recommendation--${tone}`}>
          <Icon name={TONE_ICONS[tone]} />
          <span>{review.recommendationLabel}</span>
        </p>
      </header>

      {review.scores.length > 0 ? (
        <dl className="pr-rubric">
          {review.scores.map((score) => (
            <RubricRow key={score.dimension} score={score} />
          ))}
        </dl>
      ) : (
        <p className="pr-rubric__none">The rubric is not available for this review.</p>
      )}

      {review.report !== null ? (
        <details className="pr-report">
          <summary className="pr-report__summary">Read the report</summary>
          <p className="pr-report__body">{review.report}</p>
        </details>
      ) : (
        <p className="pr-report__sealed">
          {gateOpen
            ? "This review has not been revealed yet."
            : "Report sealed until two reviews are committed on this version, or 21 days after the first."}
        </p>
      )}

      {review.replies.length > 0 ? (
        <section className="pr-replies" aria-label="Author replies">
          <h5 className="pr-replies__title">
            {review.replies.length === 1 ? "Author reply" : "Author replies"}
          </h5>
          {review.replies.map((reply) => (
            <ReplyBlock key={reply.id} reply={reply} />
          ))}
        </section>
      ) : null}

      {(() => {
        const isOlder =
          review.report !== null &&
          review.version !== null &&
          latestVersion !== null &&
          review.version < latestVersion;
        const canUpdate =
          isOlder &&
          viewer.signedIn &&
          (review.signedBy == null || review.signedBy === viewer.did);
        if (!canUpdate) return null;
        const prev = review.formalCid ?? review.reviewCid ?? null;
        const href = prev !== null
          ? `${reviewHref(paperId)}?prev=${encodeURIComponent(prev)}`
          : reviewHref(paperId);
        return (
          <p className="pr-update">
            <a className="pr-link" href={href}>
              {`Update for v${latestVersion}`}
            </a>
          </p>
        );
      })()}

      {/* The reply and the rating for whoever may act (docs/design.md §5.2).
          The component offers nothing on a sealed review, to a signed-out
          reader, or to someone the API would refuse; the API is the gate. */}
      <ReviewCardActions review={review} paperId={paperId} />
    </article>
  );
}

/** One rubric dimension: dots, and the words that carry the value. */
function RubricRow({ score }: { score: ReviewScore }) {
  const filled = Math.round(score.score);
  return (
    <div className="pr-rubric__row">
      <dt className="pr-rubric__label">{score.label}</dt>
      <dd className="pr-rubric__reading">
        <span className="pr-dots" aria-hidden="true">
          {Array.from({ length: SCORE_MAX }, (_, index) => (
            <span
              // A fixed five-dot scale: the index is the position, not an id.
              key={index}
              className={index < filled ? "pr-dot pr-dot--on" : "pr-dot"}
            />
          ))}
        </span>
        <span className="pr-rubric__score">{scoreText(score.score)}</span>
      </dd>
    </div>
  );
}

/** An author's reply, point by point where the endpoint gives dimensions. */
function ReplyBlock({ reply }: { reply: AuthorReply }) {
  const meta = [reply.author ?? "The authors"];
  if (reply.version !== null) meta.push(`v${reply.version}`);
  const date = formatReviewDate(reply.createdAt);
  if (date !== null) meta.push(date);

  return (
    <div className="pr-reply">
      <p className="pr-reply__meta">{meta.join(" · ")}</p>
      {reply.text !== null ? <p className="pr-reply__text">{reply.text}</p> : null}
      {reply.items.length > 0 ? (
        <dl className="pr-reply__items">
          {reply.items.map((item, index) => (
            <div className="pr-reply__item" key={`${item.dimension ?? "item"}-${index}`}>
              {item.label !== null ? (
                <dt className="pr-reply__label">{item.label}</dt>
              ) : null}
              <dd className="pr-reply__answer">{item.text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
