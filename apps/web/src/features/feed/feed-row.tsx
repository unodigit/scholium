/**
 * One row of the feed (docs/design.md §5.1):
 *
 * ```text
 * Can a Meta-Agent Choose the Safer Branch?                    ← serif title
 * M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago     ← meta line
 * An evaluation framework for whether meta-agents can iden…    ← two-line abstract
 * ✓ Reviewed                                                    ← status chips
 * ```
 *
 * A row shows **no vote, like or score of any kind**: it takes only the fields
 * above from a {@link FeedItem}, and the item type has no such field.
 *
 * Server-safe (no hooks, no state), so the category pages (`/c/[category]`)
 * reuse it for "the same row layout".
 */

import { StatusChip, isPaperStatus } from "../ui-kit";
import {
  authorLine,
  categoryPath,
  paperHref,
  rowAge,
  type FeedItem,
  type FeedSort,
} from "./feed";

/** Props for {@link FeedRow}. */
export interface FeedRowProps {
  readonly item: FeedItem;
  /** The sort the list is in: it decides which timestamp the age counts from. */
  readonly sort?: FeedSort;
  /** The moment ages are measured to; defaults to the current time. */
  readonly now?: Date;
}

/** A paper as one list item: title, byline, meta, abstract and status chips. */
export function FeedRow({ item, sort = "newest", now }: FeedRowProps) {
  const byline = authorLine(item.authors);
  const age = rowAge(item, sort, now ?? new Date());
  const truncated = byline.more > 0;

  return (
    <li className="fd-row">
      <h2 className="fd-row-title">
        <a href={paperHref(item)}>{item.title}</a>
      </h2>

      <p className="fd-row-meta">
        {byline.shown.length > 0 ? (
          <span
            className="fd-row-authors"
            title={truncated ? byline.all.join(", ") : undefined}
          >
            {byline.shown.join(", ")}
            {truncated ? `, +${byline.more}` : ""}
          </span>
        ) : null}

        {item.categories.length > 0 ? (
          <span className="fd-row-categories">
            {item.categories.map((category, index) => (
              <span key={category}>
                {index > 0 ? ", " : ""}
                <a href={categoryPath(category)}>{category}</a>
              </span>
            ))}
          </span>
        ) : null}

        <span className="fd-row-version">v{item.n}</span>

        {age !== null ? (
          // The server and the browser each measure "now", so the label can
          // differ by a tick at a boundary; the instant itself never does.
          <time
            className="fd-row-age"
            dateTime={age.dateTime}
            title={age.title}
            suppressHydrationWarning
          >
            {age.label}
          </time>
        ) : null}
      </p>

      {item.abstract !== "" ? (
        <p className="fd-row-abstract">{item.abstract}</p>
      ) : null}

      {isPaperStatus(item.status) ? (
        <ul className="fd-row-chips" aria-label="Status">
          <li>
            <StatusChip status={item.status} />
          </li>
        </ul>
      ) : null}
    </li>
  );
}

export default FeedRow;
