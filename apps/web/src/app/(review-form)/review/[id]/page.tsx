import type { Metadata } from "next";

import {
  InvalidPaperIdError,
  describePaperError,
  loadReviewPaper,
  parseReviewTarget,
  reviewHref,
} from "../../../../features/review-form/paper";
import { ReviewPage } from "../../../../features/review-form/review-page";

/**
 * The paper is read fresh on every request: a stale page could invite a review
 * of text that has since gained a newer version or been retracted.
 * `force-dynamic` also keeps `next build` from trying to bake an error state
 * when the API is not running at build time.
 */
export const dynamic = "force-dynamic";

interface ReviewRouteProps {
  /** `/review/sch:k3f9-q2xz-7mwd` or `/review/k3f9-q2xz-7mwd` (Next 15: a promise). */
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: ReviewRouteProps): Promise<Metadata> {
  const { id } = await params;
  let title = "Review · Scholium";
  try {
    title = `Review ${parseReviewTarget(id)} · Scholium`;
  } catch (error) {
    if (!(error instanceof InvalidPaperIdError)) throw error;
  }
  return {
    title,
    description:
      "Write a formal review of a Scholium paper against the six-part rubric, anonymously by default.",
    // A reviewer's workspace, not something to be found by a search engine.
    robots: { index: false, follow: false },
  };
}

/**
 * `/review/{id}` — the paper on the left and the rubric form on the right.
 *
 * The paper is read on the server from the public API, so the first HTML
 * response already holds the title, abstract and text. Nothing here needs the
 * reviewer's account: committing the review is what will. A bad id, an
 * unlisted paper and a failed read are each shown as a notice rather than
 * thrown, so the shell and the global navigation still work.
 */
export default async function ReviewRoutePage({ params }: ReviewRouteProps) {
  const { id } = await params;

  let shortId: string | undefined;
  try {
    shortId = parseReviewTarget(id);
    return <ReviewPage paper={await loadReviewPaper(shortId)} />;
  } catch (error) {
    return (
      <ReviewPage
        failure={describePaperError(error)}
        retryHref={shortId === undefined ? undefined : reviewHref(shortId)}
      />
    );
  }
}
