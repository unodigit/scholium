/**
 * `/review/[id]` — the formal review form (docs/design.md §5.5).
 *
 * A split view: the paper on the left, the rubric form on the right, with the
 * anonymity notice above the form. Under 1024 px the two stack, paper first,
 * so a phone reads the paper and then writes the review (design.md §10 asks
 * for stepped pages under 640 px; that is not built yet, see the README).
 *
 * The page is given either the paper or the reason there is none, never both:
 * a review form that does not show what it reviews would invite a review of
 * the wrong paper, so a failure replaces the whole split view.
 *
 * Server-safe: the only client component below is the form.
 */

import { AnonymityNotice } from "./anonymity-notice";
import type { PaperFailure, ReviewPaper } from "./paper";
import { PaperPane } from "./paper-pane";
import { ReviewForm } from "./review-form";
import "./review-form.css";

export type ReviewPageProps =
  | { paper: ReviewPaper; failure?: undefined; retryHref?: undefined }
  | {
      paper?: undefined;
      failure: PaperFailure;
      /** Where "Try again" goes; only offered for a failure worth retrying. */
      retryHref?: string;
    };

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

      <div className="rf-split">
        <PaperPane paper={paper} />
        <div className="rf-side">
          <AnonymityNotice />
          <ReviewForm />
        </div>
      </div>
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
