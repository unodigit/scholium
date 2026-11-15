/**
 * `search-page` — `/search?q=` (keyword and semantic search).
 *
 * The feature owns the route group `app/(search-page)/` and this module. Both
 * halves of the search page share one source of truth for the URL state and
 * the API shapes:
 *
 * ```ts
 * import {
 *   parseSearchParams,
 *   searchHref,
 *   loadKeywordSearch,
 *   loadSemanticSearch,
 * } from "@/features/search-page";
 * ```
 *
 * `GET /v1/search` answers ranked full-text matches with facet counts;
 * `GET /v1/search/semantic` ranks listed versions by meaning. The server route
 * fetches the first page so it is in the first HTML response; the client
 * component answers every later filter, term or mode change.
 */

export {
  EMPTY_SEARCH_STATE,
  KEYWORD_RESULT_LIMIT,
  SEARCH_ENDPOINT,
  SEARCH_PATH,
  SEARCH_STATUSES,
  SEARCH_TITLE,
  SEMANTIC_ENDPOINT,
  SEMANTIC_RESULT_LIMIT,
  SearchResponseError,
  clearFilters,
  describeSearchError,
  facetOptions,
  formatListedAt,
  hasActiveFilters,
  keywordQuery,
  loadKeywordSearch,
  loadSemanticSearch,
  parseSearchParams,
  parseSearchResult,
  parseSemanticResult,
  resultHref,
  resultSummary,
  searchHref,
  searchStateKey,
  semanticQuery,
  statusOptions,
  toggleCategory,
  toggleStatus,
  type FacetCounts,
  type FacetOption,
  type SearchClient,
  type SearchMode,
  type SearchParamsInput,
  type SearchResult,
  type SearchResultItem,
  type SearchState,
  type SemanticResult,
} from "./search";

export {
  SearchPage,
  type LoadKeywordSearch,
  type LoadSemanticSearch,
  type SearchPageProps,
  type UpdateUrl,
  type UrlUpdateMode,
} from "./search-page";
