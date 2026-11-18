/**
 * The shape of a paper's formal reviews, and parsing them from
 * `GET /v1/papers/{id}/reviews` (feature 110's endpoint).
 *
 * The endpoint serves the reviews of the paper's resolved listed version:
 *
 * ```json
 * {
 *   "paper": "sch:k3f9-q2xz-7mwd", "version": 2, "versionCid": "bafy…",
 *   "gate_open": true,
 *   "reviews": [
 *     {
 *       "review_cid": "bafy…", "label": "Reviewer A",
 *       "recommendation": "minor_revisions", "confidence": 3,
 *       "committed_at": "2027-03-02T04:00:00",
 *       "scores": {
 *         "soundness": {"score": 4, "justification": "…"},
 *         "evidence": {"score": 3, "justification": "…"}, …
 *       },
 *       "report": "…"            // absent while reports stay sealed
 *     }
 *   ]
 * }
 * ```
 *
 * Report bodies stay sealed until two reviews are committed on the version or
 * 21 days pass since the first commit (the endpoint's `gate_open`); the rubric
 * scores are served either way, because they are what the summary bar is made
 * of. Anonymous reviewers arrive already labelled `Reviewer A`, `Reviewer B`
 * per paper. Author replies (`review.response`, with items keyed by rubric
 * dimension) will travel with the review once that endpoint lands; this module
 * already reads them, so the card grows a reply section without a rewrite.
 *
 * Parsing is tolerant on purpose, like the rest of the tabs: the API spells
 * fields more than one way and may grow more, so this reads the spellings it
 * knows, keeps what it recognises and never throws. Anything it cannot
 * understand degrades to a neutral label rather than a blank panel.
 */

import {
  RUBRIC_DIMENSIONS,
  SCORE_MAX,
} from "../review-form/rubric";
import { formatDate as formatReaderDate, toDate } from "../ui-kit/format-date";

/** A compact label for a rubric dimension, as the review card shows it. */
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  soundness: "Soundness",
  evidence: "Evidence",
  reproducibility: "Reproducibility",
  novelty: "Novelty",
  clarity: "Clarity",
  limitations: "Limitations & ethics",
};

/** The six dimensions in the order the rubric and the summary bar use. */
export const DIMENSION_ORDER: readonly string[] = RUBRIC_DIMENSIONS.map(
  (dimension) => dimension.id,
);

