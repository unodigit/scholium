/**
 * Search: the wire shape of `GET /v1/search` and `GET /v1/search/semantic`,
 * the `/search?q=` URL state, and the words the page uses.
 *
 * The API (plugin: search, features 86 + 87) answers two ways:
 *
 * - **Keyword** (`GET /v1/search?q=`): ranked full-text results plus facet
 *   counts for category and status, and filters for `category`, `status`,
 *   `has_code`, `from` and `to`.
 * - **Semantic** (`GET /v1/search/semantic?q=`): listed versions ranked by
 *   cosine similarity. It takes only `q` and `limit`, so the facet filters
 *   apply to keyword search only.
 *
 * This module is pure data and functions — no React — so the server route,
 * the client component and vitest all share the same parse, URL and fetch
 * logic. Every path is relative to `/v1` because the shared API client adds
 * the prefix.
 */

import {
  ApiError,
  NetworkError,
  api,
  type ApiClient,
  type QueryParams,
} from "../../lib/api";
import { PROFILE_ENDPOINT } from "../feed/feed";

/** The route path (docs/design.md §4). */
export const SEARCH_PATH = "/search";

/** Keyword endpoint, relative to `/v1`. */
export const SEARCH_ENDPOINT = "/search";

/** Semantic endpoint, relative to `/v1`. */
export const SEMANTIC_ENDPOINT = "/search/semantic";

/** Page title. */
export const SEARCH_TITLE = "Search";

/** Most keyword results the page asks for (the API caps at 100). */
export const KEYWORD_RESULT_LIMIT = 20;

/** Most semantic results the page asks for (the API caps at 100). */
export const SEMANTIC_RESULT_LIMIT = 20;

/** The two ways to search. */
export type SearchMode = "keyword" | "semantic";

/**
 * The paper statuses a filter may offer, in reading order. The API also sends
 * facet counts for the statuses actually present, so this is a fallback and
 * an ordering, never a restriction on what can be selected.
 */
export const SEARCH_STATUSES = [
  "preprint",
  "under_review",
  "reviewed",
  "contested",
  "corrected",
  "retracted",
] as const;

/** One author of a result, in byline order. */
export interface SearchAuthor {
  /** The author's `did:` identifier. */
  readonly did: string;
  /** The public display name, when the result (or a profile read) supplies it. */
  readonly name: string | null;
}

/** One result row, common to both endpoints. */
export interface SearchResultItem {
  readonly versionCid: string;
  readonly paperCid: string;
  readonly shortId: string | null;
  readonly n: number;
  /** How many listed versions the paper has (for "v{n} of {total}"). */
  readonly total?: number;
  readonly totalVersions?: number;
  readonly versions?: number;
  readonly title: string;
  readonly abstract: string;
  /**
   * The version's authors in byline order. Optional so a caller that builds a
   * result from an older payload keeps type-checking; a payload that carries
   * an `authors` list always parses to this field.
   */
  readonly authors?: readonly SearchAuthor[];
  readonly categories: readonly string[];
  readonly status: string | null;
  readonly listedAt: string | null;
  /** Keyword results only: the version's manifest lists a code file. */
  readonly hasCode: boolean;
  /** Relevance (keyword BM25 or semantic cosine); comparable only within a query. */
  readonly score: number;
}

/** How many matching papers carry each facet value. */
export interface FacetCounts {
  readonly category: Readonly<Record<string, number>>;
  readonly status: Readonly<Record<string, number>>;
}

/** The answer to a keyword search. */
export interface SearchResult {
  readonly query: string;
  readonly total: number;
  readonly results: readonly SearchResultItem[];
  readonly facets: FacetCounts;
}

/** The answer to a semantic search. */
export interface SemanticResult {
  readonly query: string;
  /** The embedder whose vectors were compared, e.g. `hashing-v1-1024`. */
  readonly embedder: string;
  readonly results: readonly SearchResultItem[];
}

/** Every knob of one search, as the URL carries it. */
export interface SearchState {
  readonly q: string;
  readonly mode: SearchMode;
  /** Categories to keep; any of them (OR), empty means every category. */
  readonly categories: readonly string[];
  /** Statuses to keep; any of them (OR), empty means every status. */
  readonly statuses: readonly string[];
  /** `true` requires code, `false` excludes it, `null` does not care. */
  readonly hasCode: boolean | null;
  /** Earliest listing date, `YYYY-MM-DD`; empty means unbounded. */
  readonly dateFrom: string;
  /** Latest listing date, `YYYY-MM-DD`; empty means unbounded. */
  readonly dateTo: string;
}

