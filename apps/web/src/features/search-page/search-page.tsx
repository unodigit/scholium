"use client";

/**
 * `/search?q=` — keyword and semantic search over listed versions.
 *
 * The page has three parts (docs/design.md §4 and §5.1):
 *
 * - a search field that rewrites `?q=`;
 * - a Keyword / Semantic switch — semantic calls `GET /v1/search/semantic`,
 *   which ranks by meaning instead of matching words;
 * - facet filters for **category**, **date listed**, **status** and **code
 *   available**, carried in the URL as `category`, `from`/`to`, `status` and
 *   `has_code` so a result view can be shared or reloaded.
 *
 * The server route fetches the first page through the same functions and
 * passes `initialResult`, so the first HTML response already contains the
 * results (and works without JavaScript). Every later change (a filter, a
 * toggle, a new term) is answered by this component: it rewrites the URL with
 * the native History API — a shallow update Next.js supports — and fetches
 * the new result itself. That keeps the search fast and the back button
 * working: a `popstate` listener adopts whatever state the browser returns to.
 *
 * The semantic endpoint takes only `q`, so the facet filters are disabled in
 * semantic mode and the page says so rather than pretending to apply them.
 *
 * A `sch:xxxx-xxxx-xxxx` (or `/vN`) term is not a search at all: it addresses
 * one paper, so submitting it navigates to that paper's page instead of
 * rewriting `?q=`. `paperHrefForQuery` owns that decision, and the server
 * route performs the same redirect for a shared link or the nav's GET form.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import { StatusChip, isPaperStatus } from "../ui-kit";
import { toDate } from "../ui-kit/format-date";
import { LocalDate } from "../ui-kit/local-date";
import { profilePath } from "../dashboard/profile";
import { authorLabel, authorLine } from "../feed/feed";
import { SaveSearchButton, type SaveSearchButtonProps } from "./save-search-button";
import {
  EMPTY_SEARCH_STATE,
  SEARCH_PATH,
  clearFilters,
  describeSearchError,
  facetOptions,
  hasActiveFilters,
  loadKeywordSearch,
  loadSemanticSearch,
  paperHrefForQuery,
  parseSearchParams,
  resultHref,
  resultSummary,
  searchHref,
  searchStateKey,
  statusOptions,
  toggleCategory,
  toggleStatus,
  type FacetCounts,
  type SearchResult,
  type SearchResultItem,
  type SearchState,
  type SemanticResult,
} from "./search";
import "./search-page.css";

/**
 * Fired on `window` after the search page rewrites the address bar for a
 * `/search` URL (push or replace). The header's search box listens for it so
 * its field follows a search typed in the page's own box. The same string is
 * duplicated in `components/nav/global-nav.tsx` (the nav does not import from
 * features/); keep the two in sync.
 */
export const SEARCH_URL_CHANGED_EVENT = "scholium:search-url-changed";

/** Loads a keyword result; replaceable in tests. */
export type LoadKeywordSearch = (state: SearchState) => Promise<SearchResult>;

/** Loads a semantic result; replaceable in tests. */
export type LoadSemanticSearch = (state: SearchState) => Promise<SemanticResult>;

/** How a URL update should treat browser history. */
export type UrlUpdateMode = "push" | "replace";

/** Rewrites the address bar; replaceable in tests or a host router. */
export type UpdateUrl = (href: string, mode: UrlUpdateMode) => void;

/** Props for {@link SearchPage}. Everything is optional. */
export interface SearchPageProps {
  /** State read from the route's `searchParams` by the server. */
  initialState?: SearchState;
  /** First page fetched by the server, so the first paint has results. */
  initialResult?: SearchResult | SemanticResult;
  /** Failure message from the server-side fetch; the page retries in the browser. */
  initialError?: string;
  /** Replace the keyword loader, for tests or an alternate API client. */
  loadKeyword?: LoadKeywordSearch;
  /** Replace the semantic loader, for tests or an alternate API client. */
  loadSemantic?: LoadSemanticSearch;
  /** Replace the URL update, for tests. */
  updateUrl?: UpdateUrl;
  /**
   * Pin the sign-in state for the Save control. When omitted it is read from
   * the shared token store.
   */
  signedIn?: boolean;
  /** Replace the save call, for tests or an alternate API client. */
  saveSearch?: SaveSearchButtonProps["save"];
}

