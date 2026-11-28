/**
 * The home feed: the wire shape of `GET /v1/papers`, the
 * `/papers?tab=&category=&sort=` URL state, and the words and formats a feed
 * row uses.
 *
 * The API (plugin: catalog, feature 82) lists papers that have a listed
 * version, narrowed by a `tab` and a `category` and ordered by a `sort`:
 *
 * - `tab` — `latest` (every listed paper), `reviewed` (status `reviewed`) or
 *   `following` (papers from the categories the caller follows; plugin:
 *   follows, feature 179, and it needs a signed-in caller);
 * - `sort` — `newest`, `recently_reviewed` or `recently_updated`;
 * - `cursor` / `nextCursor` — keyset pagination, passed back unchanged.
 *
 * The response carries no vote, like or popularity field of any kind, and this
 * module never reads one: {@link parseFeedPage} copies only the fields a row
 * shows (docs/design.md §5.1: "No vote counts").
 *
 * Pure data and functions — no React — so the server route, the client
 * component and vitest share one parse, URL and fetch path. Every endpoint is
 * relative to `/v1` because the shared API client adds the prefix.
 */

import {
  ApiError,
  NetworkError,
  api,
  type ApiClient,
  type QueryParams,
} from "../../lib/api";
import { DEFAULT_CATEGORIES, type NavCategory } from "../../components/nav/categories";
import { formatDate as formatReaderDate } from "../ui-kit/format-date";

/** The route path (docs/design.md §4). */
export const FEED_PATH = "/papers";

/** Listing endpoint, relative to `/v1`. */
export const FEED_ENDPOINT = "/papers";

/** Public-profile endpoint, relative to `/v1`; one author's name lives here. */
export const PROFILE_ENDPOINT = "/profiles";

/** Papers asked for per page (the API caps at 100). */
export const FEED_PAGE_SIZE = 20;

/** The longest category the API accepts. */
const CATEGORY_MAX_CHARS = 64;

/* -------------------------------------------------------------------------- */
/* Tabs, sorts and URL state                                                   */
/* -------------------------------------------------------------------------- */

/** The three tabs of the feed, in reading order. */
export const FEED_TABS = ["latest", "reviewed", "following"] as const;

export type FeedTab = (typeof FEED_TABS)[number];

/** The word on each tab (docs/design.md §5.1). */
export const FEED_TAB_LABELS: Readonly<Record<FeedTab, string>> = {
  latest: "Latest",
  reviewed: "Reviewed",
  following: "Following",
};

/** The page's `<h1>` per tab. The mock has no visible heading, so it is read by assistive tech only. */
export const FEED_HEADINGS: Readonly<Record<FeedTab, string>> = {
  latest: "Latest papers",
  reviewed: "Reviewed papers",
  following: "Papers from categories you follow",
};

/** The sorts the API serves (docs/design.md §5.1: newest, recently reviewed, recently updated). */
export const FEED_SORTS = ["newest", "recently_reviewed", "recently_updated"] as const;

export type FeedSort = (typeof FEED_SORTS)[number];

/** The word on each sort option. */
export const FEED_SORT_LABELS: Readonly<Record<FeedSort, string>> = {
  newest: "Newest",
  recently_reviewed: "Recently reviewed",
  recently_updated: "Recently updated",
};

/** Every knob of one feed view, as the URL carries it. */
export interface FeedState {
  readonly tab: FeedTab;
  /** An exact category such as `cs.AI`; empty means every category. */
  readonly category: string;
  readonly sort: FeedSort;
}

/** The feed as a first visit sees it. */
export const DEFAULT_FEED_STATE: FeedState = {
  tab: "latest",
  category: "",
  sort: "newest",
};

/** Next.js `searchParams` shape (`?category=a&category=b` arrives as an array). */
export type FeedParamsInput = Record<string, string | readonly string[] | undefined>;

function firstValue(value: string | readonly string[] | undefined): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

/** Narrow text to one of a fixed list, or `undefined`. */
function oneOf<T extends string>(list: readonly T[], text: string): T | undefined {
  const wanted = text.trim().toLowerCase();
  return list.find((item) => item === wanted);
}