/** Next.js `searchParams` shape (`?category=a&category=b` arrives as an array). */
export type SearchParamsInput = Record<
  string,
  string | readonly string[] | undefined
>;

/** A search with no terms and no filters, in keyword mode. */
export const EMPTY_SEARCH_STATE: SearchState = {
  q: "",
  mode: "keyword",
  categories: [],
  statuses: [],
  hasCode: null,
  dateFrom: "",
  dateTo: "",
};

/** Raised when the API answers with something that is not a search result. */
export class SearchResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    // A single value is still a list of one.
    if (typeof value === "string" && value.trim() !== "") {
      return [value.trim()];
    }
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const text = readText(item);
    if (text !== null) {
      seen.add(text);
    }
  }
  return [...seen];
}

function readCountMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const count = readInteger(raw);
    if (key.trim() !== "" && count !== null && count >= 0) {
      counts[key] = count;
    }
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* URL state                                                                   */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TRUTHY_FLAGS = new Set(["1", "true", "on", "yes"]);

function firstValue(
  value: string | readonly string[] | undefined,
): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function allValues(value: string | readonly string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const text = item.trim();
    if (text !== "") {
      seen.add(text);
    }
  }
  return [...seen];
}

function readDate(value: string | readonly string[] | undefined): string {
  const text = firstValue(value).trim();
  return ISO_DATE.test(text) ? text : "";
}

function readCodeFilter(value: string | readonly string[] | undefined): boolean | null {
  const text = firstValue(value).trim().toLowerCase();
  if (text === "true" || text === "1") {
    return true;
  }
  if (text === "false" || text === "0") {
    return false;
  }
  return null;
}

/**
 * Read `/search?q=…&category=…&status=…&has_code=…&from=…&to=…&semantic=1`.
 *
 * Only the parameters the page understands are kept; anything malformed (an
 * unknown `has_code`, a date not shaped `YYYY-MM-DD`) is dropped rather than
 * shown as an active filter the API would reject. Repeated `category` and
 * `status` values are de-duplicated.
 */
export function parseSearchParams(input: SearchParamsInput = {}): SearchState {
  const semantic = firstValue(input.semantic).trim().toLowerCase();
  return {
    q: firstValue(input.q).trim(),
    mode: TRUTHY_FLAGS.has(semantic) ? "semantic" : "keyword",
    categories: allValues(input.category),
    statuses: allValues(input.status),
    hasCode: readCodeFilter(input.has_code),
    dateFrom: readDate(input.from ?? input.date_from),
    dateTo: readDate(input.to ?? input.date_to),
  };
}

/**
 * `/search?q=…` for a state — the one place the URL is built.
 *
 * Keyword mode carries every filter; semantic mode carries only `semantic=1`
 * (the endpoint takes no filters). An empty search is bare `/search`.
 */
export function searchHref(state: SearchState, path: string = SEARCH_PATH): string {
  const params = new URLSearchParams();
  const q = state.q.trim();
  if (q !== "") {
    params.set("q", q);
  }
  if (state.mode === "semantic") {
    params.set("semantic", "1");
  } else {
    for (const category of state.categories) {
      params.append("category", category);
    }
    for (const status of state.statuses) {
      params.append("status", status);
    }
    if (state.hasCode !== null) {
      params.set("has_code", state.hasCode ? "true" : "false");
    }
    if (ISO_DATE.test(state.dateFrom)) {
      params.set("from", state.dateFrom);
    }
    if (ISO_DATE.test(state.dateTo)) {
      params.set("to", state.dateTo);
    }
  }
  const suffix = params.toString();
  return suffix === "" ? path : `${path}?${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* `sch:` ids: the search field is also how a reader jumps to a paper          */
/* -------------------------------------------------------------------------- */

/**
 * The shape of a `sch:` paper id, with an optional `/vN` version suffix.
 *
 * Deliberately *shape only*: the UI redirects what looks like an id and lets
 * the API decide whether a paper with that id exists (and whether its checksum
 * is right). That keeps a mistyped id on the paper page's honest "not listed
 * here" answer instead of turning it into a keyword search for `sch:…`, and it
 * accepts the ids the design and the fixtures write, e.g.
 * `sch:k3f9-q2xz-7mwd/v3`.
 */
const SCH_ID_PATTERN =
  /^sch:([a-z0-9]{4})-([a-z0-9]{4})-([a-z0-9]{4})(?:\/v([1-9][0-9]{0,8}))?$/i;

/** A `sch:` id split into the paper's short id and an optional version. */
export interface SchIdRef {
  /** Canonical lowercase `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** Version number, or `null` for the paper (its latest listed version). */
  readonly version: number | null;
}