type SearchView =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly key: string }
  | {
      readonly status: "ready";
      readonly key: string;
      readonly result: SearchResult | SemanticResult;
    }
  | { readonly status: "error"; readonly key: string; readonly message: string };

/** Whether `href` is the search page itself (with or without a query string). */
function isSearchHref(href: string): boolean {
  return href === SEARCH_PATH || href.startsWith(`${SEARCH_PATH}?`);
}

/**
 * Rewrite the address bar.
 *
 * A change *within* `/search` is a shallow update Next.js understands, so the
 * results client keeps its state and the back button works. A hop to another
 * route — the paper page a `sch:` id names — is a real navigation: only the
 * browser (or the router injected in tests) can render that page.
 */
export function defaultUpdateUrl(href: string, mode: UrlUpdateMode): void {
  if (typeof window === "undefined") {
    return;
  }
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === href) {
    return;
  }
  try {
    if (!isSearchHref(href)) {
      // `replace` for an id that arrived in the URL (Back leaves the search
      // rather than bouncing off the same redirect); `assign` for a fresh
      // submission (Back returns to the search the reader was on).
      if (mode === "replace") {
        window.location.replace(href);
      } else {
        window.location.assign(href);
      }
      return;
    }
    if (mode === "push") {
      window.history.pushState(null, "", href);
    } else {
      window.history.replaceState(null, "", href);
    }
    // Tell the header search box (and any other listener) that the address
    // bar's `?q=` moved. Only `/search` URLs reach this branch; a hop to a
    // paper page is a real navigation and needs no announcement. Dispatch
    // after the history write so listeners read the new URL.
    window.dispatchEvent(new Event(SEARCH_URL_CHANGED_EVENT));
  } catch {
    // History may be unavailable (sandboxed frame); local state still works.
  }
}

function isResults(result: SearchResult | SemanticResult): result is SearchResult {
  return "facets" in result;
}

function initialView(
  state: SearchState,
  result: SearchResult | SemanticResult | undefined,
  error: string | undefined,
): SearchView {
  if (state.q.trim() === "") {
    return { status: "idle" };
  }
  const key = searchStateKey(state);
  if (error !== undefined) {
    return { status: "error", key, message: error };
  }
  if (result !== undefined) {
    return { status: "ready", key, result };
  }
  return { status: "loading", key };
}

