/**
 * `search-page` — `/search?q=` (keyword and semantic search) and the paper
 * page a `sch:` id in the field opens.
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
 *   paperHrefForQuery,
 *   loadPaperPage,
 * } from "@/features/search-page";
 * ```
 *
 * `GET /v1/search` answers ranked full-text matches with facet counts;
 * `GET /v1/search/semantic` ranks listed versions by meaning. The server route
 * fetches the first page so it is in the first HTML response; the client
 * component answers every later filter, term or mode change.
 *
 * A `sch:xxxx-xxxx-xxxx` (or `/vN`) term is not a search: `paperHrefForQuery`
 * turns it into `/p/{id}`, the server route redirects there, and the paper
 * route renders `PaperPage` with an Authors section whose names come from
 * `GET /v1/profiles/{did}` (feature 184).
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
  attachAuthorNames,
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
  parseSchId,
  parseSemanticResult,
  paperHref,
  paperHrefForQuery,
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
  type SearchAuthor,
  type SearchClient,
  type SearchMode,
  type SearchParamsInput,
  type SearchResult,
  type SearchResultItem,
  type SearchState,
  type SchIdRef,
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

export { PaperPage, type PaperPageProps } from "./paper-page";

export {
  SaveSearchButton,
  saveSearchSigninHref,
  type SaveSearchButtonProps,
} from "./save-search-button";

export {
  PaperResponseError,
  describePaperError,
  loadPaper,
  loadPaperPage,
  loadProfile,
  paperPath,
  parsePaper,
  parsePaperRoute,
  parseProfile,
  type AuthorProfile,
  type PaperAddress,
  type PaperAuthor,
  type PaperClient,
  type PaperNotice,
  type PaperView,
} from "./paper";
