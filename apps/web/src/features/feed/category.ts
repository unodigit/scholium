/**
 * `/c/{category}` — one category's papers (docs/design.md §4, §5.1).
 *
 * The page is the home feed narrowed to a category: the same listing endpoint
 * (`GET /v1/papers?category=…`), the same newest-first order and the same
 * {@link FeedRow} layout. Its other half is the category's Atom feed
 * (`GET /v1/feeds/{category}`, API plugin `feeds`, feature 88), which a reader
 * subscribes to instead of visiting the page.
 *
 * Pure data and functions — no React — so the server route, the page component
 * and vitest share one validation, state and URL path.
 */

import {
  DEFAULT_CATEGORIES,
  type NavCategory,
} from "../../components/nav/categories";
import { resolveApiBaseUrl } from "../../lib/api";
import { categoryPath, type FeedState } from "./feed";

/** The longest category the API accepts (`GET /v1/feeds/{category}` and the listing). */
export const CATEGORY_MAX_CHARS = 64;

/** Where the Atom feed lives, relative to the API's `/v1` prefix. */
export const CATEGORY_FEED_PATH_PREFIX = "/v1/feeds/";

/** The `[category]` route segment, as Next.js hands it over. */
export type CategoryParamInput = string | readonly string[] | null | undefined;

/**
 * Read a `[category]` route segment, or `""` when it is not a category the API
 * would accept.
 *
 * The API answers a category longer than 64 characters with a `422`, so a URL
 * carrying one is treated as not-a-category here instead of becoming a failed
 * request. Only the first value of a repeated parameter is used.
 */
export function normalizeCategory(raw: CategoryParamInput): string {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const text = typeof first === "string" ? first.trim() : "";
  return text.length >= 1 && text.length <= CATEGORY_MAX_CHARS ? text : "";
}

/** The human name of a category (`Artificial Intelligence`), or `null` when unknown. */
export function categoryLabel(
  category: string,
  taxonomy: readonly NavCategory[] = DEFAULT_CATEGORIES,
): string | null {
  return taxonomy.find((entry) => entry.id === category)?.label ?? null;
}

/** What the category's lede says about it. */
export function categoryLede(
  category: string,
  taxonomy: readonly NavCategory[] = DEFAULT_CATEGORIES,
): string {
  const label = categoryLabel(category, taxonomy);
  return label === null
    ? `The newest papers filed under ${category}, newest first.`
    : `The newest papers in ${label} (${category}), newest first.`;
}

/** The page's `<title>` and social description. */
export function categoryDescription(
  category: string,
  taxonomy: readonly NavCategory[] = DEFAULT_CATEGORIES,
): string {
  const label = categoryLabel(category, taxonomy);
  return label === null
    ? `The newest papers filed under ${category} on Scholium.`
    : `The newest papers in ${label} (${category}) on Scholium.`;
}

/** The feed view a category page shows: the latest tab, this category, newest first. */
export function categoryFeedState(category: string): FeedState {
  return { tab: "latest", category: category.trim(), sort: "newest" };
}

/** The API path of a category's Atom feed — `/v1/feeds/cs.AI`. */
export function categoryFeedPath(category: string): string {
  return `${CATEGORY_FEED_PATH_PREFIX}${encodeURIComponent(category.trim())}`;
}

/**
 * The absolute URL of a category's Atom feed.
 *
 * A feed reader needs an absolute URL, and the API may live on another origin
 * (`NEXT_PUBLIC_API_URL`), so the API base is resolved here rather than left
 * relative to the web app.
 */
export function categoryFeedHref(category: string, baseUrl?: string): string {
  const base = (baseUrl ?? resolveApiBaseUrl()).replace(/\/+$/, "");
  return `${base}${categoryFeedPath(category)}`;
}

/** The page's own path — `/c/cs.AI`. */
export function categoryPageHref(category: string): string {
  return categoryPath(category);
}

/** The one sentence an empty category page says. */
export function categoryEmptySentence(category: string): string {
  return `No papers are listed in ${category} yet.`;
}
