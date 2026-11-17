import type { Metadata } from "next";

import {
  ReviewsTab,
  classifyReviewsError,
  emptyReviews,
  loadReviews,
  type ReviewsData,
} from "../../../../features/paper-reviews";
// The id rules (format and checksum) and the version list are paper-meta's:
// one parser for every page that takes `/{id}[/v{n}]`.
import {
  MetaRefError,
  metaRefFromSegments,
  type MetaRef,
} from "../../../../features/paper-meta";

/**
 * `/reviews/{id}[/v{n}]` — the Reviews tab on a page of its own.
 *
 * The URL mirrors the paper page's (`/p/{id}[/v{n}]`, docs/design.md §4). The
 * server fetches the public reviews — `GET /v1/papers/{id}/reviews` — and
 * hands them to the tab as `initial`, so the first HTML response already
 * carries the reviewer labels, recommendations and rubric scores, readable
 * before any JavaScript runs.
 *
 * The endpoint resolves a paper id to its listed version and answers `404`
 * for a paper this node does not hold. That is the calm "no reviews yet"
 * state, not a failure (§1), so it is passed on as an empty dataset; only a
 * transport or server failure becomes a retryable message.
 *
 * The route group `(paper-reviews)` adds no URL segment; the layout in this
 * directory carries the global navigation.
 */

/**
 * Reviews change with every commit and reveal. `force-dynamic` also keeps
 * `next build` from fetching them (and baking an empty state into the page)
 * when the API is down.
 */
export const dynamic = "force-dynamic";

interface ReviewsPageProps {
  /** `/reviews/k3f9-q2xz-7mwd` or `/reviews/k3f9-q2xz-7mwd/v2` (Next 15: a promise). */
  params: Promise<{ ref: string[] }>;
}

type Parsed = { ref: MetaRef; error?: undefined } | { ref?: undefined; error: string };

function parse(segments: string[]): Parsed {
  try {
    return { ref: metaRefFromSegments(segments) };
  } catch (error) {
    return {
      error: error instanceof MetaRefError ? error.message : "That is not a paper id.",
    };
  }
}

export async function generateMetadata({ params }: ReviewsPageProps): Promise<Metadata> {
  const parsed = parse((await params).ref);
  return {
    title:
      parsed.ref !== undefined
        ? `Reviews of ${parsed.ref.schId} · Scholium`
        : "Reviews · Scholium",
    description:
      "The formal reviews of a Scholium paper: reviewer label, recommendation, rubric scores and the report, with the median score per rubric dimension.",
  };
}

function Header({ schId }: { schId?: string }) {
  return (
    <header className="prs-header">
      <p className="prs-kicker mono-id">
        scholium / reviews{schId !== undefined ? ` / ${schId}` : ""}
      </p>
      <h1 className="prs-title">Reviews</h1>
      <p className="prs-lede">
        Formal peer reviews, with the reviewer&rsquo;s recommendation and
        rubric. Reports stay sealed until two reviews are committed on the
        version, or 21 days after the first; the rubric is sealed with the
        review until that review is revealed.
      </p>
    </header>
  );
}

export default async function ReviewsPage({ params }: ReviewsPageProps) {
  const parsed = parse((await params).ref);

  if (parsed.ref === undefined) {
    return (
      <>
        <Header />
        <div className="prs-notice" role="alert">
          <p className="prs-notice__title">That is not a paper id</p>
          <p className="prs-notice__text">{parsed.error}</p>
        </div>
      </>
    );
  }

  const ref = parsed.ref;

  let initial: ReviewsData | undefined;
  let initialError: string | undefined;
  try {
    // The URL's version, when it names one, is part of the id: `/v1` must list
    // version 1, not the newest listed version the bare id resolves to.
    initial = await loadReviews(ref.schId);
  } catch (error) {
    const failure = classifyReviewsError(error);
    if (failure.kind === "missing") {
      initial = emptyReviews(ref.shortId);
    } else {
      initialError = failure.message;
    }
  }

  return (
    <>
      <Header schId={ref.schId} />
      <ReviewsTab
        paperId={ref.schId}
        initial={initial}
        initialError={initialError}
      />
    </>
  );
}
