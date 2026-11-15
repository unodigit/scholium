/**
 * Small URL helpers for the reviews tab.
 *
 * Kept apart from `review.ts`, which is pure data, so a client component can
 * build its links without pulling anything else in. The paths mirror
 * docs/design.md §4: the paper page is `/p/{id}[/v{n}]`, the review form is
 * `/review/{id}`, and this tab's own deep link is `/reviews/{id}[/v{n}]`.
 */

/** Split a paper spelling into its id and an optional `/vN` suffix. */
function split(paperId: string): { id: string; version: string | null } {
  const text = paperId.trim();
  const match = /^(.+?)(\/v\d+)$/.exec(text);
  const id = (match !== null ? match[1] : text).replace(/^sch:/i, "");
  return { id, version: match !== null ? match[2] : null };
}

/** The paper page: `/p/k3f9-q2xz-7mwd` or `/p/k3f9-q2xz-7mwd/v2`. */
export function paperHref(paperId: string): string {
  const { id, version } = split(paperId);
  return `/p/${encodeURIComponent(id)}${version ?? ""}`;
}

/** The review form for a paper: `/review/k3f9-q2xz-7mwd`. */
export function reviewHref(paperId: string): string {
  const { id } = split(paperId);
  return `/review/${encodeURIComponent(id)}`;
}

/** This tab on a page of its own: `/reviews/k3f9-q2xz-7mwd[/v2]`. */
export function reviewsTabHref(paperId: string): string {
  const { id, version } = split(paperId);
  return `/reviews/${encodeURIComponent(id)}${version ?? ""}`;
}
