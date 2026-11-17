/**
 * `/c/{category}` — one category's papers (docs/design.md §4, §5.1).
 *
 * ```text
 * scholium / category
 * cs.AI                                      Atom feed
 * The newest papers in Artificial Intelligence (cs.AI), newest first.
 * ─────────────────────────────────────────────────────────────────────
 * Can a Meta-Agent Choose the Safer Branch?
 * M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago
 * An evaluation framework for whether meta-agents can identify safer…
 * ✓ Reviewed
 * ```
 *
 * The rows are the home feed's own {@link FeedRow}, so a category page has
 * exactly the same layout as `/`: serif title, byline, categories, version,
 * age, a two-line abstract and status chips, and no vote counts. The page is
 * server-safe (no hooks, no state), so the server route paints the papers in
 * the first HTML response and the page works without JavaScript.
 *
 * The **Atom feed** link points at `GET /v1/feeds/{category}` (features 88 and
 * 89), which is how a reader subscribes to the category instead of revisiting
 * the page.
 */

import { EmptyState } from "../ui-kit";
import { FollowToggle } from "../dashboard/follow-toggle";
import {
  categoryEmptySentence,
  categoryFeedHref,
  categoryLede,
} from "./category";
import { itemKey, type FeedItem } from "./feed";
import { FeedRow } from "./feed-row";
import "./feed.css";

/** Props for {@link CategoryPage}. Only `category` is required. */
export interface CategoryPageProps {
  /** The category id from the route, e.g. `cs.AI`. */
  readonly category: string;
  /** The first page's papers; `undefined` while a page is still expected. */
  readonly items?: readonly FeedItem[];
  /** A failed load's message; the page says so instead of showing an empty list. */
  readonly error?: string;
  /**
   * The Atom feed URL. Defaults to the category's feed on the API; pass `null`
   * when there is no category to subscribe to.
   */
  readonly feedHref?: string | null;
  /** The moment ages are measured to; defaults to the current time. */
  readonly now?: Date;
}

/** One category: its heading, its Atom feed link and the same rows as `/`. */
export function CategoryPage({
  category,
  items,
  error,
  feedHref,
  now,
}: CategoryPageProps) {
  const atomHref = feedHref === undefined ? categoryFeedHref(category) : feedHref;

  return (
    <div className="fd-page fd-category">
      <header className="fd-category-header">
        <p className="fd-category-kicker mono-id">scholium / category</p>
        <div className="fd-category-head">
          {/* The id is the title: it is what the URL and the papers carry. */}
          <h1 className="fd-category-title">{category}</h1>
          <div className="fd-category-actions">
            {/* No real category to follow when the caller passed `null`. */}
            {atomHref !== null ? <FollowToggle category={category} /> : null}
            {atomHref !== null ? (
              <a
                className="fd-category-feed"
                href={atomHref}
                rel="alternate"
                type="application/atom+xml"
                title={`Atom feed of papers in ${category}`}
              >
                Atom feed
              </a>
            ) : null}
          </div>
        </div>
        <p className="fd-category-lede">{categoryLede(category)}</p>
      </header>

      <section className="fd-results" aria-label={`Papers in ${category}`}>
        {error !== undefined ? (
          <div className="fd-error" role="alert">
            <p className="fd-error-message">{error}</p>
          </div>
        ) : items === undefined ? (
          <p className="fd-loading" role="status">
            Loading papers…
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            className="fd-empty"
            sentence={categoryEmptySentence(category)}
            action={{ label: "See the latest papers", href: "/" }}
          />
        ) : (
          <ol className="fd-list">
            {items.map((item) => (
              <FeedRow key={itemKey(item)} item={item} sort="newest" now={now} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export default CategoryPage;
