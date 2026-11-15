/**
 * `feed` — the home feed at `/` (docs/design.md §5.1).
 *
 * The feature owns the route group `app/(feed)/` and this module. Both halves
 * share one source of truth for the URL state and the API shapes:
 *
 * ```ts
 * import {
 *   FeedPage,
 *   FeedRow,
 *   parseFeedParams,
 *   loadFeedPage,
 * } from "@/features/feed";
 * ```
 *
 * `GET /v1/papers` lists the papers with a listed version; the server route
 * fetches the first page of the Latest and Reviewed tabs so it is in the first
 * HTML response, and the client component answers every later tab, selector
 * and "Show more" change (and the whole Following tab, which needs the
 * browser's session). {@link FeedRow} is server-safe and is the row the
 * category pages (`/c/[category]`) reuse.
 */

export {
  DEFAULT_FEED_STATE,
  FEED_ENDPOINT,
  FEED_HEADINGS,
  FEED_PAGE_SIZE,
  FEED_PATH,
  FEED_SORTS,
  FEED_SORT_LABELS,
  FEED_TABS,
  FEED_TAB_LABELS,
  FeedResponseError,
  appendItems,
  authorLabel,
  authorLine,
  categoriesOf,
  categoryChoices,
  categoryPath,
  describeFeedError,
  emptyFeedSentence,
  feedHref,
  feedQuery,
  feedStateKey,
  formatAge,
  formatDate,
  itemKey,
  loadFeedPage,
  paperHref,
  parseFeedPage,
  parseFeedParams,
  parseInstant,
  rowAge,
  shortDid,
  signInHref,
  type AuthorLine,
  type CategoryChoice,
  type FeedAuthor,
  type FeedClient,
  type FeedItem,
  type FeedPageData,
  type FeedParamsInput,
  type FeedSort,
  type FeedState,
  type FeedTab,
  type RowAge,
} from "./feed";

export { FeedRow, type FeedRowProps } from "./feed-row";

export {
  FeedPage,
  type FeedPageProps,
  type LoadFeedPage,
  type UpdateUrl,
  type UrlUpdateMode,
} from "./feed-page";