/**
 * Read `/papers?tab=…&category=…&sort=…`.
 *
 * Anything the page does not understand falls back to its default instead of
 * becoming a request the API would answer with a `422`: an unknown tab or
 * sort, or a category longer than the API accepts. Only the first value of a
 * repeated parameter is used.
 */
export function parseFeedParams(input: FeedParamsInput = {}): FeedState {
  const category = firstValue(input.category).trim();
  return {
    tab: oneOf(FEED_TABS, firstValue(input.tab)) ?? DEFAULT_FEED_STATE.tab,
    category: category.length <= CATEGORY_MAX_CHARS ? category : "",
    sort: oneOf(FEED_SORTS, firstValue(input.sort)) ?? DEFAULT_FEED_STATE.sort,
  };
}

/**
 * `/papers?tab=…` for a state — the one place the feed URL is built.
 *
 * Defaults are left out, so the first visit is the bare `/papers` and a link
 * reads as short as it can.
 */
export function feedHref(state: FeedState, path: string = FEED_PATH): string {
  const params = new URLSearchParams();
  if (state.tab !== DEFAULT_FEED_STATE.tab) {
    params.set("tab", state.tab);
  }
  if (state.category.trim() !== "") {
    params.set("category", state.category.trim());
  }
  if (state.sort !== DEFAULT_FEED_STATE.sort) {
    params.set("sort", state.sort);
  }
  const suffix = params.toString();
  return suffix === "" ? path : `${path}?${suffix}`;
}

/** A stable identity for a view, used to decide whether a new request is needed. */
export function feedStateKey(state: FeedState): string {
  return JSON.stringify([state.tab, state.category.trim(), state.sort]);
}

/* -------------------------------------------------------------------------- */
/* Wire shape                                                                  */
/* -------------------------------------------------------------------------- */

/** One author of a row, in byline order. */
export interface FeedAuthor {
  readonly did: string;
  /** A display name when the API supplies one; the list carries DIDs only today. */
  readonly name: string | null;
  readonly position: number;
}

/** One paper of the feed: the list-row view of its listed version. */
export interface FeedItem {
  /** `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  readonly paperCid: string;
  readonly versionCid: string;
  /** The version shown (1-based). */
  readonly n: number;
  readonly title: string;
  readonly abstract: string;
  readonly authors: readonly FeedAuthor[];
  readonly categories: readonly string[];
  /** The paper's stored status (`preprint`, `reviewed`, …), or `null`. */
  readonly status: string | null;
  /** When the paper first appeared in the catalog (ISO 8601, UTC). */
  readonly listedAt: string | null;
  /** When a version of the paper was most recently listed (ISO 8601, UTC). */
  readonly updatedAt: string | null;
}

/** One page of the feed. */
export interface FeedPageData {
  readonly items: readonly FeedItem[];
  /** Pass back as the cursor for the next page; `null` on the last page. */
  readonly nextCursor: string | null;
}

/** Raised when the API answers with something that is not a paper list. */
export class FeedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) {
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

function parseAuthor(value: unknown, index: number): FeedAuthor | null {
  if (!isRecord(value)) {
    return null;
  }
  const did = readText(value.did) ?? readText(value.author);
  if (did === null) {
    return null;
  }
  return {
    did,
    name: readText(value.name) ?? readText(value.displayName) ?? readText(value.display_name),
    position: readInteger(value.position) ?? index + 1,
  };
}

function parseItem(value: unknown): FeedItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = readText(value.title);
  const shortId = readText(value.shortId) ?? readText(value.paper) ?? "";
  const paperCid = readText(value.paperCid) ?? "";
  const versionCid = readText(value.versionCid) ?? readText(value.cid) ?? "";
  // A row with no title or nothing to link to is of no use to a reader.
  if (title === null || (shortId === "" && paperCid === "" && versionCid === "")) {
    return null;
  }
  const authors = (Array.isArray(value.authors) ? value.authors : [])
    .map(parseAuthor)
    .filter((author): author is FeedAuthor => author !== null)
    .sort((left, right) => left.position - right.position);
  return {
    shortId,
    paperCid,
    versionCid,
    n: readInteger(value.n) ?? readInteger(value.version) ?? 1,
    title,
    abstract: typeof value.abstract === "string" ? value.abstract.trim() : "",
    authors,
    categories: readList(value.categories),
    status: readText(value.status),
    listedAt: readText(value.listedAt),
    updatedAt: readText(value.updatedAt),
  };
}

