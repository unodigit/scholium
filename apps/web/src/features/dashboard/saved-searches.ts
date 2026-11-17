/**
 * The saved searches list on `/me`.
 *
 * `POST /v1/me/saved-searches` (feature 180) stores a search and answers
 * `{"id": "ss_...", "did": "...", "query": {...}}`, `query` being the filters
 * of `GET /v1/search` in canonical form: `q`, `category[]`, `status[]`,
 * `has_code`, `from`, `to`. The API also serves the list and the delete:
 *
 * - `GET    /v1/me/saved-searches`      -> `{"items": [{id, did, query}, ...]}`
 * - `DELETE /v1/me/saved-searches/{id}` -> `204`, idempotent
 *
 * A body that is not a list is an error, never "no saved searches": that would
 * say the reader has none when the truth is "we don't know".
 *
 * Pure data and functions, no React, so the card and vitest share them.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import {
  EMPTY_SEARCH_STATE,
  searchHref,
  type SearchState,
} from "../search-page/search";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const SAVED_SEARCHES_ENDPOINT = "/me/saved-searches";

/** `DELETE` target for one saved search. */
export function savedSearchEndpoint(id: string): string {
  return `${SAVED_SEARCHES_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** What the saved-search calls need from the API client. */
export type SavedSearchesClient = Pick<ApiClient, "get" | "delete">;

/** What saving needs from the API client. */
export type SavedSearchesWriteClient = Pick<ApiClient, "post">;

/** A saved search's filters, as the API stores them. Every key is optional. */
export interface SavedSearchQuery {
  readonly q?: string;
  readonly category?: readonly string[];
  readonly status?: readonly string[];
  readonly has_code?: boolean;
  readonly from?: string;
  readonly to?: string;
}

/** One saved search. */
export interface SavedSearch {
  readonly id: string;
  readonly query: SavedSearchQuery;
}

/** Raised when the API answers with something that is not a saved-search list. */
export class SavedSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedSearchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readTextList(value: unknown): readonly string[] | undefined {
  const list = (Array.isArray(value) ? value : [value])
    .map(readText)
    .filter((item): item is string => item !== undefined);
  return list.length > 0 ? list : undefined;
}

/** Keep the filters this screen knows; drop anything else the API may add. */
function parseQuery(value: unknown): SavedSearchQuery {
  if (!isRecord(value)) {
    return {};
  }
  return {
    q: readText(value.q),
    category: readTextList(value.category),
    status: readTextList(value.status),
    has_code: typeof value.has_code === "boolean" ? value.has_code : undefined,
    from: readText(value.from),
    to: readText(value.to),
  };
}

/**
 * Validate a `GET /v1/me/saved-searches` body.
 *
 * A body that is not a list, or a row with no `id` (it could not be deleted),
 * is rejected rather than shown as "no saved searches": an empty card would
 * say the reader has none when the truth is "we don't know".
 */
export function parseSavedSearches(payload: unknown): SavedSearch[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : null;
  if (list === null) {
    throw new SavedSearchError("The API did not return a list of saved searches.");
  }
  return list.map((row, index) => {
    const id = isRecord(row) ? readText(row.id) : undefined;
    if (!isRecord(row) || id === undefined) {
      throw new SavedSearchError(`Saved search ${index + 1} has no id.`);
    }
    return { id, query: parseQuery(row.query) };
  });
}

/** The caller's saved searches. */
export async function loadSavedSearches(
  client: Pick<ApiClient, "get"> = api,
): Promise<SavedSearch[]> {
  const payload = await client.get<unknown>(SAVED_SEARCHES_ENDPOINT, {
    cache: "no-store",
  });
  return parseSavedSearches(payload);
}

/** Delete one saved search; resolves once the API answers `204`. */
export async function deleteSavedSearch(
  id: string,
  client: Pick<ApiClient, "delete"> = api,
): Promise<void> {
  await client.delete(savedSearchEndpoint(id));
}

/** The `/search` state a saved query re-runs as. */
export function savedSearchState(query: SavedSearchQuery): SearchState {
  return {
    ...EMPTY_SEARCH_STATE,
    q: query.q ?? "",
    categories: query.category ?? [],
    statuses: query.status ?? [],
    hasCode: query.has_code ?? null,
    dateFrom: query.from ?? "",
    dateTo: query.to ?? "",
  };
}

/**
 * The saved-search `query` object for a `/search` state — the inverse of
 * {@link savedSearchState}. Only filters that are actually set are carried:
 * the API rejects a blank `q` and stores a canonical object, so an empty
 * filter must not become an explicit `null`.
 */
export function savedSearchQuery(state: SearchState): SavedSearchQuery {
  const query: {
    q?: string;
    category?: readonly string[];
    status?: readonly string[];
    has_code?: boolean;
    from?: string;
    to?: string;
  } = {};
  const term = state.q.trim();
  if (term !== "") {
    query.q = term;
  }
  if (state.categories.length > 0) {
    query.category = [...state.categories];
  }
  if (state.statuses.length > 0) {
    query.status = [...state.statuses];
  }
  if (state.hasCode !== null) {
    query.has_code = state.hasCode;
  }
  if (state.dateFrom !== "") {
    query.from = state.dateFrom;
  }
  if (state.dateTo !== "") {
    query.to = state.dateTo;
  }
  return query;
}

/** Optional extras when saving a search. */
export interface SaveSearchOptions {
  /**
   * Ask for new matches by email. The API does not store a per-search flag
   * yet (its daily digest already covers every saved search and follows), so
   * this is carried in the request body for forward compatibility only.
   */
  readonly digest?: boolean;
}

/**
 * Save a search through `POST /v1/me/saved-searches`.
 *
 * The body is `{"query": {...}}`; each save is its own row, so saving the same
 * search twice keeps both copies until one is deleted.
 */
export async function saveSearch(
  query: SavedSearchQuery,
  options: SaveSearchOptions = {},
  client: SavedSearchesWriteClient = api,
): Promise<SavedSearch> {
  const body: Record<string, unknown> = { query };
  if (options.digest === true) {
    body.digest = true;
  }
  const payload = await client.post<unknown>(SAVED_SEARCHES_ENDPOINT, body);
  const [saved] = parseSavedSearches([payload]);
  return saved;
}

/** `/search?...` for a saved query: the link that re-runs it. */
export function savedSearchHref(query: SavedSearchQuery): string {
  return searchHref(savedSearchState(query));
}

/** The filters other than the search text, as short phrases, in a fixed order. */
export function savedSearchFilters(query: SavedSearchQuery): string[] {
  const filters: string[] = [];
  if (query.category) {
    filters.push(query.category.join(", "));
  }
  if (query.status) {
    filters.push(query.status.join(", "));
  }
  if (query.has_code !== undefined) {
    filters.push(query.has_code ? "has code" : "no code");
  }
  if (query.from && query.to) {
    filters.push(`${query.from} – ${query.to}`);
  } else if (query.from) {
    filters.push(`from ${query.from}`);
  } else if (query.to) {
    filters.push(`to ${query.to}`);
  }
  return filters;
}

/**
 * What a saved search is called on screen: its search text, or, for a search
 * that is only filters, the filters themselves.
 */
export function savedSearchTitle(query: SavedSearchQuery): string {
  return query.q ?? (savedSearchFilters(query).join(" · ") || "Saved search");
}

/** Sort a failed load or delete into a plain sentence. */
export function describeSavedSearchError(error: unknown, action: "load" | "delete"): string {
  const fallback =
    action === "load"
      ? "The API could not return your saved searches."
      : "Couldn’t delete this saved search.";
  if (error instanceof ApiError) {
    return error.detail || error.title || fallback;
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
