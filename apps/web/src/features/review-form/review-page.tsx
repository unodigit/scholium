/**
 * `/review/[id]` — the formal review form (docs/design.md §5.5).
 *
 * A split view: the paper on the left, the conflict check and rubric form on
 * the right, with the anonymity notice above them. Under 1024 px the two
 * stack, paper first, so a phone reads the paper and then writes the review
 * (design.md §10 asks for stepped pages under 640 px; that is not built yet,
 * see the README).
 *
 * The page is given either the paper or the reason there is none, never both:
 * a review form that does not show what it reviews would invite a review of
 * the wrong paper, so a failure replaces the whole split view.
 *
 * Server-safe: the conflict check and the form are the client components.
 */

import { AnonymityNotice } from "./anonymity-notice";
import type { ConflictReport } from "./conflict";
import { ConflictCheck } from "./conflict-check";
import type { PaperFailure, ReviewPaper } from "./paper";
import { PaperPane } from "./paper-pane";
import { ReviewForm, type CommitReview } from "./review-form";
import { ReviewSessionProvider } from "./review-session";
import "./review-form.css";

/** Props both page states accept (tests and hosts may inject either half). */
interface ReviewPageExtras {
  /** A conflict report already fetched, so the first paint shows it. */
  conflict?: ConflictReport;
  /** Why a conflict fetch failed; the panel offers a retry. */
  conflictError?: string;
  /** Replace the commit flow, for tests. */
  commit?: CommitReview;
  /** The earlier review this one revises, when updating (REV-5). */
  prev?: string;
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /** Where "Sign in" goes; defaults to sign-in, then back to this review. */
  signInHref?: string;
}

export type ReviewPageProps = ReviewPageExtras &
  (
    | { paper: ReviewPaper; failure?: undefined; retryHref?: undefined }
    | {
        paper?: undefined;
        failure: PaperFailure;
        /** Where "Try again" goes; only offered for a failure worth retrying. */
        retryHref?: string;
      }
  );

export function ReviewPage(props: ReviewPageProps) {
  if (props.paper === undefined) {
    return <ReviewNotice failure={props.failure} retryHref={props.retryHref} />;
  }
  const { paper } = props;

  return (
    <div className="rf-page">
      <header className="rf-header">
        <p className="rf-kicker mono-id">scholium / review / {paper.shortId}</p>
        <h1 className="rf-title paper-title">
          {`Reviewing: ${paper.title} · v${paper.version}`}
        </h1>
      </header>

      {/* The notice (Sign with my name instead), the form (its stylometry tip
          and the commit) and the paper (Cite in review) have to agree with one
          another, so they share a session. It renders no element. */}
      <ReviewSessionProvider>
        <div className="rf-split">
          <PaperPane paper={paper} />
          <div className="rf-side">
            <AnonymityNotice />
            {/* The conflict check comes before the form: a reviewer sees it
                before deciding what to write. It is advisory, so a failure here
                never hides the form. */}
            <ConflictCheck
              paperId={paper.shortId}
              initial={props.conflict}
              initialError={props.conflictError}
              signedIn={props.signedIn}
              signInHref={props.signInHref}
            />
            <ReviewForm
              paperId={paper.shortId}
              versionCid={paper.versionCid}
              signedIn={props.signedIn}
              signInHref={props.signInHref}
              commit={props.commit}
              prev={props.prev}
              latestVersion={paper.version}
            />
          </div>
        </div>
      </ReviewSessionProvider>
    </div>
  );
}

/** Why there is no form: a bad id, an unlisted paper, or a failed load. */
export function ReviewNotice({
  failure,
  retryHref,
}: {
  failure: PaperFailure;
  retryHref?: string;
}) {
  return (
    <div className="rf-page">
      <div className="rf-notice" role="alert">
        <h1 className="rf-notice-title">{failure.title}</h1>
        <p className="rf-notice-text">{failure.message}</p>
        {failure.kind === "failed" && retryHref !== undefined ? (
          <a className="rf-button" href={retryHref}>
            Try again
          </a>
        ) : null}
      </div>
    </div>
  );
}
