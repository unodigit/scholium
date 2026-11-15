/**
 * The Categories menu of the global navigation.
 *
 * Category ids are the arXiv-style codes used in paper metadata and URLs
 * (`cs.AI`); the label is the human name shown in the menu. The taxonomy is
 * free-form in the API (record-core validates only the string), so the nav
 * ships with the launch set from `docs/design.md` §5.1 — cs.AI, cs.LG, cs.MA —
 * and takes any list via props once a server-side taxonomy exists.
 */

/** One entry in the nav's Categories menu. */
export interface NavCategory {
  /** Category id as used in metadata and URLs, e.g. `cs.AI`. */
  id: string;
  /** Human name shown in the menu, e.g. `Artificial Intelligence`. */
  label: string;
}

/** The launch categories shown by default (`docs/design.md` §5.1). */
export const DEFAULT_CATEGORIES: readonly NavCategory[] = [
  { id: "cs.AI", label: "Artificial Intelligence" },
  { id: "cs.LG", label: "Machine Learning" },
  { id: "cs.MA", label: "Multiagent Systems" },
];

/**
 * Absolute path of a category page — `docs/design.md` §4: `/c/{category}`.
 *
 * The id is percent-encoded so ids containing reserved characters still
 * produce a single path segment.
 */
export function categoryHref(category: Pick<NavCategory, "id">): string {
  return `/c/${encodeURIComponent(category.id)}`;
}