/**
 * Read a `sch:` id, or `null` when the text is not one.
 *
 * Surrounding whitespace is ignored and the result is canonical lowercase.
 * Only the shape is checked — existence and checksum are the API's job.
 */
export function parseSchId(value: string): SchIdRef | null {
  const match = SCH_ID_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return {
    shortId: `sch:${match[1]}-${match[2]}-${match[3]}`.toLowerCase(),
    version: match[4] === undefined ? null : Number.parseInt(match[4], 10),
  };
}

/**
 * The paper page URL for an id: `/p/sch:xxxx-xxxx-xxxx` or, for a version,
 * `/p/sch:xxxx-xxxx-xxxx/vN`.
 *
 * The `sch:` colon is percent-encoded, so the URL survives copy, paste and a
 * server round-trip; Next.js decodes the route parameter again.
 */
export function paperHref(ref: SchIdRef): string {
  const base = `/p/${encodeURIComponent(ref.shortId)}`;
  return ref.version === null ? base : `${base}/v${ref.version}`;
}

/**
 * The paper page a search term addresses, or `null` when the term is an
 * ordinary query. Submitting one of these ids goes to the paper page instead
 * of running a keyword search (feature 184).
 */
export function paperHrefForQuery(query: string): string | null {
  const ref = parseSchId(query);
  return ref === null ? null : paperHref(ref);
}

/**
 * A stable identity for a search, used to decide whether a new request is
 * needed. Filter order does not matter; the query is trimmed.
 */
export function searchStateKey(state: SearchState): string {
  return JSON.stringify([
    state.q.trim(),
    state.mode,
    [...state.categories].sort(),
    [...state.statuses].sort(),
    state.hasCode,
    state.dateFrom,
    state.dateTo,
  ]);
}

/** Whether any facet filter is active (the query itself is not a filter). */
export function hasActiveFilters(state: SearchState): boolean {
  return (
    state.categories.length > 0 ||
    state.statuses.length > 0 ||
    state.hasCode !== null ||
    state.dateFrom !== "" ||
    state.dateTo !== ""
  );
}

/** A state with every facet filter cleared, keeping the query and mode. */
export function clearFilters(state: SearchState): SearchState {
  return {
    ...state,
    categories: [],
    statuses: [],
    hasCode: null,
    dateFrom: "",
    dateTo: "",
  };
}