/**
 * Validate a `GET /v1/papers` body.
 *
 * A body that is not a list is an error, never an empty feed: an empty feed
 * would say "nothing is listed" when the truth is "we don't know". Items
 * without a title or any id are dropped.
 */
export function parseFeedPage(payload: unknown): FeedPageData {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new FeedResponseError("The API did not return a list of papers.");
  }
  return {
    items: payload.items
      .map(parseItem)
      .filter((item): item is FeedItem => item !== null),
    nextCursor: readText(payload.nextCursor),
  };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** The query parameters of one page request. */
export function feedQuery(state: FeedState, cursor?: string | null): QueryParams {
  const query: QueryParams = {
    tab: state.tab,
    sort: state.sort,
    limit: FEED_PAGE_SIZE,
  };
  if (state.category.trim() !== "") {
    query.category = state.category.trim();
  }
  if (cursor) {
    query.cursor = cursor;
  }
  return query;
}

/** A narrow interface for the shared API client, so tests can pass a stub. */
export type FeedClient = Pick<ApiClient, "get">;

/** The part of one author's public profile a row shows. */
export interface FeedProfile {
  readonly name: string | null;
}

/**
 * Validate a `GET /v1/profiles/{did}` body.
 *
 * Only the public name matters to a row. `erased: true` means the person
 * asked for erasure, so a stale personal field in the body is ignored.
 */
export function parseFeedProfile(payload: unknown): FeedProfile {
  if (!isRecord(payload)) {
    return { name: null };
  }
  return {
    name:
      payload.erased === true
        ? null
        : readText(payload.name) ??
          readText(payload.displayName) ??
          readText(payload.display_name),
  };
}

/** Read one author's public name; any failure is simply "no name". */
async function loadFeedProfileName(
  did: string,
  client: FeedClient,
): Promise<string | null> {
  try {
    const payload = await client.get<unknown>(
      `${PROFILE_ENDPOINT}/${encodeURIComponent(did)}`,
      { cache: "no-store" },
    );
    return parseFeedProfile(payload).name;
  } catch {
    return null;
  }
}

/**
 * Fill in author names the list did not carry.
 *
 * `GET /v1/papers` names authors by DID only, so each row pairs them with
 * `GET /v1/profiles/{did}` (plugin: profiles, feature 29). A DID is asked for
 * once per page however many papers cite it, a name the list already supplied
 * wins without a request, and a profile that is missing, erased or unreachable
 * leaves the short DID — the honest fallback after erasure (docs/design.md §2).
 */
export async function attachAuthorNames(
  page: FeedPageData,
  client: FeedClient = api,
): Promise<FeedPageData> {
  const wanted = new Set<string>();
  for (const item of page.items) {
    for (const author of item.authors) {
      if (author.name === null && author.did !== "") {
        wanted.add(author.did);
      }
    }
  }
  if (wanted.size === 0) {
    return page;
  }

  const names = new Map<string, string | null>();
  await Promise.all(
    [...wanted].map(async (did) => {
      names.set(did, await loadFeedProfileName(did, client));
    }),
  );

  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      authors: item.authors.map((author) =>
        author.name !== null
          ? author
          : { ...author, name: names.get(author.did) ?? null },
      ),
    })),
  };
}

/**
 * Load one page of the feed through the shared API client.
 *
 * Reading the catalog is public, but the client still attaches the caller's
 * token when it has one, which is how the `following` tab knows whose
 * follows to list. `no-store`: the feed changes as papers are listed.
 */
export async function loadFeedPage(
  state: FeedState,
  cursor?: string | null,
  client: FeedClient = api,
): Promise<FeedPageData> {
  const payload = await client.get<unknown>(FEED_ENDPOINT, {
    query: feedQuery(state, cursor),
    cache: "no-store",
  });
  return attachAuthorNames(parseFeedPage(payload), client);
}