/** Human label for a status value (`under_review` → `Under review`). */
function statusValueLabel(status: string): string {
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The empty facet counts shown before the first keyword answer. */
const NO_FACETS: FacetCounts = { category: {}, status: {} };

/**
 * The last answer on screen, and the query text and mode it answers.
 *
 * While the next answer for the *same* query loads (a filter tick or untick)
 * the page keeps showing this one, so the results list and the facet column do
 * not collapse and re-expand — a scrolled page keeps its height instead of
 * jumping. A different query text or a mode change makes it unusable: it
 * describes another search.
 */
interface AnswerSnapshot {
  /** Query text and mode, as {@link queryKeyOf} renders them. */
  readonly query: string;
  readonly result: SearchResult | SemanticResult;
}

/** The identity of a query, without its filters. */
function queryKeyOf(state: SearchState): string {
  return `${state.q.trim()}\u0000${state.mode}`;
}

/** Search page with results, facet filters and a semantic toggle. */
export function SearchPage({
  initialState = EMPTY_SEARCH_STATE,
  initialResult,
  initialError,
  loadKeyword,
  loadSemantic,
  updateUrl,
  signedIn,
  saveSearch,
}: SearchPageProps = {}) {
  const [state, setState] = useState<SearchState>(initialState);
  const [draft, setDraft] = useState(initialState.q);
  const [view, setView] = useState<SearchView>(() =>
    initialView(initialState, initialResult, initialError),
  );
  const [attempt, setAttempt] = useState(0);
  // The last answer on screen for the current query text and mode. It stays
  // rendered while the next answer for the same query loads (stale-while-
  // loading), so a filter tick neither collapses the results list nor the
  // facet column; a different query text or mode starts over (see `kept`).
  const [lastAnswer, setLastAnswer] = useState<AnswerSnapshot | null>(() =>
    view.status === "ready"
      ? { query: queryKeyOf(initialState), result: view.result }
      : null,
  );
  // The key of the request already answered or in flight. A ref rather than
  // state so the fetch effect can tell "same search" from "new search"
  // without depending on `view` and re-running in a loop.
  const requestedRef = useRef<string | null>(
    view.status === "ready" || view.status === "error" ? view.key : null,
  );
  // The latest state, for effects that compare the route with it without
  // taking `state` as a dependency (which would re-run on every filter).
  const stateRef = useRef(state);
  stateRef.current = state;

  // The address bar seen at mount and at the last route adoption. A Back,
  // Forward or router navigation moves it; comparing it with the route's
  // `initialState` distinguishes a fresh render of the URL from one that
  // still carries the search the page was first loaded with — which is what
  // the router hands down for a `pushState` history entry. The URL, not the
  // props, describes the entry the reader returned to.
  const lastUrlRef = useRef<string | null>(null);
  // Skip the URL check on the very first mount: the server's `initialState`
  // is authoritative there, and jsdom (and any host that renders without a
  // matching address bar) must not be overridden by `window.location`.
  const mountedRef = useRef(false);

  const navigate = updateUrl ?? defaultUpdateUrl;

  const apply = useCallback(
    (next: SearchState, history: UrlUpdateMode) => {
      setState(next);
      navigate(searchHref(next), history);
    },
    [navigate],
  );

  // The global nav (and a browser back/forward) can change `?q=` without
  // remounting this component; adopt the route's state when it moves.
  const routeKey = searchStateKey(initialState);
  useEffect(() => {
    // On the first mount the server's props are authoritative; do not let a
    // stale address bar (jsdom, or a host that renders without a matching URL)
    // override them.
    const firstMount = !mountedRef.current;
    mountedRef.current = true;

    let desiredState = initialState;
    let desiredResult = initialResult;
    let desiredError = initialError;
    let staleOverride = false;

    if (typeof window !== "undefined") {
      const urlSearch = window.location.search;
      if (firstMount || lastUrlRef.current === null) {
        // Remember the address bar the server's props came from, so a later
        // move (Back, Forward, a router navigation) is visible here.
        lastUrlRef.current = urlSearch;
      } else {
        const urlMoved = urlSearch !== lastUrlRef.current;
        lastUrlRef.current = urlSearch;

        // A back/forward leaves the address bar on the entry the reader
        // returned to, but the router may re-render this page with the search
        // it was first loaded with — the RSC payload it holds for `/search`.
        // When the address bar has moved and does not describe the route's
        // props, the URL wins: parse it and fetch its answer instead of
        // trusting the stale props. When they agree (a header search, or a
        // fresh render of the returned entry), keep the route's result so no
        // extra fetch is made. Comparing the address bar itself, rather than
        // a popstate flag, does not depend on listener order or on when the
        // router's re-render happens to commit.
        if (urlMoved) {
          const params: Record<string, string[]> = {};
          new URLSearchParams(urlSearch).forEach((value, key) => {
            (params[key] ??= []).push(value);
          });
          const urlState = parseSearchParams(params);
          if (searchStateKey(urlState) !== routeKey) {
            desiredState = urlState;
            desiredResult = undefined;
            desiredError = undefined;
            staleOverride = true;
          }
        }
      }
    }

    const desiredKey = searchStateKey(desiredState);
    const currentKey = searchStateKey(stateRef.current);

    // If the route hands us a fresh server answer for the search already on
    // screen (a forward/back to a header-loaded entry), adopt it without a
    // client fetch, but only on a subsequent render.
    if (
      !firstMount &&
      !staleOverride &&
      (initialResult !== undefined || initialError !== undefined) &&
      desiredKey === currentKey &&
      requestedRef.current !== desiredKey
    ) {
      const next = initialView(desiredState, desiredResult, desiredError);
      requestedRef.current =
        next.status === "ready" || next.status === "error" ? next.key : null;
      setView(next);
      return;
    }

    if (desiredKey === currentKey) {
      return;
    }

    setState(desiredState);
    setDraft(desiredState.q);
    const next = initialView(desiredState, desiredResult, desiredError);
    requestedRef.current =
      next.status === "ready" || next.status === "error" ? next.key : null;
    setView(next);
    // `routeKey` is the identity of `initialState`; the other initial props
    // always arrive with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  // Back/forward: the address bar changed without a render. Parse it back into
  // state; the fetch effect below answers the new search.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onPopState = (): void => {
      const params: Record<string, string[]> = {};
      new URLSearchParams(window.location.search).forEach((value, key) => {
        (params[key] ??= []).push(value);
      });
      const next = parseSearchParams(params);
      if (searchStateKey(next) === searchStateKey(stateRef.current)) {
        return;
      }
      setState(next);
      setDraft(next.q);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const key = searchStateKey(state);
  // A `sch:` id in the field addresses a paper, not a keyword search. The
  // paper page owns what happens next; the search page's job is to take the
  // reader there, including when the id arrived in a shared `?q=` link.
  const paperTarget = paperHrefForQuery(state.q);

  useEffect(() => {
    const target = paperHrefForQuery(state.q);
    if (target !== null) {
      // Nothing to search for: stop here and hand the id to the paper page.
      requestedRef.current = "";
      setView({ status: "idle" });
      navigate(target, "replace");
      return;
    }
    if (state.q.trim() === "") {
      requestedRef.current = "";
      setView({ status: "idle" });
      return;
    }
    if (requestedRef.current === key) {
      return;
    }
    requestedRef.current = key;

    let cancelled = false;
    setView({ status: "loading", key });
    const load =
      state.mode === "semantic"
        ? loadSemantic ?? loadSemanticSearch
        : loadKeyword ?? loadKeywordSearch;

    load(state).then(
      (result) => {
        if (!cancelled) {
          setView({ status: "ready", key, result });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setView({
            status: "error",
            key,
            message: describeSearchError(error, state.mode),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
    // `key` folds the query, the mode and every filter into one value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  // Remember each answer with the query it answers, so the next request on the
  // same query text and mode can keep showing it while it loads.
  useEffect(() => {
    if (view.status === "ready" && view.key === key) {
      setLastAnswer({ query: queryKeyOf(state), result: view.result });
    }
    // `state` is read for the query identity only; the guard above decides
    // whether the view is the answer to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, key, state.q, state.mode]);

  const retry = useCallback(() => {
    requestedRef.current = null;
    setAttempt((count) => count + 1);
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const query = draft.trim();
    // Pasting a `sch:` id is a jump to that paper (feature 184). The default
    // URL update turns this into a real navigation; a test or host router
    // receives the same href through `updateUrl`.
    const target = paperHrefForQuery(query);
    if (target !== null) {
      navigate(target, "push");
      return;
    }
    apply({ ...state, q: query }, "push");
  };

  const chooseMode = (mode: SearchState["mode"]): void => {
    if (mode !== state.mode) {
      apply({ ...state, mode }, "push");
    }
  };

  const onDateChange = (
    field: "dateFrom" | "dateTo",
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    apply({ ...state, [field]: event.target.value }, "replace");
  };

  const semantic = state.mode === "semantic";
  const filtersDisabled = semantic;
  // Whether the answer in `view` answers the state on screen. A filter step
  // repaints once with the previous answer before the fetch effect marks the
  // new request loading; both that paint and the loading one count as
  // awaiting, so nothing collapses in between.
  const answeredNow = view.status === "ready" && view.key === key;
  const awaitingAnswer =
    view.status === "loading" || (view.status === "ready" && !answeredNow);
  // While the next answer for the same query text and mode loads, the previous
  // answer stays on screen (stale-while-loading): the list keeps its rows and
  // the column its counts, so a scrolled page neither shortens nor jumps. A
  // new query text or mode never reuses another search's answer.
  const queryId = queryKeyOf(state);
  const kept =
    awaitingAnswer && lastAnswer !== null && lastAnswer.query === queryId
      ? lastAnswer.result
      : undefined;
  // The answer to render: the current one, or the one kept while its
  // successor loads. The kept one is marked busy and de-emphasised.
  const shown = answeredNow ? view.result : kept;
  const updating = !answeredNow && kept !== undefined;
  // The facet column reads the answer to the state on screen. The API counts
  // each facet over the matches that pass every filter except that facet's
  // own, so these counts are exactly what ticking a value would return. While
  // the next answer for the same query text and mode loads, the previous
  // answer's values and counts stay listed instead of collapsing to the
  // selected values; a different query or mode never borrows another search's
  // counts.
  const ready = answeredNow ? view.result : undefined;
  const retainedFacets =
    kept !== undefined && isResults(kept) ? kept.facets : undefined;
  const facets =
    ready !== undefined && isResults(ready)
      ? ready.facets
      : retainedFacets ?? NO_FACETS;
  const results = shown?.results ?? [];
  // Only a search with no answer to keep falls back to "Searching…".
  const searching = awaitingAnswer && shown === undefined;
  const categoryChoices = facetOptions(facets.category, state.categories);
  // `statusOptions` lists every known status; here a status the answer does
  // not count is offered only when it is selected, since ticking it would
  // return nothing.
  const statusChoices = statusOptions(facets.status, state.statuses).filter(
    (choice) => choice.count > 0 || state.statuses.includes(choice.value),
  );
  const showClear = hasActiveFilters(state);

  return (
    <div className="sp-page">
      <header className="sp-header">
        <p className="sp-kicker">Listed papers</p>
        <h1 className="sp-title">Search</h1>
        <p className="sp-lede">
          Find papers by title, abstract or full text across every category this
          node lists.
        </p>

        <form className="sp-search" role="search" onSubmit={onSubmit}>
          <label className="sp-search-label" htmlFor="sp-q">
            Search papers
          </label>
          <div className="sp-search-row">
            <input
              id="sp-q"
              className="sp-search-input"
              type="search"
              name="q"
              value={draft}
              placeholder="Title, abstract or keyword…"
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="sp-search-button">
              Search
            </button>
          </div>
        </form>

        <div className="sp-modes" role="group" aria-label="Search mode">
          <button
            type="button"
            className={semantic ? "sp-mode" : "sp-mode sp-mode--active"}
            aria-pressed={!semantic}
            onClick={() => chooseMode("keyword")}
          >
            Keyword
          </button>
          <button
            type="button"
            className={semantic ? "sp-mode sp-mode--active" : "sp-mode"}
            aria-pressed={semantic}
            onClick={() => chooseMode("semantic")}
          >
            Semantic
          </button>
        </div>
        <p className="sp-mode-hint">
          {semantic
            ? "Semantic search ranks listed papers by meaning, not by the words you type."
            : "Keyword search matches the words you type in a paper’s title, abstract and text."}
        </p>

        <SaveSearchButton
          state={state}
          signedIn={signedIn}
          save={saveSearch}
        />
      </header>

      <div className="sp-layout">
        <aside className="sp-filters" aria-label="Search filters">
          {semantic ? (
            <p className="sp-filters-note" id="sp-filters-note">
              Facet filters apply to keyword search.
            </p>
          ) : null}

          <fieldset
            className="sp-filter-group"
            disabled={filtersDisabled}
            aria-busy={awaitingAnswer}
          >
            <legend className="sp-filter-legend">Category</legend>
            {categoryChoices.length === 0 ? (
              <p className="sp-filter-none">Categories appear with results.</p>
            ) : (
              <ul className="sp-filter-list">
                {categoryChoices.map((choice) => {
                  const id = `sp-category-${choice.value}`;
                  return (
                    <li key={choice.value}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={state.categories.includes(choice.value)}
                        onChange={() => apply(toggleCategory(state, choice.value), "replace")}
                      />
                      <label htmlFor={id}>
                        <span className="sp-filter-value">{choice.value}</span>
                        {choice.count > 0 ? (
                          <span className="sp-filter-count">{choice.count}</span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <fieldset
            className="sp-filter-group"
            disabled={filtersDisabled}
            aria-busy={awaitingAnswer}
          >
            <legend className="sp-filter-legend">Date listed</legend>
            <div className="sp-date-row">
              <label className="sp-date-field">
                <span>From</span>
                <input
                  type="date"
                  value={state.dateFrom}
                  max={state.dateTo || undefined}
                  onChange={(event) => onDateChange("dateFrom", event)}
                />
              </label>
              <label className="sp-date-field">
                <span>To</span>
                <input
                  type="date"
                  value={state.dateTo}
                  min={state.dateFrom || undefined}
                  onChange={(event) => onDateChange("dateTo", event)}
                />
              </label>
            </div>
          </fieldset>

          <fieldset
            className="sp-filter-group"
            disabled={filtersDisabled}
            aria-busy={awaitingAnswer}
          >
            <legend className="sp-filter-legend">Status</legend>
            {statusChoices.length === 0 ? (
              <p className="sp-filter-none">Statuses appear with results.</p>
            ) : (
              <ul className="sp-filter-list">
                {statusChoices.map((choice) => {
                  const id = `sp-status-${choice.value}`;
                  return (
                    <li key={choice.value}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={state.statuses.includes(choice.value)}
                        onChange={() => apply(toggleStatus(state, choice.value), "replace")}
                      />
                      <label htmlFor={id}>
                        <span className="sp-filter-value">
                          {statusValueLabel(choice.value)}
                        </span>
                        {choice.count > 0 ? (
                          <span className="sp-filter-count">{choice.count}</span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <fieldset
            className="sp-filter-group"
            disabled={filtersDisabled}
            aria-busy={awaitingAnswer}
          >
            <legend className="sp-filter-legend">Code</legend>
            <ul className="sp-filter-list">
              <li>
                <input
                  id="sp-code"
                  type="checkbox"
                  checked={state.hasCode === true}
                  onChange={(event) =>
                    apply(
                      { ...state, hasCode: event.target.checked ? true : null },
                      "replace",
                    )
                  }
                />
                <label htmlFor="sp-code">
                  <span className="sp-filter-value">Code available</span>
                </label>
              </li>
            </ul>
          </fieldset>

          {showClear ? (
            <button
              type="button"
              className="sp-clear"
              onClick={() => apply(clearFilters(state), "replace")}
            >
              Clear filters
            </button>
          ) : null}
        </aside>

        <section className="sp-results" aria-label="Search results">
          {paperTarget !== null ? (
            <p className="sp-redirect" role="status">
              Opening <a href={paperTarget}>the paper</a>…
            </p>
          ) : null}

          {view.status === "idle" && paperTarget === null ? (
            <p className="sp-prompt" role="status">
              Enter a term above to search the listed papers.
            </p>
          ) : null}

          {searching ? (
            <p className="sp-loading" role="status">
              Searching…
            </p>
          ) : null}

          {view.status === "error" ? (
            <div className="sp-error" role="alert">
              <p className="sp-error-message">{view.message}</p>
              <button type="button" className="sp-retry" onClick={retry}>
                Try again
              </button>
            </div>
          ) : null}

          {shown !== undefined ? (
            <>
              <p className="sp-summary" role="status">
                {updating ? (
                  "Updating results…"
                ) : (
                  <>
                    {resultSummary(
                      state.q,
                      isResults(shown) ? shown.total : shown.results.length,
                      semantic ? "semantic" : "keyword",
                    )}
                    {isResults(shown) ? null : (
                      <span className="sp-embedder" title={shown.embedder}>
                        {" "}
                        · Semantic match
                      </span>
                    )}
                  </>
                )}
              </p>

              {results.length === 0 ? (
                <div className="sp-empty" aria-busy={updating}>
                  <p>No listed papers match this search.</p>
                  <p className="sp-empty-hint">
                    {semantic
                      ? "Try a broader phrase."
                      : "Try fewer words, or clear a filter to widen the list."}
                  </p>
                  {showClear ? (
                    <button
                      type="button"
                      className="sp-clear"
                      onClick={() => apply(clearFilters(state), "replace")}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : (
                <ol className="sp-result-list" aria-busy={updating}>
                  {results.map((hit) => (
                    <ResultRow
                      key={`${hit.versionCid || hit.title}-${hit.n}`}
                      hit={hit}
                      semantic={semantic}
                    />
                  ))}
                </ol>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** One result: title link, metadata, status and code badges, abstract. */
function ResultRow({
  hit,
  semantic,
}: {
  hit: SearchResultItem;
  semantic: boolean;
}) {
  const authors = hit.authors ?? [];
  const byline = authorLine(authors);
  const hasByline = byline.shown.length > 0;
  const total = hit.totalVersions ?? hit.total ?? hit.versions ?? hit.n;
  const meta = [
    hit.categories.length > 0 ? hit.categories.join(", ") : "",
    `v${hit.n} of ${total}`,
  ].filter((part) => part !== "");
  // The listing date is the paper page's date for the same instant: the
  // shared helper's, in the reader's zone (`toDate` reads the API's zone-less
  // timestamp as UTC, so the two pages cannot disagree on the day).
  // `LocalDate` keeps the first HTML stable in any zone — UTC first, the
  // reader's date as soon as React takes over — so the server and the browser
  // never disagree either.
  const listed = toDate(hit.listedAt) !== null;
  const hasMeta = meta.length > 0 || listed;

  return (
    <li className="sp-result">
      <h2 className="sp-result-title">
        <a href={resultHref(hit)}>{hit.title}</a>
      </h2>

      {hasByline || hasMeta ? (
        <p className="sp-result-meta">
          {hasByline ? (
            <span
              className="sp-result-authors"
              title={byline.more > 0 ? byline.all.join(", ") : undefined}
            >
              {authors.slice(0, byline.shown.length).map((author, index) => (
                <Fragment key={author.did}>
                  {index > 0 ? ", " : null}
                  <a href={profilePath(author.did)}>{authorLabel(author)}</a>
                </Fragment>
              ))}
              {byline.more > 0 ? `, +${byline.more}` : null}
            </span>
          ) : null}
          {hasByline && hasMeta ? " · " : null}
          {meta.map((part, index) => (
            <Fragment key={part}>
              {index > 0 ? " · " : null}
              {part}
            </Fragment>
          ))}
          {listed && meta.length > 0 ? " · " : null}
          {listed && hit.listedAt !== null ? (
            <LocalDate value={hit.listedAt} />
          ) : null}
        </p>
      ) : null}

      <div className="sp-result-badges">
        {hit.status !== null && isPaperStatus(hit.status) ? (
          <StatusChip status={hit.status} />
        ) : null}
        {!semantic && hit.hasCode ? (
          <span className="sp-code-badge">⌥ Code available</span>
        ) : null}
        {semantic ? (
          <span className="sp-score">
            {Math.round(Math.max(0, Math.min(1, hit.score)) * 100)}% match
          </span>
        ) : null}
      </div>

      {hit.abstract !== "" ? (
        <p className="sp-result-abstract">{hit.abstract}</p>
      ) : null}
    </li>
  );
}

export default SearchPage;