/** Add `value` to a filter list, or remove it when already selected. */
function toggled(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

/** Add or remove a category from a state. */
export function toggleCategory(state: SearchState, category: string): SearchState {
  return { ...state, categories: toggled(state.categories, category) };
}

/** Add or remove a status from a state. */
export function toggleStatus(state: SearchState, status: string): SearchState {
  return { ...state, statuses: toggled(state.statuses, status) };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** The query parameters of a keyword request. */
export function keywordQuery(state: SearchState): QueryParams {
  const query: QueryParams = {
    q: state.q.trim(),
    limit: KEYWORD_RESULT_LIMIT,
  };
  if (state.categories.length > 0) {
    query.category = [...state.categories];
  }
  if (state.statuses.length > 0) {
    query.status = [...state.statuses];
  }
  if (state.hasCode !== null) {
    query.has_code = state.hasCode;
  }
  if (ISO_DATE.test(state.dateFrom)) {
    query.from = state.dateFrom;
  }
  if (ISO_DATE.test(state.dateTo)) {
    query.to = state.dateTo;
  }
  return query;
}

/** The query parameters of a semantic request. */
export function semanticQuery(state: SearchState): QueryParams {
  return { q: state.q.trim(), limit: SEMANTIC_RESULT_LIMIT };
}

/** A narrow interface for the shared API client, so tests can pass a stub. */
export type SearchClient = Pick<ApiClient, "get">;

/** Read one author entry; a row with no identifier is dropped. */
function parseAuthor(value: unknown): SearchAuthor | null {
  if (!isRecord(value)) {
    return null;
  }
  const did = readText(value.did) ?? readText(value.author);
  if (did === null) {
    return null;
  }
  return {
    did,
    name:
      readText(value.name) ??
      readText(value.displayName) ??
      readText(value.display_name),
  };
}

/** Read the authors of one hit, in the order the API sent them. */
function parseAuthors(value: unknown): SearchAuthor[] {
  return (Array.isArray(value) ? value : [])
    .map(parseAuthor)
    .filter((author): author is SearchAuthor => author !== null);
}

function parseHit(value: unknown): SearchResultItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = readText(value.title);
  if (title === null) {
    return null;
  }
  const authors = parseAuthors(value.authors);
  const n = readInteger(value.n) ?? 1;
  const total =
    readInteger(
      value.total ??
        value.total_versions ??
        value.totalVersions ??
        value.versions ??
        value.version_total ??
        value.versionTotal ??
        value.version_count ??
        value.versions_count ??
        value.versionCount ??
        value.versionsCount,
    ) ?? n;
  return {
    versionCid: readText(value.version_cid) ?? "",
    paperCid: readText(value.paper_cid) ?? "",
    shortId: readText(value.short_id),
    n,
    total,
    totalVersions: total,
    versions: total,
    title,
    abstract: typeof value.abstract === "string" ? value.abstract : "",
    // Older payloads carry no author list at all; keep them shape-compatible
    // until the API always sends it.
    ...(Array.isArray(value.authors) ? { authors } : {}),
    categories: readList(value.categories),
    status: readText(value.status),
    listedAt: readText(value.listed_at),
    hasCode: value.has_code === true,
    score: readNumber(value.score) ?? 0,
  };
}

function parseHits(value: unknown, label: string): SearchResultItem[] {
  if (!Array.isArray(value)) {
    throw new SearchResponseError(`The API did not return ${label}.`);
  }
  return value
    .map(parseHit)
    .filter((hit): hit is SearchResultItem => hit !== null);
}

/** Validate a `GET /v1/search` body. */
export function parseSearchResult(payload: unknown): SearchResult {
  if (!isRecord(payload)) {
    throw new SearchResponseError("The API did not return a search result.");
  }
  const raw = payload.results ?? payload.hits ?? payload.items;
  const results = parseHits(raw, "a result list");
  const facets = isRecord(payload.facets) ? payload.facets : {};
  const total = readInteger(payload.total);
  return {
    query: readText(payload.query) ?? "",
    total: total !== null && total >= 0 ? total : results.length,
    results,
    facets: {
      category: readCountMap(facets.category),
      status: readCountMap(facets.status),
    },
  };
}

/** Validate a `GET /v1/search/semantic` body. */
export function parseSemanticResult(payload: unknown): SemanticResult {
  if (!isRecord(payload)) {
    throw new SearchResponseError("The API did not return a semantic result.");
  }
  const results = parseHits(
    payload.results ?? payload.hits ?? payload.items,
    "a result list",
  );
  return {
    query: readText(payload.query) ?? "",
    embedder: readText(payload.embedder) ?? "unknown",
    results,
  };
}

/** Read one author's public name; any failure is simply "no name". */
async function loadAuthorName(
  did: string,
  client: SearchClient,
): Promise<string | null> {
  try {
    const payload = await client.get<unknown>(
      `${PROFILE_ENDPOINT}/${encodeURIComponent(did)}`,
      { cache: "no-store" },
    );
    if (!isRecord(payload) || payload.erased === true) {
      return null;
    }
    return (
      readText(payload.name) ??
      readText(payload.displayName) ??
      readText(payload.display_name)
    );
  } catch {
    return null;
  }
}

/**
 * Fill in author names the result did not carry.
 *
 * The feed does the same for `GET /v1/papers`: the API names authors by DID,
 * and `GET /v1/profiles/{did}` supplies the public display name. A DID is
 * asked for once per result page, a name already present wins without a
 * request, and a profile that is missing, erased or unreachable leaves the
 * short DID — the honest fallback after erasure (docs/design.md §2).
 */
export async function attachAuthorNames(
  results: readonly SearchResultItem[],
  client: SearchClient = api,
): Promise<SearchResultItem[]> {
  const wanted = new Set<string>();
  for (const hit of results) {
    for (const author of hit.authors ?? []) {
      if (author.name === null && author.did !== "") {
        wanted.add(author.did);
      }
    }
  }
  if (wanted.size === 0) {
    return [...results];
  }

  const names = new Map<string, string | null>();
  await Promise.all(
    [...wanted].map(async (did) => {
      names.set(did, await loadAuthorName(did, client));
    }),
  );

  return results.map((hit) => ({
    ...hit,
    authors: (hit.authors ?? []).map((author) =>
      author.name !== null
        ? author
        : { ...author, name: names.get(author.did) ?? null },
    ),
  }));
}

/** Run a keyword search through the shared API client. */
export async function loadKeywordSearch(
  state: SearchState,
  client: SearchClient = api,
): Promise<SearchResult> {
  const query = state.q.trim();
  if (query === "") {
    throw new SearchResponseError("Enter a search term.");
  }
  const payload = await client.get<unknown>(SEARCH_ENDPOINT, {
    query: keywordQuery(state),
    cache: "no-store",
  });
  const result = parseSearchResult(payload);
  return { ...result, results: await attachAuthorNames(result.results, client) };
}

/** Run a semantic search through the shared API client. */
export async function loadSemanticSearch(
  state: SearchState,
  client: SearchClient = api,
): Promise<SemanticResult> {
  const query = state.q.trim();
  if (query === "") {
    throw new SearchResponseError("Enter a search term.");
  }
  const payload = await client.get<unknown>(SEMANTIC_ENDPOINT, {
    query: semanticQuery(state),
    cache: "no-store",
  });
  const result = parseSemanticResult(payload);
  return { ...result, results: await attachAuthorNames(result.results, client) };
}

/** One plain sentence for a failed search, whichever way it failed. */
export function describeSearchError(
  error: unknown,
  mode: SearchMode = "keyword",
): string {
  if (error instanceof ApiError) {
    if (error.status === 503 && mode === "semantic") {
      return "Semantic search is unavailable right now. Try keyword search, or try again shortly.";
    }
    if (error.status === 422) {
      return (
        error.detail ||
        "That search is not valid. Check the terms and filters and try again."
      );
    }
    if (error.status === 429) {
      return "Too many searches just now. Wait a moment and try again.";
    }
    return (
      error.detail ||
      error.title ||
      "The API could not complete the search. Try again."
    );
  }
  if (error instanceof NetworkError) {
    return "Couldn’t reach the API. Check your connection and try again.";
  }
  if (error instanceof SearchResponseError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "The search could not be completed. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

/** One facet value and its count. */
export interface FacetOption {
  readonly value: string;
  readonly count: number;
}

/**
 * Facet options for a filter: every value the API counted, plus any selected
 * value the narrowed response no longer counts (so a selected checkbox is
 * always visible and can be cleared). Counted values come first, best first.
 */
export function facetOptions(
  counts: Readonly<Record<string, number>>,
  selected: readonly string[] = [],
): FacetOption[] {
  const values = new Set<string>([...Object.keys(counts), ...selected]);
  return [...values]
    .map((value) => ({ value, count: counts[value] ?? 0 }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }
      return left.value.localeCompare(right.value);
    });
}

/**
 * Status options: the reading order first (preprint, under review, …), then
 * any unrecognised status the API counted, each with its facet count.
 */
export function statusOptions(
  counts: Readonly<Record<string, number>>,
  selected: readonly string[] = [],
): FacetOption[] {
  const known = [...SEARCH_STATUSES];
  const extras = [...new Set([...Object.keys(counts), ...selected])]
    .filter((value) => !(known as readonly string[]).includes(value))
    .sort((left, right) => left.localeCompare(right));
  return [...known, ...extras].map((value) => ({
    value,
    count: counts[value] ?? 0,
  }));
}

/** The link to a result's paper page, pinned to the matched version. */
export function resultHref(hit: Pick<SearchResultItem, "shortId" | "paperCid" | "versionCid" | "n">): string {
  const id = hit.shortId ?? hit.paperCid ?? hit.versionCid;
  if (id === "") {
    return "/";
  }
  return `/p/${encodeURIComponent(id)}/v${hit.n}`;
}

/** A listing date as `16 Nov 2026` (UTC, so the day never shifts). */
export function formatListedAt(value: string | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** The count line under the search form. */
export function resultSummary(
  query: string,
  total: number,
  mode: SearchMode,
): string {
  const noun = total === 1 ? "result" : "results";
  const forQuery = query.trim() === "" ? "" : ` for “${query.trim()}”`;
  return mode === "semantic"
    ? `${total} ${noun} by meaning${forQuery}`
    : `${total} ${noun}${forQuery}`;
}