/** One plain sentence for a failed load, whichever way it failed. */
export function describeFeedError(error: unknown, tab: FeedTab = "latest"): string {
  if (error instanceof ApiError) {
    if (error.status === 401 && tab === "following") {
      return "Sign in to see papers from the categories you follow.";
    }
    if (error.status === 422 && tab === "following") {
      return "Following is not available on this node yet.";
    }
    if (error.status === 429) {
      return "Too many requests just now. Wait a moment and try again.";
    }
    if (!error.problem.detail && [502, 503, 504].includes(error.status)) {
      return "Papers are temporarily unavailable. Please try again in a moment.";
    }
    return error.detail || error.title || "The API could not load the feed. Try again.";
  }
  if (error instanceof NetworkError) {
    return "Couldn’t reach the API. Check your connection and try again.";
  }
  if (error instanceof FeedResponseError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "The feed could not be loaded. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The link to a paper's page: `/p/k3f9-q2xz-7mwd`.
 *
 * Paper URLs drop the `sch:` prefix (docs/design.md §4). The page shows the
 * latest listed version, which is the version the row shows.
 */
export function paperHref(item: Pick<FeedItem, "shortId" | "paperCid" | "versionCid">): string {
  const id = item.shortId.replace(/^sch:/, "") || item.paperCid || item.versionCid;
  return `/p/${encodeURIComponent(id)}`;
}

/** The link to a category page (`/c/cs.AI`, docs/design.md §4). */
export function categoryPath(category: string): string {
  return `/c/${encodeURIComponent(category)}`;
}

/** Identity of an item, for keys and for dropping a repeat across pages. */
export function itemKey(item: Pick<FeedItem, "shortId" | "paperCid" | "versionCid" | "title">): string {
  return item.paperCid || item.shortId || item.versionCid || item.title;
}

/** Append a page to the items already shown, skipping papers already listed. */
export function appendItems(
  shown: readonly FeedItem[],
  more: readonly FeedItem[],
): FeedItem[] {
  const seen = new Set(shown.map(itemKey));
  const added: FeedItem[] = [];
  for (const item of more) {
    const key = itemKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      added.push(item);
    }
  }
  return [...shown, ...added];
}

/** `z6Mkha…2doK` for `did:key:z6MkhaXg…2doK`: enough to tell authors apart. */
export function shortDid(did: string): string {
  const id = did.trim().split(":").pop() ?? "";
  if (id === "") {
    return "Unknown author";
  }
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** The name a reader sees for an author: the display name, else the short DID. */
export function authorLabel(author: Pick<FeedAuthor, "did" | "name">): string {
  return author.name ?? shortDid(author.did);
}

/** The byline of a row. */
export interface AuthorLine {
  /** The names shown, in byline order. */
  readonly shown: readonly string[];
  /** How many more authors there are, for the `+N`. */
  readonly more: number;
  /** Every author's name, for a tooltip. */
  readonly all: readonly string[];
}

/** Authors shown in full up to this many. */
const MAX_FULL_BYLINE = 3;
/** Beyond that, the first this many are named and the rest counted. */
const NAMED_WHEN_TRUNCATED = 2;

/**
 * `M. Zhang, A. Okafor, +2` (docs/design.md §5.1): up to three authors are
 * named; four or more name the first two and count the rest.
 */
export function authorLine(authors: readonly Pick<FeedAuthor, "did" | "name">[]): AuthorLine {
  const all = authors.map(authorLabel);
  if (all.length <= MAX_FULL_BYLINE) {
    return { shown: all, more: 0, all };
  }
  return {
    shown: all.slice(0, NAMED_WHEN_TRUNCATED),
    more: all.length - NAMED_WHEN_TRUNCATED,
    all,
  };
}

/* -------------------------------------------------------------------------- */
/* Age                                                                         */
/* -------------------------------------------------------------------------- */

const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An API timestamp as an instant.
 *
 * The API serialises UTC datetimes without a zone (`2026-01-01T00:00:00`), and
 * `new Date()` would read that as the *browser's* local time, shifting every
 * age by the viewer's offset. A timestamp with no zone is UTC.
 */
export function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const text = value.trim();
  const hasTime = text.includes("T") || text.includes(" ");
  const iso = hasTime && !TIMEZONE_SUFFIX.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * How long before `now` an instant was: `5 hours ago`, `3 days ago`.
 *
 * A moment in the future (the node's clock a little ahead of the browser's)
 * reads as `just now` rather than a negative age.
 */
export function formatAge(from: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - from.getTime()) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return plural(Math.max(minutes, 1), "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return plural(hours, "hour");
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return plural(days, "day");
  }
  if (days < 365) {
    return plural(Math.floor(days / 30), "month");
  }
  return plural(Math.floor(days / 365), "year");
}

/**
 * A date as `2 Mar 2027`, in the reader's own time zone: the feed row, the
 * profile's review date and the paper's Versions tab must name the same day
 * for the same instant (bug_spec_verify12 bug 2). A value explicitly labelled
 * `UTC` is written with the same helper's `{ timeZone: "UTC" }` option.
 */
export function formatDate(date: Date): string {
  return formatReaderDate(date) ?? "";
}

/** The age shown on a row. */
export interface RowAge {
  /** `3 days ago`. */
  readonly label: string;
  /** The instant, for `<time datetime>`. */
  readonly dateTime: string;
  /** `Listed 2 Mar 2027`, for a tooltip. */
  readonly title: string;
}

/**
 * The age of a row, in step with the order it is listed in: `recently_updated`
 * counts from when a version was last listed, every other sort from when the
 * paper first appeared. A missing timestamp falls back to the other one.
 */
export function rowAge(
  item: Pick<FeedItem, "listedAt" | "updatedAt">,
  sort: FeedSort,
  now: Date,
): RowAge | null {
  const listed = { verb: "Listed", moment: parseInstant(item.listedAt) };
  const updated = { verb: "Updated", moment: parseInstant(item.updatedAt) };
  const order = sort === "recently_updated" ? [updated, listed] : [listed, updated];
  const pick = order.find((candidate) => candidate.moment !== null);
  if (pick === undefined || pick.moment === null) {
    return null;
  }
  return {
    label: formatAge(pick.moment, now),
    dateTime: pick.moment.toISOString(),
    title: `${pick.verb} ${formatDate(pick.moment)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

/** One entry of the category selector. */
export interface CategoryChoice {
  readonly id: string;
  /** What the option reads: `cs.AI · Artificial Intelligence`, or just the id. */
  readonly label: string;
}

/**
 * The category selector's options: the launch taxonomy first (the same list
 * the nav's Categories menu offers), then every other category seen in a
 * paper or chosen in the URL, in alphabetical order. A chosen category is
 * always present, so a link to `/papers?category=astro-ph.HE` shows what it
 * filters.
 */
export function categoryChoices(
  seen: readonly string[] = [],
  selected: string = "",
  taxonomy: readonly NavCategory[] = DEFAULT_CATEGORIES,
): CategoryChoice[] {
  const known = new Map(taxonomy.map((category) => [category.id, category.label]));
  const extras = new Set<string>();
  for (const id of [...seen, selected]) {
    const text = id.trim();
    if (text !== "" && !known.has(text)) {
      extras.add(text);
    }
  }
  return [
    ...taxonomy.map((category) => ({
      id: category.id,
      label: `${category.id} · ${category.label}`,
    })),
    ...[...extras]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, label: id })),
  ];
}

/** Every category the items carry, de-duplicated, in first-seen order. */
export function categoriesOf(items: readonly Pick<FeedItem, "categories">[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const category of item.categories) {
      seen.add(category);
    }
  }
  return [...seen];
}

/** Where `/signin` should send a visitor back to: the feed view they were on. */
export function signInHref(state: FeedState): string {
  return `/signin?next=${encodeURIComponent(feedHref(state))}`;
}

/** The one sentence an empty view says, and a word for the category when one is chosen. */
export function emptyFeedSentence(state: FeedState): string {
  const where = state.category.trim() === "" ? "" : ` in ${state.category.trim()}`;
  switch (state.tab) {
    case "reviewed":
      return `No reviewed papers${where} yet.`;
    case "following":
      return state.category.trim() === ""
        ? "No papers from the categories you follow yet. Open a category and choose Follow."
        : `No papers${where} from the categories you follow yet.`;
    default:
      return `No papers are listed${where} yet.`;
  }
}
