import type { Metadata } from "next";

import {
  FeedPage,
  describeFeedError,
  loadFeedPage,
  parseFeedParams,
  type FeedPageData,
  type FeedParamsInput,
  type FeedState,
} from "../../../features/feed";

import { ArxivPicks } from "../../../features/feed/arxiv-picks";

export const metadata: Metadata = {
  title: "Papers",
  description:
    "The latest and reviewed preprints on Scholium, by category, newest first and with no vote counts.",
};

/**
 * The feed depends on the query string and on live API data; there is nothing
 * useful to prerender. `force-dynamic` also keeps `next build` from fetching
 * the catalog (and baking an error state into the page) when the API is not up
 * at build time.
 */
export const dynamic = "force-dynamic";

interface FeedRouteProps {
  /** Next.js 15 hands search params to the page as a promise. */
  searchParams?: Promise<FeedParamsInput>;
}

/**
 * `/papers?tab=…&category=…&sort=…` — the first page of the feed, rendered on
 * the server.
 *
 * The route reads the same `searchParams` the client component writes and
 * fetches once, so the first HTML response already contains the rows and works
 * without JavaScript. A failed fetch is passed down as a retryable message
 * rather than thrown: the tabs and selectors stay usable.
 *
 * The **Following** tab is not fetched here. It lists the caller's own
 * follows, and the session token lives in the browser's storage, not in a
 * cookie the server could forward — an anonymous request would answer for
 * nobody. The client component asks for it once it knows who is signed in.
 */
export default async function FeedRoutePage({ searchParams }: FeedRouteProps) {
  const params: FeedParamsInput = (await searchParams) ?? {};
  const state: FeedState = parseFeedParams(params);

  let initialPage: FeedPageData | undefined;
  let initialError: string | undefined;

  if (state.tab !== "following") {
    try {
      initialPage = await loadFeedPage(state);
    } catch (error) {
      initialError = describeFeedError(error, state.tab);
    }
  }

  return (
    <FeedPage
      initialState={state}
      initialPage={initialPage}
      initialError={initialError}
      latestRecommendations={<ArxivPicks />}
    />
  );
}
