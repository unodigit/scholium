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
 * The sealed card is where the review is opened. It offers **Reveal review**,
 * which checks the reveal gate, then signs the `review.formal` with the same
 * per-paper key and posts it to `POST /v1/reviews/reveal`; the content the
 * reveal needs was kept on the device at commit time, so returning to the
 * page shows the sealed card rather than a second blank form.
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
  type ReactNode,
  type Ref,
} from "react";

import { useSignedIn } from "../../components/nav/session";
import { api, tokenStore } from "../../lib/api";
import { formatDate, toDate } from "../ui-kit/format-date";
import { Icon } from "../ui-kit/icons";
import type { ActionFailure } from "./action-errors";
import { appendCitation, describeCitation, type Citation } from "./citation";
import {
  SEALED_HEADLINE,
  commitReview,
  describeCommitError,
  revealDateFor,
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
import { reviewHref, reviewSignInHref } from "./links";
import {
  loadOwnReviewListing,
  ownReviewOf,
  type LoadMyReviews,
  type LoadOwnReview,
  type MyReview,
  type OwnReviewListing,
} from "./my-reviews";
import {
  REVEAL_GATE_CLOSED_NOTE,
  REVEAL_LABEL,
  REVEAL_SIGNING_NOTE,
  REVEALED_HEADLINE,
  REVEALED_TEXT,
  describeRevealError,
  describeUpdateError,
  loadRevealGate,
  revealReview,
  updateReview,
  type LoadRevealGate,
  type RevealGate,
  type RevealReview,
  type ReviewRevealResult,
  type UpdateReview,
  type UpdateReviewResult,
} from "./reveal";
import { ReportMarkdown } from "./report-markdown";
import {
  ReviewSessionProvider,
  useReviewSession,
  type ReviewSession,
} from "./review-session";
import {
  forgetSealedReview,
  loadSealedReview,
  saveSealedReview,
  sealedReviewFromCommit,
  type SealedReview,
} from "./sealed-review";
import { REVIEW_SECRET_LOCAL_NOTE, loadReviewKey, saveReviewKey } from "./review-key";
import {
  DownloadReviewKey,
  ImportReviewKey,
  type KeyFileSeams,
} from "./review-key-panels";
import { useMyReviews } from "./use-my-reviews";
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

/** The button that updates a revealed review (REV-5). */
export const UPDATE_LABEL = "Update review";

/**
 * The card a reviewer sees, in place of a blank form, when the API holds a
 * sealed review of theirs for this paper and this browser holds nothing to
 * reveal it with (a fresh browser, or another device).
 */
export const SEALED_ELSEWHERE_HEADLINE = "You already have a sealed review of this paper";

/** What it says: why there is no Commit form, and what to do instead. */
export const SEALED_ELSEWHERE_TEXT =
  "You committed a review of this paper, and it is still sealed. The secret that reveals it is kept only in the browser you committed it from, and this browser does not have it. A paper takes one review from each reviewer, so a new review cannot be committed here.";

/** What it offers. */
export const SEALED_ELSEWHERE_IMPORT_TEXT =
  "Import the review key file you downloaded in that browser to reveal your review from here.";

/**
 * The card a reviewer sees, in place of the blank form, when the API holds a
 * revealed review of theirs for this paper (from any browser).
 */
export const OWN_REVIEW_HEADLINE = "You already reviewed this paper";

/** What it says: the review below is theirs, and a second one is impossible. */
export const OWN_REVIEW_TEXT =
  "Your revealed review is shown below, read-only. A paper takes one review from each reviewer, so a second review cannot be committed here.";

/** Said when the revealed review's written report is still sealed (REV-4). */
export const OWN_REVIEW_REPORT_SEALED_TEXT =
  "Your written report is sealed until two reviews are committed on this version, or 21 days after the first.";

/**
 * Said under the button so the reviewer knows what committing does. (A reviewer
 * who chose to sign with their name is told so as well: `COMMIT_NOTE_SIGNED`.)
 */
export const COMMIT_NOTE = COMMIT_NOTE_ANONYMOUS;

/**
 * Said under **Update review** instead. An update is not sealed: it is
 * published when it is posted, so the commit form's "seals it until it is
 * revealed" would be false. The scores and recommendation are public at once;
 * the written report follows the target version's gate (REV-4), exactly as the
 * confirmation says after the update is accepted.
 */
export const UPDATE_NOTE =
  "An update is published immediately: your scores and recommendation are public at once. Your written report follows the version's gate, unsealing once 2 reviews are committed on this version, or 21 days after the first commit.";

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
  /** The earlier `review.formal` this review revises, when updating (REV-5). */
  prev?: string;
  /** The paper's newest listed version, for "Update for v{latest}". */
  latestVersion?: number | null;
  /** Replace the update flow (derive key, sign and send), for tests. */
  update?: UpdateReview;
  /** Replace the update flow (alias), for tests. */
  revise?: UpdateReview;
  /** Replace the reveal flow (derive key, sign and send), for tests. */
  reveal?: RevealReview;
  /** Replace the reveal-gate read, for tests. */
  loadGate?: LoadRevealGate;
  /** Replace the read of the reviewer's own reviews (the dashboard), for tests. */
  loadOwnReviews?: LoadMyReviews;
  /** Replace the read of the reviewer's own review from the public listing. */
  loadOwnReview?: LoadOwnReview;
  /** Replace what writes and reads the encrypted review key file, for tests. */
  keyFile?: KeyFileSeams;
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
  prev,
  latestVersion,
  update: updateOverride,
  revise: reviseOverride,
  reveal: revealOverride,
  loadGate,
  loadOwnReviews,
  loadOwnReview,
  keyFile,
  session,
}: ReviewFormProps & { session: ReviewSession }) {
  const uid = useId();
  const signedIn = useSignedIn(signedInOverride);
  const signInHref = signInHrefOverride ?? reviewSignInHref(paperId);
  const {
    signed,
    attachForm,
    setPhase: reportPhase,
    setFormActive: reportFormActive,
    setOwnReviewState: reportOwnReviewState,
  } = session;
  // An update page (`?prev=…`) is only reached from a revealed review, so its
  // state is known before this browser's storage is consulted.
  const isUpdate = typeof prev === "string" && prev.trim() !== "";

  const [draft, setDraft] = useState<ReviewDraft>(
    () => initialDraft ?? emptyDraft(),
  );
  // A dimension's problems are shown once the reviewer has left its
  // justification box, not while they are still typing in it. A commit attempt
  // shows every problem at once.
  const [visited, setVisited] = useState<Partial<Record<DimensionId, true>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<Phase>("editing");
  const [sealed, setSealed] = useState<SealedReview | null>(null);
  // The review a successful update now stands on, shown read-only.
  const [updated, setUpdated] = useState<UpdateReviewResult | null>(null);
  const [error, setError] = useState<CommitFailure | null>(null);

  // Whether this browser's own storage has been asked for a sealed review yet:
  // the API is asked only after that read has answered.
  const [localChecked, setLocalChecked] = useState(false);

  // Cite in review: the box a quote goes into, and the last quote placed.
  const citeTarget = useRef<DimensionId>(RUBRIC_DIMENSIONS[0].id);
  const boxes = useRef<Partial<Record<DimensionId, HTMLTextAreaElement | null>>>({});
  const [cited, setCited] = useState<CitedState | null>(null);

  // Tell the rest of the page where the form is, so the choice to sign and
  // the paper's Cite in review stop changing the draft once it is being signed.
  // An accepted update is published, so the choice stays fixed for good: the
  // form's own phase goes back to "editing" after it, the page's must not.
  const reportedPhase: Phase = updated !== null ? "sealed" : phase;
  useEffect(() => {
    reportPhase(reportedPhase);
  }, [reportedPhase, reportPhase]);
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

  // A reviewer who comes back to the page still has the review they sealed:
  // what the commit left on the device is what the reveal needs. Read after
  // mount so the server's blank form and the browser's first render agree.
  useEffect(() => {
    if (sealed !== null || paperId.trim() === "") return;
    setLocalChecked(true);
    // An update page is only reached from a revealed review. A sealed copy
    // left on the device is from before the reveal and cannot be opened again.
    if (isUpdate) return;
    const stored = loadSealedReview(paperId);
    if (stored === null) return;
    setSealed(stored);
    setPhase("sealed");
  }, [paperId, sealed, isUpdate]);

  // This browser holds nothing to reveal a review with, but the API may say
  // the signed-in reviewer has one sealed: a fresh browser, or another device.
  // A commit would be refused (one review per reviewer and paper), so the form
  // gives way to a card that says so. Asked once this browser's storage has
  // been read, even when it held a sealed copy: the server's answer decides
  // whether that copy is still sealed, so a reveal elsewhere cannot leave the
  // page stuck on a sealed card whose Reveal is refused. A form with no paper,
  // one that updates a review and one with nobody signed in have nothing to ask.
  const mayAskApi =
    loadOwnReviews !== undefined || (signedIn && tokenStore.isAuthenticated);
  const own = useMyReviews(
    mayAskApi && localChecked && !isUpdate && paperId.trim() !== "",
    paperId,
    loadOwnReviews,
  );
  const ownReview =
    own.status === "ready" ? ownReviewOf(own.reviews, paperId) : null;
  const sealedElsewhere = ownReview !== null && ownReview.sealed;
  const revealedElsewhere = ownReview !== null && ownReview.revealed;

  // The API is authoritative. A review the server reports revealed can never
  // be opened again, so an imported or stored sealed copy is stale: forget it
  // rather than letting it put the page back into the sealed/Reveal state.
  useEffect(() => {
    if (!revealedElsewhere || phase === "signing") return;
    forgetSealedReview(paperId);
    setSealed(null);
    setPhase("editing");
  }, [revealedElsewhere, paperId, phase]);

  // The editable form is the page's one surface that uses the identity choice
  // and can cite; a card in its place must not offer either.
  // An update page is only reached from a review the server already revealed
  // (its ``prev``), so nothing on it can be waiting for a reveal.
  const sealedCard =
    phase === "sealed" && sealed !== null && !revealedElsewhere && !isUpdate;
  const revealedCard =
    revealedElsewhere && ownReview !== null && phase !== "signing";
  const sealedElsewhereCard = sealedElsewhere && phase === "editing";
  const formActive =
    updated === null && !sealedCard && !revealedCard && !sealedElsewhereCard;
  // How the conflict check should word its clear result. An update page is
  // reached from a review the server already revealed.
  const ownReviewState = revealedElsewhere || isUpdate
    ? "revealed"
    : sealedElsewhere || sealed !== null
      ? "sealed"
      : null;

  useEffect(() => {
    reportFormActive(formActive);
  }, [formActive, reportFormActive]);
  useEffect(() => () => reportFormActive(true), [reportFormActive]);
  useEffect(() => {
    reportOwnReviewState(ownReviewState);
  }, [ownReviewState, reportOwnReviewState]);
  useEffect(() => () => reportOwnReviewState(null), [reportOwnReviewState]);

  // When updating a revealed review, prefill the form with its current rubric.
  useEffect(() => {
    if (initialDraft !== undefined) return;
    if (typeof prev !== "string" || prev.trim() === "") return;
    let cancelled = false;
    api
      .get<unknown>(`/records/${encodeURIComponent(prev.trim())}`, { auth: false, cache: "no-store" })
      .then((payload) => {
        if (cancelled) return;
        const body =
          typeof payload === "object" && payload !== null
            ? ((payload as { body?: unknown }).body ?? payload)
            : null;
        if (typeof body !== "object" || body === null) return;
        const record = body as Record<string, unknown>;
        const scores = record.scores;
        const next: any = emptyDraft();
        if (scores && typeof scores === "object") {
          for (const { id } of RUBRIC_DIMENSIONS) {
            const entry = (scores as Record<string, unknown>)[id];
            if (entry && typeof entry === "object") {
              const e = entry as Record<string, unknown>;
              const score =
                typeof e.score === "number" ? e.score : Number(e.score);
              const justification =
                typeof e.justification === "string" ? e.justification : "";
              if (Number.isFinite(score)) {
                next.scores[id] = { score: score as never, justification };
              }
            }
          }
        }
        if (typeof record.confidence === "string") {
          next.confidence = record.confidence as never;
        } else if (typeof record.confidence === "number") {
          // map integer to nearest label
          const n = record.confidence as number;
          next.confidence = (n <= 2 ? "low" : n === 3 ? "medium" : "high") as never;
        }
        if (typeof record.recommendation === "string") {
          next.recommendation = record.recommendation as never;
        }
        if (typeof record.aiAssisted === "boolean") {
          next.aiAssisted = record.aiAssisted;
        }
        if (typeof record.signed === "boolean") {
          next.signed = record.signed;
        }
        if (typeof record.report === "string") {
          next.report = record.report;
        }
        setDraft(next);
      })
      .catch(() => {
        // Prefill is a convenience; the form still works blank.
      });
    return () => {
      cancelled = true;
    };
  }, [prev, initialDraft]);

  const problems = validateDraft(draft);
  const progress = progressOf(draft);
  const complete = isComplete(problems);

  if (sealedCard && sealed !== null) {
    return (
      <SealedNotice
        sealed={sealed}
        signed={signed}
        reveal={revealOverride}
        loadGate={loadGate}
        signInHref={signInHref}
        keyFile={keyFile}
        onImported={(imported) => {
          setSealed(imported);
          setPhase("sealed");
        }}
      />
    );
  }

  // The server's revealed status outranks anything left on this device. Only a
  // commit being signed is not interrupted.
  if (revealedCard && ownReview !== null) {
    // The reviewer already has a review of this paper and the API has it
    // revealed: a blank Commit form is a dead end (one review per paper), so
    // what they wrote is shown read-only instead.
    return (
      <RevealedElsewhereNotice
        review={ownReview}
        paperId={paperId}
        latestVersion={latestVersion ?? null}
        keyFile={keyFile}
        loadOwnReview={loadOwnReview}
      />
    );
  }

  if (sealedElsewhereCard) {
    return (
      <SealedElsewhereNotice
        paperId={paperId}
        version={ownReview?.version ?? null}
        keyFile={keyFile}
        onImported={(imported) => {
          setSealed(imported);
          setPhase("sealed");
        }}
      />
    );
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
      const stored = sealedReviewFromCommit(result, paperId);
      // Nothing is kept for a form used without a paper id (there is no page
      // to return to); the sealed card still offers the reveal.
      if (paperId.trim() !== "") saveSealedReview(stored);
      if (result.key !== undefined) await saveReviewKey(paperId, result.key);
      setSealed(stored);
      setPhase("sealed");
    } catch (thrown) {
      setError(describeCommitError(thrown));
      setPhase("editing");
    }
  };

  const update = async (): Promise<void> => {
    if (phase === "signing") return;

    setSubmitted(true);
    if (!complete) {
      setError(null);
      return;
    }
    if (!signedIn && updateOverride === undefined && commitOverride === undefined) {
      setError({
        message: "Sign in to update your review. Nothing was sent.",
        signIn: true,
      });
      return;
    }

    setError(null);
    setPhase("signing");
    try {
      const result = await ((updateOverride ?? reviseOverride) ?? updateReview)({
        paperId,
        versionCid,
        prev: prev ?? "",
        draft: { ...draft, signed },
      });
      setUpdated(result);
      setPhase("editing");
    } catch (thrown) {
      setError(describeUpdateError(thrown));
      setPhase("editing");
    }
  };

  // A successful update becomes a read-only confirmation of what is now public,
  // so the same update cannot be submitted twice.
  if (updated !== null) {
    return (
      <UpdateConfirmed
        result={updated}
        paperId={paperId}
        loadGate={loadGate}
      />
    );
  }

  return (
    <>
      {/* A reviewer with a review key file from another browser can bring it
          here before writing anything. An update is not signed with the review
          key, and its review is already revealed, so the update form offers
          no import: importing there used to put the page back on a sealed
          card whose Reveal the node refuses. */}
      {isUpdate ? null : (
        <ImportReviewKey
          paperId={paperId}
          seams={keyFile}
          onImported={(imported) => {
            setSealed(imported);
            setPhase("sealed");
          }}
        />
      )}
      <form
        className="rf-form"
      aria-labelledby={`${uid}-title`}
      noValidate
      onSubmit={(event) => {
        // Committing is the only submit; Enter in a field must not reload.
        event.preventDefault();
        if (isUpdate) void update();
        else void commit();
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

      <fieldset className="rf-group">
        <legend className="rf-group-legend">Written report</legend>
        <div className="rf-field">
          <label className="rf-field-label" htmlFor={`${uid}-report`}>
            Written report <span className="rf-optional">(optional)</span>
          </label>
          <p className="rf-field-hint" id={`${uid}-report-hint`}>
            Markdown is allowed. Your report is published with the rubric when
            the review is revealed; leave it blank if the rubric says everything.
          </p>
          <textarea
            id={`${uid}-report`}
            className="rf-textarea rf-report-textarea"
            rows={6}
            value={draft.report}
            aria-describedby={`${uid}-report-hint`}
            onChange={(event) => {
              const report = event.currentTarget.value;
              setDraft((current) => ({ ...current, report }));
            }}
          />
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
          {isUpdate
            ? UPDATE_NOTE
            : signed
              ? COMMIT_NOTE_SIGNED
              : COMMIT_NOTE}
        </p>
        <button
          type="submit"
          className="rf-button"
          disabled={phase === "signing"}
          aria-busy={phase === "signing" ? true : undefined}
        >
          {phase === "signing"
            ? "Signing…"
            : isUpdate
              ? UPDATE_LABEL
              : COMMIT_LABEL}
        </button>
      </div>
    </form>
    </>
  );
}

/** One rubric row of the read-only confirmation. */
interface UpdatedScore {
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly justification: string | null;
}

/** The rubric of the just-updated review, in the form's canonical order. */
function updatedScores(raw: unknown): UpdatedScore[] {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rows: UpdatedScore[] = [];
  for (const { id, label } of RUBRIC_DIMENSIONS) {
    const entry = record[id];
    if (typeof entry !== "object" || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    const score =
      typeof fields.score === "number" ? fields.score : Number(fields.score);
    if (!Number.isFinite(score)) continue;
    const justification =
      typeof fields.justification === "string" &&
      fields.justification.trim() !== ""
        ? fields.justification.trim()
        : null;
    rows.push({ id, label, score, justification });
  }
  return rows;
}

/** The reader-facing recommendation of the just-updated review. */
function updatedRecommendation(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "No recommendation";
  const known = RECOMMENDATION_OPTIONS.find((option) => option.value === text);
  return known?.label ?? text;
}

/**
 * The day this update's written report unseals on the clock alone, as the
 * design writes dates (`22 Dec 2026`), or `null` when the record carries no
 * usable date.
 *
 * An update is revealed at once, but REV-4 withholds its written report until
 * the target version's gate opens: two reviews committed on it, or 21 days
 * after the first. The record's own `created` is the commit date the reviewer
 * brings, and the client's commit flow uses the same window.
 */
function updatedReportUnsealDate(result: UpdateReviewResult): string | null {
  // `created` can arrive without a zone designator — the API's UTC
  // convention — so the shared `toDate` names the zone before the 21-day
  // window is added to the instant. `revealDateFor` then works on a
  // zone-carrying ISO string it cannot misread.
  const created = toDate(result.record.created);
  if (created === null) return null;
  return formatDate(revealDateFor(created.toISOString()));
}

/**
 * What replaces the form once an update is accepted.
 *
 * The reviewer sees the review they now stand on, read-only, rather than a
 * still-editable form that looks as though nothing happened. There is nothing
 * left to submit, so a second click (and a confusing `409`) is impossible.
 *
 * The copy must not overstate publication: the scores and recommendation are
 * public now, but the written report stays sealed until the version's gate
 * opens (REV-4). The gate is read *after* the update is posted, so an update
 * that was the second review counted on the version says the report is public
 * rather than promising a wait that has already ended.
 */
export function UpdateConfirmed({
  result,
  paperId,
  loadGate = loadRevealGate,
  gate: givenGate,
}: {
  result: UpdateReviewResult;
  /** The paper whose gate is read; without it the state is unknown. */
  paperId?: string;
  /** Replace the gate read, for tests. */
  loadGate?: LoadRevealGate;
  /** A gate state already read, for tests or a host. */
  gate?: RevealGate | null;
}) {
  const body = result.body;
  const scores = updatedScores(body.scores);
  const report =
    typeof body.report === "string" && body.report.trim() !== ""
      ? body.report.trim()
      : null;
  const unsealDate = updatedReportUnsealDate(result);

  const [readGate, setReadGate] = useState<RevealGate | null>(null);
  useEffect(() => {
    if (givenGate !== undefined) return;
    if (paperId === undefined || paperId.trim() === "") return;
    let cancelled = false;
    const target = typeof body.target === "string" ? body.target : "";
    loadGate(paperId).then(
      (answer) => {
        if (!cancelled) {
          setReadGate(gateApplies(answer, target) ? answer : null);
        }
      },
      () => {
        if (!cancelled) setReadGate(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [givenGate, paperId, loadGate, body.target]);

  const gate = givenGate !== undefined ? givenGate : readGate;
  // Only a positive read says the report is public: an unread gate keeps the
  // design's promise instead of inventing a state.
  const reportPublic = gate !== null && gate.open;

  return (
    <section
      className="rf-sealed rf-updated"
      role="status"
      aria-live="polite"
      data-state="updated"
    >
      <h2 className="rf-form-title">Your review is updated</h2>
      <p className="rf-sealed-text">
        Your scores and recommendation are public now.
        {report !== null
          ? reportPublic
            ? " Your written report is public now."
            : ` Your written report unseals once 2 reviews are committed on this version, or ${
                unsealDate !== null
                  ? `on ${unsealDate}`
                  : "21 days after the first commit"
              }.`
          : ""}
      </p>
      <p className="rf-updated__recommendation">
        {updatedRecommendation(body.recommendation)}
      </p>

      <dl className="rf-updated__rubric">
        {scores.map((row) => (
          <div className="rf-updated__row" key={row.id}>
            <dt className="rf-updated__label">{row.label}</dt>
            <dd className="rf-updated__reading">
              {row.score} of {SCORE_MAX}
            </dd>
            {row.justification !== null ? (
              <dd className="rf-updated__justification">{row.justification}</dd>
            ) : null}
          </div>
        ))}
      </dl>

      {report !== null ? (
        <section className="rf-updated__report">
          <h3 className="rf-updated__report-title">Written report</h3>
          <ReportMarkdown source={report} className="rf-updated__report-body" />
        </section>
      ) : null}

      <p className="rf-sealed-id mono-id">Review {result.revealCid}</p>
    </section>
  );
}

/**
 * What replaces the form once the commit is accepted, and what reveals it.
 *
 * A review that will carry its reviewer's name (`signed`) says so; an
 * anonymous one says nothing more. The card always offers **Reveal review**:
 * pressing it reads whether the gate is open (two reviews on the version, or
 * 21 days after the first), then signs the `review.formal` with the same
 * per-paper key and posts it to `POST /v1/reviews/reveal`. A shut gate is said
 * in words and signs nothing, so no passkey prompt is spent on a reveal the
 * API would refuse.
 */
export function SealedNotice({
  sealed,
  signed = false,
  reveal = revealReview,
  loadGate = loadRevealGate,
  signInHref = "/signin",
  keyFile,
  onImported,
}: {
  sealed: SealedReview;
  signed?: boolean;
  /** Replace the reveal flow, for tests. */
  reveal?: RevealReview;
  /** Replace the gate read, for tests. */
  loadGate?: LoadRevealGate;
  /** Where "Sign in" goes when a session has ended. */
  signInHref?: string;
  /** Replace what writes and reads the encrypted review key file, for tests. */
  keyFile?: KeyFileSeams;
  /** Called when a review key file is imported. */
  onImported?: (sealed: SealedReview) => void;
}) {
  // The shared date format, in the reader's zone (`toDate` reads a zone-less
  // API timestamp as UTC): the same instant names the same day here as on the
  // paper page. The raw string is the fallback for a value that is not a date.
  const revealDate = formatDate(sealed.revealAt) ?? sealed.revealAt;
  const named = signed || sealed.revealBody.signed === true;

  // Whether this browser holds the review key. Read after mount: it is kept in
  // IndexedDB, and there is nothing to show until it has answered.
  const [secret, setSecret] = useState<"unknown" | "present" | "absent">("unknown");
  useEffect(() => {
    let cancelled = false;
    setSecret("unknown");
    void loadReviewKey(sealed.paperId).then((key) => {
      if (!cancelled) setSecret(key !== null ? "present" : "absent");
    });
    return () => {
      cancelled = true;
    };
  }, [sealed]);

  const [phase, setPhase] = useState<"sealed" | "checking" | "revealing" | "revealed">(
    "sealed",
  );
  const [revealed, setRevealed] = useState<ReviewRevealResult | null>(null);
  // The gate as the public listing reports it, read once on mount so the card
  // describes the actual state instead of always promising a second review.
  const [gate, setGate] = useState<RevealGate | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  // Said when the gate is shut: information, not an error.
  const [note, setNote] = useState<string | null>(null);
  // One action at a time, even across the render a click has not reached yet.
  const working = useRef(false);

  useEffect(() => {
    if (sealed.paperId.trim() === "") return;
    let cancelled = false;
    loadGate(sealed.paperId).then(
      (answer) => {
        if (!cancelled) {
          setGate(gateApplies(answer, sealed.versionCid) ? answer : null);
        }
      },
      () => {
        if (!cancelled) setGate(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sealed, loadGate]);

  const open = async (): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setFailure(null);
    setNote(null);

    try {
      // Ask whether the gate is open first: a reveal the API would refuse is
      // not worth a passkey prompt. An unreadable gate is not a refusal — the
      // API is the gate, and it answers when the record is signed and sent.
      if (sealed.paperId.trim() !== "") {
        setPhase("checking");
        let gate: RevealGate | null = null;
        try {
          gate = await loadGate(sealed.paperId);
        } catch {
          gate = null;
        }
        if (gate !== null && gateApplies(gate, sealed.versionCid) && !gate.open) {
          setNote(REVEAL_GATE_CLOSED_NOTE);
          setPhase("sealed");
          return;
        }
      }

      setPhase("revealing");
      const result = await reveal({ sealed });
      // The locally kept copy has done its job; do not offer the review again.
      forgetSealedReview(sealed.paperId);
      setRevealed(result);
      setPhase("revealed");
    } catch (thrown) {
      setFailure(describeRevealError(thrown));
      setPhase("sealed");
    } finally {
      working.current = false;
    }
  };

  if (phase === "revealed" && revealed !== null) {
    return (
      <section
        className="rf-sealed"
        role="status"
        aria-live="polite"
        data-state="revealed"
      >
        <h2 className="rf-form-title">{REVEALED_HEADLINE}</h2>
        <p className="rf-sealed-text">{REVEALED_TEXT}</p>
        <p className="rf-sealed-id mono-id">Review {revealed.reviewCid}</p>
      </section>
    );
  }

  const busy = phase === "checking" || phase === "revealing";

  return (
    <section
      className="rf-sealed"
      role="status"
      aria-live="polite"
      data-state="sealed"
    >
      <h2 className="rf-form-title">{SEALED_HEADLINE}</h2>
      <p className="rf-sealed-text">
        {sealedGateText(gate, revealDate, sealed.revealAt)}
      </p>
      {named ? <p className="rf-sealed-text">{SEALED_SIGNED_NOTE}</p> : null}
      <p className="rf-sealed-id mono-id">Review {sealed.reviewCid}</p>

      <div className="rf-reveal">
        <p className="rf-commit-note">{REVEAL_SIGNING_NOTE}</p>
        <button
          type="button"
          className="rf-button"
          disabled={busy}
          aria-busy={busy ? true : undefined}
          onClick={() => void open()}
        >
          {phase === "checking"
            ? "Checking…"
            : phase === "revealing"
              ? "Revealing…"
              : REVEAL_LABEL}
        </button>
      </div>

      <p className="rf-sealed-text">
        {REVIEW_SECRET_LOCAL_NOTE} It is kept encrypted, and the review key file you
        can download needs a passphrase you choose.
      </p>

      {secret === "present" ? <DownloadReviewKey sealed={sealed} seams={keyFile} /> : null}
      {secret === "absent" ? (
        <>
          <p className="rf-sealed-text">
            This sealed review exists, but no local secret is available on this
            device.
          </p>
          <ImportReviewKey
            paperId={sealed.paperId}
            seams={keyFile}
            onImported={(imported) => onImported?.(imported)}
          />
        </>
      ) : null}

      {note !== null ? <p className="rf-sealed-text">{note}</p> : null}

      {failure !== null ? (
        <p className="rf-error rf-commit-error" role="alert">
          <Icon name="alert" className="rf-error-icon" />
          <span>
            {failure.message}
            {failure.signIn ? (
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
    </section>
  );
}

/**
 * Said when the reveal gate is already open: the only thing left is to reveal.
 */
export const REVEAL_GATE_OPEN_NOTE =
  "The reveal gate is open for this version. Reveal your review to publish its rubric and report.";

/**
 * What the sealed card says about the gate.
 *
 * A gate that could not be read keeps the design's promise (a second review,
 * or 21 days) rather than inventing a state. A gate that was read names how
 * many reviews are committed, what is still needed, and the fallback date;
 * once it is open, it says so instead of still asking for a second review.
 */
function sealedGateText(
  gate: RevealGate | null,
  revealDate: string,
  revealAt: string,
): ReactNode {
  if (gate !== null && gate.open) return REVEAL_GATE_OPEN_NOTE;

  const committed = gate?.committed ?? null;
  const count =
    committed === null
      ? null
      : committed === 0
        ? "No review has been committed on this version yet."
        : committed === 1
          ? "1 review has been committed on this version so far."
          : `${committed} reviews have been committed on this version so far.`;
  const needed =
    committed === null || committed >= 2
      ? null
      : committed === 1
        ? "one more independent review"
        : "a second independent review";

  return (
    <>
      {count !== null ? `${count} ` : "It will be revealed with the others "}
      {count === null ? "when a second review is committed, or on " : null}
      {count !== null && needed !== null
        ? `Your review can be revealed once ${needed} is committed, or on `
        : null}
      {count !== null && needed === null
        ? "Your review can be revealed on "
        : null}
      <time className="rf-sealed-date" dateTime={revealAt}>
        {revealDate}
      </time>
      .
    </>
  );
}

/**
 * What a reviewer sees, in place of a blank Commit form, when the API holds a
 * sealed review of theirs for this paper and this browser holds nothing to
 * reveal it with.
 *
 * Committing would be refused (`409`: one review per reviewer and paper), and
 * the reveal needs a secret that never left the browser that committed. So the
 * card says that, and offers the one thing that helps: importing the review
 * key file from that browser.
 */
export function SealedElsewhereNotice({
  paperId,
  version = null,
  keyFile,
  onImported,
}: {
  paperId: string;
  /** The version the sealed review targets, when the dashboard names it. */
  version?: number | null;
  /** Replace what reads the encrypted review key file, for tests. */
  keyFile?: KeyFileSeams;
  /** Called when the review key file is imported. */
  onImported: (sealed: SealedReview) => void;
}) {
  return (
    <section
      className="rf-sealed"
      role="status"
      aria-live="polite"
      data-state="sealed-elsewhere"
    >
      <h2 className="rf-form-title">{SEALED_ELSEWHERE_HEADLINE}</h2>
      {version !== null ? (
        <p className="rf-sealed-meta">{`Review of v${version} · Sealed`}</p>
      ) : null}
      <p className="rf-sealed-text">{SEALED_ELSEWHERE_TEXT}</p>
      <p className="rf-sealed-text">{SEALED_ELSEWHERE_IMPORT_TEXT}</p>
      <ImportReviewKey paperId={paperId} seams={keyFile} onImported={onImported} />
    </section>
  );
}

/**
 * What a reviewer sees, in place of the blank Commit form, when the API holds
 * a *revealed* review of theirs for this paper.
 *
 * The dashboard says the review is theirs and whether it is revealed; the
 * public listing supplies what it now says (the latest update's scores and
 * report) and the `review.formal` cid an update names. Committing again is
 * refused (one review per paper), so the card shows the review read-only and
 * offers the only action left: update it against the newest version.
 *
 * The update derives the review key when it signs — from the copy this browser
 * already holds, or through a passkey — so the card never tells the reviewer to
 * import a key file. Only the sealed card, whose Reveal cannot derive a key
 * that was never kept here, offers the import.
 */
export function RevealedElsewhereNotice({
  review,
  paperId,
  latestVersion = null,
  loadOwnReview = loadOwnReviewListing,
}: {
  review: MyReview;
  paperId: string;
  /** The paper's newest listed version, for the update link. */
  latestVersion?: number | null;
  /**
   * Accepted for callers that inject key-file seams. The card no longer reads
   * or imports a key: the update derives it when it signs.
   */
  keyFile?: KeyFileSeams;
  /** Replace the read of the public listing, for tests. */
  loadOwnReview?: LoadOwnReview;
}) {
  const [detail, setDetail] = useState<OwnReviewListing | null>(null);

  useEffect(() => {
    if (paperId.trim() === "") return;
    let cancelled = false;
    loadOwnReview(paperId, review.reviewCid).then(
      (answer) => {
        if (!cancelled) setDetail(answer);
      },
      () => {
        if (!cancelled) setDetail(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paperId, review.reviewCid, loadOwnReview]);

  const scores = updatedScores(detail?.scores ?? review.scores);
  const recommendation = updatedRecommendation(
    detail?.recommendation ?? review.recommendation,
  );
  const version = detail?.version ?? review.version;
  const revealedAt = detail?.revealedAt ?? review.revealedAt;
  const formalCid = detail?.formalCid ?? null;

  const meta: string[] = [];
  if (version !== null) meta.push(`Review of v${version}`);
  // The shared date format, in the reader's zone: the API's zone-less
  // `revealed_at` is UTC, so 04:53 UTC is still the 18th in Sydney — the day
  // the reviewer revealed it, and the day the paper page names.
  meta.push(
    revealedAt !== null
      ? `Revealed ${formatDate(revealedAt) ?? revealedAt}`
      : "Revealed",
  );

  // An update's `prev` names the reviewer's newest `review.formal`; only the
  // listing serves that cid, so the link waits for it.
  const canUpdate =
    formalCid !== null &&
    version !== null &&
    latestVersion !== null &&
    version < latestVersion;

  return (
    <section
      className="rf-sealed rf-own-review"
      role="status"
      aria-live="polite"
      data-state="revealed-elsewhere"
    >
      <h2 className="rf-form-title">{OWN_REVIEW_HEADLINE}</h2>
      <p className="rf-sealed-text">{OWN_REVIEW_TEXT}</p>
      {meta.length > 0 ? <p className="rf-sealed-meta">{meta.join(" · ")}</p> : null}
      <p className="rf-updated__recommendation">{recommendation}</p>

      {scores.length > 0 ? (
        <dl className="rf-updated__rubric">
          {scores.map((row) => (
            <div className="rf-updated__row" key={row.id}>
              <dt className="rf-updated__label">{row.label}</dt>
              <dd className="rf-updated__reading">
                {row.score} of {SCORE_MAX}
              </dd>
              {row.justification !== null ? (
                <dd className="rf-updated__justification">{row.justification}</dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}

      {detail?.report !== null && detail?.report !== undefined ? (
        <section className="rf-updated__report">
          <h3 className="rf-updated__report-title">Written report</h3>
          <ReportMarkdown source={detail.report} className="rf-updated__report-body" />
        </section>
      ) : detail !== null ? (
        <p className="rf-sealed-text">
          {detail.gateOpen ? "No written report." : OWN_REVIEW_REPORT_SEALED_TEXT}
        </p>
      ) : null}

      {canUpdate && formalCid !== null && latestVersion !== null ? (
        <p className="pr-update">
          <a
            className="pr-link"
            href={`${reviewHref(paperId)}?prev=${encodeURIComponent(formalCid)}`}
          >
            {`Update for v${latestVersion}`}
          </a>
        </p>
      ) : null}

      {detail?.reviewCid !== null && detail?.reviewCid !== undefined ? (
        <p className="rf-sealed-id mono-id">Review {detail.reviewCid}</p>
      ) : null}
    </section>
  );
}

/**
 * Whether a gate answer is about the version this review sealed.
 *
 * The reviews listing answers for the paper's resolved version. If that is no
 * longer the version this review targets, the answer says nothing about it —
 * treat it as unknown and let the API decide.
 */
function gateApplies(gate: RevealGate, versionCid: string): boolean {
  return (
    gate.versionCid === null ||
    versionCid.trim() === "" ||
    gate.versionCid === versionCid
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
