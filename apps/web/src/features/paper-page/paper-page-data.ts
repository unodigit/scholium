/**
 * Everything the paper page needs from the node, read once on the server.
 *
 * The page is one screen made of several public reads:
 *
 * | Part | Read | Used for |
 * | --- | --- | --- |
 * | paper | `GET /v1/papers/{id}[/v{n}]` + `GET /v1/profiles/{did}` per author | title, byline, status, licence |
 * | versions | `GET /v1/papers/{id}/versions` | "v2 of 2", the Versions tab, the anchor line |
 * | manifest | `GET /v1/papers/{id}/v/{n}/manifest` | the PDF action, the Files tab |
 * | reviews | `GET /v1/papers/{id}/reviews` | the Reviews tab and its count, the status chip's count |
 * | discussion | `GET /v1/papers/{id}/threads` | the Discussion tab and its count |
 * | reading | `GET /v1/papers/{id}/v/{n}/text` | the reading column |
 *
 * **The paper decides whether there is a page.** It is read first: without it
 * there is no title, no canonical id and no version number, so a failure
 * there is the page's failure ({@link loadPaperPageData} rejects, and the route
 * says why). Everything else is *a part*: read together, once the paper has
 * said which version it is, and a failure in one becomes that part's message
 * ({@link Part}) so the tab can offer a retry while the rest of the page
 * reads normally. One slow or broken read never blanks the paper.
 *
 * The result is plain JSON-able data, because pieces of it are handed from
 * the server route to client components (the tabs) as props.
 *
 * Every read is injectable ({@link PaperPageLoaders}), so tests need no
 * network and the route can swap one without touching the rest.
 */

import { ApiError } from "../../lib/api";
import {
  describeMetaError,
  loadManifest,
  loadVersions,
  type ManifestData,
  type VersionsData,
} from "../paper-meta/meta";
import {
  describeLoadError as describeDiscussionError,
  loadThreads,
  type DiscussionData,
} from "../paper-discussion/discussion";
import { emptyReviews, type ReviewsData } from "../paper-reviews/review";
import {
  classifyReviewsError,
  loadReviews,
} from "../paper-reviews/reviews-api";
import {
  describePaperError,
  loadPaperPage,
  type PaperAddress,
  type PaperView,
} from "../search-page/paper";
import { latestVersionNumber } from "./paper-facts";
import {
  describeReadingError,
  loadReadingText,
  type ReadingText,
} from "./reading";

/**
 * One piece of the page: what the node said, or why it could not be read.
 * A tab turns `ok: false` into its own message and retry button.
 */
export type Part<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

/** The paper page's data. Plain objects and strings only. */
export interface PaperPageData {
  readonly paper: PaperView;
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`, whatever spelling asked for it. */
  readonly shortId: string;
  /** The version on screen: the one in the URL, else the newest listed. */
  readonly version: number;
  /** `sch:xxxx-xxxx-xxxx/vN`: what the Proof, Reviews and AI tabs are given. */
  readonly versionId: string;
  /** The newest listed version number, or `null` if the timeline is unknown. */
  readonly totalVersions: number | null;
  readonly versions: Part<VersionsData>;
  readonly manifest: Part<ManifestData>;
  readonly reviews: Part<ReviewsData>;
  readonly discussion: Part<DiscussionData>;
  readonly reading: Part<ReadingText>;
}

/** The reads the page makes. Pass a replacement for any of them in tests. */
export interface PaperPageLoaders {
  paper(address: PaperAddress): Promise<PaperView>;
  versions(shortId: string): Promise<VersionsData>;
  manifest(shortId: string, version: number): Promise<ManifestData>;
  reviews(shortId: string): Promise<ReviewsData>;
  discussion(shortId: string): Promise<DiscussionData>;
  reading(shortId: string, version: number): Promise<ReadingText>;
}

/** The real reads, through the shared API client. */
export const DEFAULT_LOADERS: PaperPageLoaders = {
  paper: (address) => loadPaperPage(address),
  versions: (shortId) => loadVersions(shortId),
  manifest: (shortId, version) => loadManifest(shortId, version),
  reviews: (shortId) => loadReviews(shortId),
  discussion: (shortId) => loadThreads(shortId),
  reading: (shortId, version) => loadReadingText(shortId, version),
};

/** Run one read, turning a rejection into the part's own message. */
async function part<T>(
  read: () => Promise<T>,
  describe: (error: unknown) => string,
  recover?: (error: unknown) => T | undefined,
): Promise<Part<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    const recovered = recover?.(error);
    return recovered !== undefined
      ? { ok: true, data: recovered }
      : { ok: false, error: describe(error) };
  }
}

/**
 * Read the paper and everything around it.
 *
 * @throws whatever the paper read throws (an `ApiError`, a `NetworkError`, a
 *   `PaperResponseError`); {@link describePageError} says it in words.
 */
export async function loadPaperPageData(
  address: PaperAddress,
  loaders: PaperPageLoaders = DEFAULT_LOADERS,
): Promise<PaperPageData> {
  const paper = await loaders.paper(address);

  // The API names the paper; the URL may have spelled it as a record id.
  const shortId = paper.shortId !== "" ? paper.shortId : address.id;
  const version = paper.n;

  const [versions, manifest, reviews, discussion, reading] = await Promise.all([
    part(
      () => loaders.versions(shortId),
      (error) => describeMetaError(error, "versions"),
    ),
    part(
      () => loaders.manifest(shortId, version),
      (error) => describeMetaError(error, "files"),
    ),
    part(
      () => loaders.reviews(shortId),
      (error) => classifyReviewsError(error).message,
      // A paper with no reviews answers 404 here. That is the calm
      // "no reviews yet" state, not a failure (docs/design.md §1, principle 7).
      (error) =>
        classifyReviewsError(error).kind === "missing"
          ? emptyReviews(shortId)
          : undefined,
    ),
    part(() => loaders.discussion(shortId), describeDiscussionError),
    part(() => loaders.reading(shortId, version), describeReadingError),
  ]);

  return {
    paper,
    shortId,
    version,
    versionId: `${shortId}/v${version}`,
    totalVersions: latestVersionNumber(
      versions.ok ? versions.data : undefined,
      version,
    ),
    versions,
    manifest,
    reviews,
    discussion,
    reading,
  };
}

/**
 * One plain sentence for a page that could not load.
 *
 * It is the search page's wording (`describePaperError`), with one refinement:
 * a `404` for an address that names a version says the *version* is not
 * listed, since the paper itself may well be.
 */
export function describePageError(
  error: unknown,
  address: PaperAddress,
): string {
  if (error instanceof ApiError && error.status === 404 && address.version !== null) {
    return `This paper has no listed version ${address.version} on this node.`;
  }
  return describePaperError(error);
}
