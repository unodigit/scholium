/**
 * Small URL helpers for the review form.
 *
 * Kept apart from `paper.ts` (which pulls in the API client and the id parser)
 * so the client components can build their links without dragging the paper
 * loader into the browser bundle.
 */

/** The route prefix: `/review/{id}` (docs/design.md §4). */
export const REVIEW_PATH = "/review";

/** The reader-facing page title. */
export const REVIEW_TITLE = "Review";

/** The URL of the review form for a paper. */
export function reviewHref(shortId: string): string {
  return `${REVIEW_PATH}/${encodeURIComponent(shortId)}`;
}

/** Sign-in with a way back to this review: `/signin?next=%2Freview%2F…`. */
export function reviewSignInHref(shortId: string): string {
  // Build the path from the raw id: `reviewHref` already escapes it, and
  // escaping that result again would turn `:` into `%253A`.
  return `/signin?next=${encodeURIComponent(`${REVIEW_PATH}/${shortId}`)}`;
}