/** The label of a dimension id, or a readable spelling of an unknown one. */
export function dimensionLabel(dimension: string): string {
  const id = normaliseKey(dimension);
  const known = DIMENSION_LABELS[id];
  if (known !== undefined) return known;
  const words = id.replace(/[_-]+/g, " ").trim();
  if (words === "") return "Rubric dimension";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One dimension as a review scored it. */
export interface ReviewScore {
  /** The wire key, e.g. `soundness`. */
  readonly dimension: string;
  /** The card's label, e.g. `Soundness`. */
  readonly label: string;
  /** 1–5, as the rubric defines it. */
  readonly score: number;
  /** The reviewer's justification, when the endpoint serves it. */
  readonly justification: string | null;
}

/** One point-by-point answer to a rubric dimension (`review.response` items). */
export interface AuthorReplyItem {
  /** The dimension key, when the reply names one. */
  readonly dimension: string | null;
  /** The dimension's label, when it names one. */
  readonly label: string | null;
  /** The author's words for that point. */
  readonly text: string;
}

/** An author's reply to a review (feature 114; shown beside the card). */
export interface AuthorReply {
  /** Stable key for list rendering. */
  readonly id: string;
  /** A human author name when the API serves one; never a DID. */
  readonly author: string | null;
  /** The paper version the reply is written against, when named. */
  readonly version: number | null;
  /** A reply without per-dimension items. */
  readonly text: string | null;
  /** Point-by-point answers, keyed by rubric dimension. */
  readonly items: readonly AuthorReplyItem[];
  /** When the reply was written, as served. */
  readonly createdAt: string | null;
}

/** One earlier revision of a review that has been updated across versions. */
export interface ReviewRevision {
  /** Stable key for list rendering. */
  readonly key: string;
  /** The cid of the `review.formal` this revision was revealed as. */
  readonly formalCid: string | null;
  /** The paper version this revision is of, when named. */
  readonly version: number | null;
  /** The wire recommendation for this revision. */
  readonly recommendation: string | null;
  /** `Minor revisions`, in the reader's words. */
  readonly recommendationLabel: string;
  /** When this revision was revealed, as served. */
  readonly revealedAt: string | null;
  /** This revision's report body, when the gate serves it. */
  readonly report: string | null;
  /** This revision's rubric, in canonical dimension order. */
  readonly scores: readonly ReviewScore[];
}

/** One formal review, as a card shows it. */
export interface Review {
  /** Stable key for list rendering. */
  readonly key: string;
  /** The record's cid, when the endpoint names it. */
  readonly reviewCid: string | null;
  /** `Reviewer A`, `Reviewer B`, … per paper (or a signed reviewer's name). */
  readonly label: string;
  /** The wire recommendation, e.g. `minor_revisions`. */
  readonly recommendation: string | null;
  /** `Minor revisions`, in the reader's words. */
  readonly recommendationLabel: string;
  /** `Low` / `Medium` / `High`, when the endpoint serves a confidence. */
  readonly confidenceLabel: string | null;
  /** The rubric, in canonical dimension order. */
  readonly scores: readonly ReviewScore[];
  /** The report body; `null` while it stays sealed. */
  readonly report: string | null;
  /** Author replies that arrived with the review. */
  readonly replies: readonly AuthorReply[];
  /**
   * Every revision of this reviewer's review of the paper, oldest version
   * first; the latest is the review itself. Empty when the endpoint serves no
   * history (a first reveal).
   */
  readonly history?: readonly ReviewRevision[];
  /** The instant the review was committed, as served. */
  readonly committedAt: string | null;
  /**
   * The instant the review (its newest one, if revised) was revealed, as served;
   * `null` while it is only sealed. Unlike the report, which stays out of the
   * listing until its gate opens, this is served as soon as it is revealed.
   */
  readonly revealedAt?: string | null;
  /** The paper version the review is written against, when named. */
  readonly version: number | null;
  /** The reviewer's DID when they signed the review with their name, when named. */
  readonly signedBy?: string | null;
  /** The cid of the `review.formal` the review stands on, when named. */
  readonly formalCid?: string | null;
}

/**
 * Whether a review is revealed, as the listing says.
 *
 * The reveal date is the signal: a revealed review with no written report has
 * `report === null` but is not sealed, so the report can never stand in for
 * reveal state. A host that carries only the report (older payloads) still
 * reads as revealed when it is present.
 */
export function isRevealed(
  review: Pick<Review, "revealedAt" | "report">,
): boolean {
  const revealedAt = review.revealedAt;
  if (typeof revealedAt === "string" && revealedAt !== "") return true;
  // A payload that predates the reveal date carried only the report: a served
  // report still means the review is open. A sealed review serves neither.
  return review.report !== null;
}

/** A paper's formal reviews and the state of the reveal gate. */
export interface ReviewsData {
  /** The paper's short id, when the endpoint names it. */
  readonly paper: string | null;
  /** The canonical `sch:` id, when the endpoint names it. */
  readonly shortId: string | null;
  /** The resolved version's cid, when named. */
  readonly versionCid: string | null;
  /** The resolved version number, when named. */
  readonly version: number | null;
  /** Whether report bodies are being served yet. */
  readonly gateOpen: boolean;
  /** The reviews, in the endpoint's (commit) order. */
  readonly reviews: readonly Review[];
  /** The number of reviews. */
  readonly count: number;
}

/** One row of the median-per-dimension summary bar. */
export interface DimensionMedian {
  readonly dimension: string;
  readonly label: string;
  /** The median score (a half point is possible with an even count). */
  readonly median: number;
  /** How many reviews contributed a score. */
  readonly count: number;
}

/** The recommendation labels the record schema and form agree on (§5.5). */
const RECOMMENDATION_LABELS: Readonly<Record<string, string>> = {
  sound_as_is: "Sound as is",
  minor_revisions: "Minor revisions",
  major_concerns: "Major concerns",
  fundamentally_flawed: "Fundamentally flawed",
};

/** How a recommendation reads: supportive, concerned, rejecting, or unknown. */
export type RecommendationTone = "supportive" | "concerned" | "rejecting" | "neutral";

/** Lowercase a field name and turn whitespace/hyphens into underscores. */
function normaliseKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? null : text;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textOf(value);
    if (text !== null) return text;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = numberOf(value);
    if (number !== null) return number;
  }
  return null;
}

function booleanOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Whether a served string is an opaque identifier rather than a name. */
function looksLikeIdentifier(value: string): boolean {
  if (/^did:/i.test(value)) return true;
  // cids, keys and hashes are long and have no spaces.
  return value.length > 40 && !/\s/.test(value);
}

