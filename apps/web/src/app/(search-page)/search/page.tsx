import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  SearchPage,
  describeSearchError,
  loadKeywordSearch,
  loadSemanticSearch,
  paperHrefForQuery,
  parseSearchParams,
  type SearchParamsInput,
  type SearchResult,
  type SearchState,
  type SemanticResult,
} from "../../../features/search-page";

export const metadata: Metadata = {
  title: "Search",
  description:
    "Search listed papers by title, abstract or full text, with filters for category, date, status and code, and a semantic search mode.",
};

/**
 * Search depends on the query string and on live API data; there is nothing
 * useful to prerender. `force-dynamic` also keeps `next build` from running a
 * search (and baking an error state) when the API is not up at build time.
 */
export const dynamic = "force-dynamic";

interface SearchRouteProps {
  /** Next.js 15 hands search params to the page as a promise. */
  searchParams?: Promise<SearchParamsInput>;
}

/**
 * `/search?q=…` — the first page of results, rendered on the server.
 *
 * The route reads the same `searchParams` the client component writes
 * (`q`, `semantic`, `category`, `status`, `has_code`, `from`, `to`) and
 * fetches once, so the first HTML response contains the result list and works
 * without JavaScript. A failed fetch is passed down as a retryable message
 * rather than thrown: the shell and the filters stay usable, and the client
 * retries in the browser (or on the next filter change).
 */
export default async function SearchRoutePage({ searchParams }: SearchRouteProps) {
  const params: SearchParamsInput = (await searchParams) ?? {};
  const state: SearchState = parseSearchParams(params);

  // A `sch:` id is a paper address, not a search term: send the reader to the
  // paper page before any search runs. Doing it on the server means a shared
  // or reloaded `/search?q=sch:…` link, and the global nav's plain GET form,
  // land on the paper page even before JavaScript loads (feature 184).
  const paperTarget = paperHrefForQuery(state.q);
  if (paperTarget !== null) {
    redirect(paperTarget);
  }

  let initialResult: SearchResult | SemanticResult | undefined;
  let initialError: string | undefined;

  if (state.q.trim() !== "") {
    try {
      initialResult =
        state.mode === "semantic"
          ? await loadSemanticSearch(state)
          : await loadKeywordSearch(state);
    } catch (error) {
      initialError = describeSearchError(error, state.mode);
    }
  }

  return (
    <SearchPage
      initialState={state}
      initialResult={initialResult}
      initialError={initialError}
    />
  );
}