/** The anonymous label of a review at `index`: `Reviewer A`, `Reviewer B`, … */
export function reviewerLabelAt(index: number): string {
  const safe = Number.isInteger(index) && index >= 0 ? index : 0;
  const letter = safe < 26 ? String.fromCharCode(65 + safe) : String(safe + 1);
  return `Reviewer ${letter}`;
}

/**
 * The reader-facing recommendation.
 *
 * Accepts the record's snake_case value, an already-human label, or a common
 * spelling from another node; an unknown value is shown as written rather
 * than hidden.
 */
export function recommendationLabel(value: unknown): string {
  const raw = textOf(value);
  if (raw === null) return "No recommendation";
  const known = RECOMMENDATION_LABELS[normaliseKey(raw)];
  if (known !== undefined) return known;
  const words = raw.trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which family a recommendation belongs to, for its icon and tint. */
export function recommendationTone(value: unknown): RecommendationTone {
  const raw = textOf(value);
  if (raw === null) return "neutral";
  const key = normaliseKey(raw);
  if (key in RECOMMENDATION_LABELS) {
    if (key === "sound_as_is" || key === "minor_revisions") return "supportive";
    if (key === "major_concerns") return "concerned";
    return "rejecting";
  }
  if (/(^|_)(strong_|weak_)?accept$/.test(key)) return "supportive";
  if (/(^|_)(strong_|weak_)?reject$/.test(key)) return "rejecting";
  if (key === "borderline" || key === "revise") return "concerned";
  return "neutral";
}

/**
 * The reader-facing confidence.
 *
 * The API stores a confidence as an integer 1–5 (`Low` at the low end,
 * `High` at the high end) but a client may send the words; both are read.
 */
export function confidenceLabel(value: unknown): string | null {
  const raw = textOf(value);
  if (raw === null) return null;
  const key = normaliseKey(raw);
  if (key === "low" || key === "medium" || key === "high") {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  const number = numberOf(raw);
  if (number === null) return null;
  const clamped = Math.min(5, Math.max(1, number));
  if (clamped <= 2) return "Low";
  if (clamped === 3) return "Medium";
  return "High";
}

/** `4 of 5` — the text equivalent of the rubric dots. */
export function scoreText(score: number): string {
  const shown = Number.isInteger(score) ? String(score) : score.toFixed(1);
  return `${shown} of ${SCORE_MAX}`;
}

/**
 * `4.0 of 5` — a median in the summary bar.
 *
 * Always one decimal, so a summary value never reads as a single review's
 * integer score (and a half-point median is obvious): the card and the bar
 * deliberately do not look like the same number.
 */
export function medianText(score: number): string {
  return `${score.toFixed(1)} of ${SCORE_MAX}`;
}

/**
 * How a date is written: `2 Mar 2027`, in the reader's own time zone through
 * the shared `ui-kit` formatter, so the review card names the same day as the
 * discussion and the profile (bug_spec_verify12 bug 2).
 */
export function formatReviewDate(value: string | null | undefined): string | null {
  return formatReaderDate(value);
}

/** Days after the first commit on a version that its reports unseal regardless (REV-4). */
export const REPORT_GATE_DAYS = 21;

/**
 * The day the reports of the listed version unseal on the clock alone: 21 days
 * after the first review counted on it, written like `formatReviewDate`.
 *
 * A review counts on the version when it is written against it or has been
 * updated to it (the listing serves that as the review's `version`); the
 * earlier reviews a later listing merely carries do not, so they never move the
 * date. `null` when no counted review has a served commit date, and then the
 * copy falls back to "21 days after the first".
 */
export function reportGateInstant(
  reviews: readonly Pick<Review, "committedAt" | "version">[],
  version: number | null,
): Date | null {
  let first: Date | null = null;
  for (const review of reviews) {
    if (version !== null && review.version !== null && review.version !== version) continue;
    // The earliest commit *instant* counted on the version; the window is
    // added to that instant, never to a truncated UTC day, so this page and
    // the reviewer's form (`revealDateFor`) name the same calendar day.
    const committed = toDate(textOf(review.committedAt));
    if (committed === null) continue;
    if (first === null || committed.getTime() < first.getTime()) first = committed;
  }
  if (first === null) return null;
  return new Date(first.getTime() + REPORT_GATE_DAYS * 86_400_000);
}

/**
 * The gate day as a string, in the reader's own time zone.
 *
 * A page that renders the date inside its first HTML uses
 * {@link reportGateInstant} with `LocalDate` instead, so the server's stable
 * UTC form and the reader's local day never disagree during hydration.
 */
export function reportGateDate(
  reviews: readonly Pick<Review, "committedAt" | "version">[],
  version: number | null,
): string | null {
  const gate = reportGateInstant(reviews, version);
  return gate === null ? null : formatReaderDate(gate);
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read a wire `scores` value into the canonical six-dimension order.
 *
 * Accepts the endpoint's `{dimension: {score, justification}}` object as well
 * as `{dimension: number}` and an array of `{dimension, score}` records. A
 * dimension outside 1–5 is not a rubric score and is dropped.
 */
export function parseScores(raw: unknown): ReviewScore[] {
  const found = new Map<string, ReviewScore>();

  const add = (dimension: unknown, entry: unknown): void => {
    const name = textOf(dimension);
    if (name === null) return;
    const key = normaliseKey(name);
    if (key === "") return;

    let score: number | null = null;
    let justification: string | null = null;

    if (typeof entry === "number" || typeof entry === "string") {
      score = numberOf(entry);
    } else {
      const record = recordOf(entry);
      if (record === null) return;
      score = firstNumber(record.score, record.value, record.rating);
      justification = firstText(
        record.justification,
        record.note,
        record.comment,
        record.text,
      );
    }

    if (score === null || score < 1 || score > SCORE_MAX) return;
    found.set(key, {
      dimension: key,
      label: dimensionLabel(key),
      score,
      justification,
    });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = recordOf(entry);
      if (record === null) continue;
      add(firstText(record.dimension, record.id, record.key, record.name), record);
    }
  } else {
    const record = recordOf(raw);
    if (record !== null) {
      for (const [dimension, entry] of Object.entries(record)) add(dimension, entry);
    }
  }

  const ordered: ReviewScore[] = [];
  for (const dimension of DIMENSION_ORDER) {
    const score = found.get(dimension);
    if (score !== undefined) {
      ordered.push(score);
      found.delete(dimension);
    }
  }
  for (const score of found.values()) ordered.push(score);
  return ordered;
}

/** Turn the answer to one dimension into a reply item, or `null`. */
function replyItemOf(dimension: unknown, entry: unknown): AuthorReplyItem | null {
  const name = textOf(dimension);
  let text: string | null = null;

  if (typeof entry === "string") {
    text = textOf(entry);
  } else {
    const record = recordOf(entry);
    if (record !== null) {
      text = firstText(record.text, record.reply, record.response, record.body);
      const named = firstText(
        record.dimension,
        record.rubric_dimension,
        record.rubricDimension,
        record.criterion,
        record.id,
        record.key,
        record.name,
      );
      if (name === null && named !== null) {
        return {
          dimension: normaliseKey(named),
          label: dimensionLabel(named),
          text: text ?? "",
        };
      }
    }
  }

  if (name === null || text === null || text === "") return null;
  return {
    dimension: normaliseKey(name),
    label: dimensionLabel(name),
    text,
  };
}

/** The point-by-point items of a reply, from an array or a dimension map. */
function replyItemsOf(raw: unknown): AuthorReplyItem[] {
  const items: AuthorReplyItem[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = recordOf(entry);
      if (record === null) continue;
      const item = replyItemOf(
        firstText(
          record.dimension,
          record.rubric_dimension,
          record.rubricDimension,
          record.criterion,
          record.id,
          record.key,
          record.name,
        ),
        record,
      );
      if (item !== null) items.push(item);
    }
    return items;
  }
  const record = recordOf(raw);
  if (record !== null) {
    for (const [dimension, entry] of Object.entries(record)) {
      const item = replyItemOf(dimension, entry);
      if (item !== null) items.push(item);
    }
  }
  return items;
}

/** One wire reply (or a plain string) as an {@link AuthorReply}. */
function replyOf(value: unknown, index: number): AuthorReply | null {
  if (typeof value === "string") {
    const text = textOf(value);
    if (text === null) return null;
    return {
      id: `reply-${index}`,
      author: null,
      version: null,
      text,
      items: [],
      createdAt: null,
    };
  }

  const record = recordOf(value);
  if (record === null) return null;

  const items = replyItemsOf(record.items ?? record.replies);
  const text = firstText(
    record.text,
    record.reply,
    record.body,
    record.content,
    record.response,
  );
  if (items.length === 0 && text === null) return null;

  const id =
    firstText(record.reply_cid, record.replyCid, record.response_cid, record.cid, record.id) ??
    `reply-${index}`;
  const authorName = firstText(record.author_name, record.authorName, record.author);
  const author =
    authorName !== null && !looksLikeIdentifier(authorName) ? authorName : null;

  return {
    id,
    author,
    version: firstNumber(record.version, record.author_version, record.authorVersion),
    text,
    items,
    createdAt: firstText(record.created_at, record.createdAt, record.created, record.date),
  };
}

/** Every reply shape an endpoint might attach to a review. */
function repliesOf(record: Record<string, unknown>): AuthorReply[] {
  const groups: unknown[] = [];
  for (const key of [
    "responses",
    "response",
    "author_responses",
    "authorResponses",
    "author_replies",
    "authorReplies",
    "replies",
    "reply",
  ]) {
    if (key in record) groups.push(record[key]);
  }

  const replies: AuthorReply[] = [];
  const seen = new Set<string>();

  const absorb = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) absorb(entry);
      return;
    }
    const asRecord = recordOf(value);
    if (asRecord !== null) {
      const single =
        "text" in asRecord ||
        "reply" in asRecord ||
        "body" in asRecord ||
        "content" in asRecord ||
        "items" in asRecord ||
        "replies" in asRecord ||
        "reply_cid" in asRecord ||
        "replyCid" in asRecord ||
        "response_cid" in asRecord ||
        "responseCid" in asRecord ||
        "review_cid" in asRecord ||
        "reviewCid" in asRecord ||
        "cid" in asRecord ||
        "id" in asRecord ||
        "created" in asRecord ||
        "created_at" in asRecord ||
        "createdAt" in asRecord ||
        "author" in asRecord ||
        "author_name" in asRecord ||
        "authorName" in asRecord ||
        "version" in asRecord;
      if (!single) {
        // A map of dimension → answer is one point-by-point reply.
        const reply = replyOf({ items: asRecord }, replies.length);
        if (reply !== null) replyItemPush(reply);
        return;
      }
    }
    const reply = replyOf(value, replies.length);
    if (reply !== null) replyItemPush(reply);
  };

  const replyItemPush = (reply: AuthorReply): void => {
    const fingerprint = `${reply.id}|${reply.text ?? ""}|${reply.items
      .map((item) => `${item.dimension ?? ""}:${item.text}`)
      .join("|")}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    replies.push(reply);
  };

  for (const group of groups) absorb(group);
  return replies;
}

/** The report body, when it is served as text or as an object with text. */
function reportOf(value: unknown): string | null {
  const direct = textOf(value);
  if (direct !== null) return direct;
  const record = recordOf(value);
  if (record === null) return null;
  return firstText(record.text, record.body, record.content, record.markdown);
}

/** Every earlier revision a reviewer's review carries, oldest first. */
function historyOf(value: unknown): ReviewRevision[] {
  if (!Array.isArray(value)) return [];
  const revisions: ReviewRevision[] = [];
  value.forEach((entry, index) => {
    const record = recordOf(entry);
    if (record === null) return;
    const formalCid = firstText(
      record.formal_cid,
      record.formalCid,
      record.reveal_cid,
      record.revealCid,
      record.id,
    );
    const recommendation = firstText(
      record.recommendation,
      record.verdict,
      record.recommendation_label,
    );
    revisions.push({
      key: formalCid ?? `revision-${index}`,
      formalCid,
      version: firstNumber(record.version, record.n),
      recommendation,
      recommendationLabel: recommendationLabel(recommendation),
      revealedAt: firstText(record.revealed_at, record.revealedAt),
      report: reportOf(record.report),
      scores: parseScores(record.scores ?? record.rubric),
    });
  });
  return revisions;
}

/** One wire review as a {@link Review}. */
function reviewOf(value: unknown, index: number): Review {
  const record = recordOf(value) ?? {};

  const servedLabel = firstText(
    record.label,
    record.reviewer_label,
    record.reviewerLabel,
    record.reviewer,
  );
  const label =
    servedLabel !== null && !looksLikeIdentifier(servedLabel)
      ? servedLabel
      : reviewerLabelAt(index);

  const recommendation = firstText(
    record.recommendation,
    record.verdict,
    record.recommendation_label,
  );
  const reviewCid = firstText(
    record.review_cid,
    record.reviewCid,
    record.cid,
    record.id,
  );

  return {
    key: reviewCid ?? `review-${index}`,
    reviewCid,
    label,
    recommendation,
    recommendationLabel: recommendationLabel(recommendation),
    confidenceLabel: confidenceLabel(record.confidence),
    scores: parseScores(record.scores ?? record.rubric),
    report: reportOf(record.report),
    replies: repliesOf(record),
    history: historyOf(record.history),
    committedAt: firstText(
      record.committed_at,
      record.committedAt,
      record.revealed_at,
      record.revealedAt,
      record.created,
    ),
    revealedAt: firstText(record.revealed_at, record.revealedAt),
    version: firstNumber(record.version, record.n),
    signedBy: firstText(record.signed_by, record.signedBy),
    formalCid: firstText(
      record.formal_cid,
      record.formalCid,
      record.reveal_cid,
      record.revealCid,
      record.id,
    ),
  };
}

/** How many of `reviews` are committed on `version` (not carried from earlier). */
function committedCount(reviews: readonly Review[], version: number | null): number {
  if (version === null) return reviews.length;
  return reviews.filter(
    (review) => review.version === null || review.version === version,
  ).length;
}

/**
 * Parse a `GET /papers/{id}/reviews` payload. Never throws.
 *
 * A payload that is not an object (or is missing `reviews`) reads as a paper
 * with no reviews, not as a failure: a half-built node is a calm empty state.
 *
 * `count` is the number of reviews committed on the listed version. A later
 * version's listing also carries revealed reviews of earlier versions, which
 * are shown but are not commits on this one (and do not count toward its
 * gate), so they never inflate the count the header and the margin use.
 */
export function parseReviews(raw: unknown): ReviewsData {
  const root = Array.isArray(raw) ? { reviews: raw } : (recordOf(raw) ?? {});
  const list = Array.isArray(root.reviews) ? root.reviews : [];
  const reviews = list.map((entry, index) => reviewOf(entry, index));

  const paper = firstText(root.paper, root.shortId, root.short_id);
  const shortId = firstText(root.shortId, root.short_id, root.paper);
  const versionCid = firstText(root.versionCid, root.version_cid);
  const version = firstNumber(root.version, root.n);

  const servedGate = booleanOf(root.gate_open ?? root.gateOpen);
  const gateOpen =
    servedGate ?? reviews.some((review) => review.report !== null);

  return {
    paper,
    shortId,
    versionCid,
    version,
    gateOpen,
    reviews,
    count: firstNumber(root.count) ?? committedCount(reviews, version),
  };
}

/** A paper with no reviews, for a route whose read says there are none. */
export function emptyReviews(paperId: string): ReviewsData {
  const id = paperId.trim().replace(/^sch:/i, "");
  return {
    paper: id,
    shortId: `sch:${id}`,
    versionCid: null,
    version: null,
    gateOpen: false,
    reviews: [],
    count: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

/** The median of a list of numbers, or `null` for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

/**
 * The median score per rubric dimension across `reviews`.
 *
 * Only dimensions with at least one served score appear, in canonical order;
 * an even number of reviews may give a half point (3.5 of 5), which is shown
 * as such rather than rounded away. Unrevealed reviews simply do not
 * contribute, so the bar always reflects what is actually on screen.
 */
export function dimensionMedians(reviews: readonly Review[]): DimensionMedian[] {
  const values = new Map<string, number[]>();

  for (const review of reviews) {
    for (const score of review.scores) {
      const list = values.get(score.dimension);
      if (list === undefined) values.set(score.dimension, [score.score]);
      else list.push(score.score);
    }
  }

  const ordered: DimensionMedian[] = [];
  for (const dimension of DIMENSION_ORDER) {
    const list = values.get(dimension);
    if (list === undefined) continue;
    const middle = median(list);
    if (middle === null) continue;
    ordered.push({
      dimension,
      label: dimensionLabel(dimension),
      median: middle,
      count: list.length,
    });
    values.delete(dimension);
  }
  for (const [dimension, list] of values) {
    const middle = median(list);
    if (middle === null) continue;
    ordered.push({
      dimension,
      label: dimensionLabel(dimension),
      median: middle,
      count: list.length,
    });
  }
  return ordered;
}

/** The fraction of the scale a score fills, for the summary meter's width. */
export function scoreFraction(score: number): number {
  const clamped = Math.min(SCORE_MAX, Math.max(0, score));
  return clamped / SCORE_MAX;
}
