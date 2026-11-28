"use client";

/**
 * `/papers` — the paper feed (docs/design.md §5.1).
 *
 * ```text
 * Latest | Reviewed | Following            Category: cs.AI ▾   Sort ▾
 * ─────────────────────────────────────────────────────────────────────
 * Can a Meta-Agent Choose the Safer Branch?
 * M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago
 * An evaluation framework for whether meta-agents can identify safer…
 * ✓ Reviewed
 * ```
 *
 * The three tabs are real links, so the page works without JavaScript: each
 * one is a plain `/papers?tab=…` request the server route answers. With JavaScript
 * this component takes over the same transitions — it rewrites the URL with
 * the native History API (a shallow update Next.js supports), fetches the new
 * list itself, and a `popstate` listener adopts whatever state the browser
 * returns to. The category and sort selectors work the same way, and sit in a
 * GET form to `/papers` with an **Apply** button for visitors without
 * JavaScript.
 *
 * The first page of `latest` and `reviewed` arrives from the server route as
 * `initialPage`, so the first HTML already has the rows. **Following** is
 * always fetched in the browser: it lists the caller's own follows, and the
 * session token lives in the browser's storage, not in a cookie the server
 * can read. A visitor with no session is asked to sign in and no request is
 * made.
 *
 * There are no vote counts anywhere on the page, by design.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { DEFAULT_CATEGORIES } from "../../components/nav/categories";
import { tokenStore } from "../../lib/api";
import { EmptyState } from "../ui-kit";
import {
  DEFAULT_FEED_STATE,
  FEED_HEADINGS,
  FEED_PATH,
  FEED_SORTS,
  FEED_SORT_LABELS,
  FEED_TABS,
  FEED_TAB_LABELS,
  appendItems,
  categoriesOf,
  categoryChoices,
  describeFeedError,
  emptyFeedSentence,
  feedHref,
  feedStateKey,
  itemKey,
  loadFeedPage,
  parseFeedParams,
  signInHref,
  type FeedItem,
  type FeedPageData,
  type FeedSort,
  type FeedState,
  type FeedTab,
} from "./feed";
import { FeedRow } from "./feed-row";
import "./feed.css";

/** Loads one page of the feed; replaceable in tests. */
export type LoadFeedPage = (state: FeedState, cursor?: string | null) => Promise<FeedPageData>;

/** How a URL update should treat browser history. */
export type UrlUpdateMode = "push" | "replace";

/** Rewrites the address bar; replaceable in tests or a host router. */
export type UpdateUrl = (href: string, mode: UrlUpdateMode) => void;

/** Props for {@link FeedPage}. Everything is optional. */
export interface FeedPageProps {
  /** State read from the route's `searchParams` by the server. */
  initialState?: FeedState;
  /** First page fetched by the server, so the first paint has rows. */
  initialPage?: FeedPageData;
  /** Failure message from the server-side fetch; the page offers a retry. */
  initialError?: string;
  /** Public recommendations shown on the unfiltered Latest tab. */
  latestRecommendations?: ReactNode;
  /** Pin the sign-in state (`true`/`false`); by default it is read from the token store. */
  signedIn?: boolean;
  /** Replace the page loader, for tests or an alternate API client. */
  load?: LoadFeedPage;
  /** Replace the URL update, for tests. */
  updateUrl?: UpdateUrl;
  /** The moment ages are measured to; defaults to the current time. */
  now?: Date;
}

type FeedView =
  | { readonly status: "loading"; readonly key: string }
  | { readonly status: "error"; readonly key: string; readonly message: string }
  | {
      readonly status: "ready";
      readonly key: string;
      readonly items: readonly FeedItem[];
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
      readonly moreError: string | null;
    };

type AuthState = "unknown" | "signed-in" | "signed-out";

/** A shallow URL update Next.js understands; no full navigation. */
function defaultUpdateUrl(href: string, mode: UrlUpdateMode): void {
  if (typeof window === "undefined") {
    return;
  }
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === href) {
    return;
  }
  try {
    if (mode === "push") {
      window.history.pushState(null, "", href);
    } else {
      window.history.replaceState(null, "", href);
    }
  } catch {
    // History may be unavailable (sandboxed frame); local state still works.
  }
}

function readyView(key: string, page: FeedPageData): FeedView {
  return {
    status: "ready",
    key,
    items: page.items,
    nextCursor: page.nextCursor,
    loadingMore: false,
    moreError: null,
  };
}

function initialView(
  state: FeedState,
  page: FeedPageData | undefined,
  error: string | undefined,
): FeedView {
  const key = feedStateKey(state);
  if (error !== undefined) {
    return { status: "error", key, message: error };
  }
  if (page !== undefined) {
    return readyView(key, page);
  }
  return { status: "loading", key };
}

/**
 * Whether the token store holds a session. `unknown` until the browser has
 * been asked, so the first render matches the server's HTML and the Following
 * tab never flashes a sign-in prompt at a signed-in reader.
 */
function useAuthState(pinned?: boolean): AuthState {
  const [detected, setDetected] = useState<AuthState>("unknown");

  useEffect(() => {
    if (pinned !== undefined) {
      return;
    }
    const update = (): void =>
      setDetected(tokenStore.isAuthenticated ? "signed-in" : "signed-out");
    update();
    return tokenStore.subscribe(update);
  }, [pinned]);

  if (pinned !== undefined) {
    return pinned ? "signed-in" : "signed-out";
  }
  return detected;
}

/** A plain left click, which a link handler may take over; anything else is the browser's. */
function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The paper feed: tabs, selectors and the rows. */
export function FeedPage({
  initialState = DEFAULT_FEED_STATE,
  initialPage,
  initialError,
  latestRecommendations,
  signedIn,
  load,
  updateUrl,
  now,
}: FeedPageProps = {}) {
  const [state, setState] = useState<FeedState>(initialState);
  const [view, setView] = useState<FeedView>(() =>
    initialView(initialState, initialPage, initialError),
  );
  const [attempt, setAttempt] = useState(0);
  // Categories seen in any answer, so the selector keeps offering them after a
  // filter narrows the list to one.
  const [seenCategories, setSeenCategories] = useState<string[]>(() =>
    categoriesOf(initialPage?.items ?? []),
  );

  const auth = useAuthState(signedIn);
  const loader = load ?? loadFeedPage;
  const navigate = updateUrl ?? defaultUpdateUrl;

  // The key of the request already answered or in flight. A ref rather than
  // state so the fetch effect can tell "same view" from "new view" without
  // depending on `view` and re-running in a loop.
  const requestedRef = useRef<string | null>(
    view.status === "ready" || view.status === "error" ? view.key : null,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const apply = useCallback(
    (next: FeedState): void => {
      setState(next);
      navigate(feedHref(next), "push");
    },
    [navigate],
  );

  // The global nav (and a link to `/papers`) can change the route's search
  // params without remounting this component, and the server then hands down a
  // new `initialState` and page. Adopt them whenever they arrive — by identity,
  // not by value: a link back to `/papers` carries the same state as before while
  // the address bar has since moved on. Client-side changes never replace
  // these props, so this runs only for a navigation the server answered.
  const adoptedRoute = useRef(false);
  useEffect(() => {
    if (!adoptedRoute.current) {
      adoptedRoute.current = true;
      return;
    }
    setState(initialState);
    const next = initialView(initialState, initialPage, initialError);
    requestedRef.current =
      next.status === "ready" || next.status === "error" ? next.key : null;
    setView(next);
  }, [initialState, initialPage, initialError]);

  // Back/forward: the address bar changed without a render. Parse it back into
  // state; the fetch effect below answers the new view.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onPopState = (): void => {
      const params: Record<string, string[]> = {};
      new URLSearchParams(window.location.search).forEach((value, key) => {
        (params[key] ??= []).push(value);
      });
      setState(parseFeedParams(params));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Fetch the page for the current view. `key` folds the tab, category and sort
  // into one value; `following` also waits on the sign-in state.
  const key = feedStateKey(state);
  const followingAuth = state.tab === "following" ? auth : "n/a";
  useEffect(() => {
    if (followingAuth === "unknown") {
      requestedRef.current = null;
      setView({ status: "loading", key });
      return;
    }
    if (followingAuth === "signed-out") {
      // Nothing to ask the API: the view below is the sign-in prompt.
      requestedRef.current = null;
      return;
    }
    if (requestedRef.current === key) {
      return;
    }
    requestedRef.current = key;

    let cancelled = false;
    setView({ status: "loading", key });
    loaderRef.current(stateRef.current).then(
      (page) => {
        if (!cancelled) {
          setView(readyView(key, page));
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setView({
            status: "error",
            key,
            message: describeFeedError(error, stateRef.current.tab),
          });
        }
      },
    );

    return () => {
      cancelled = true;
      // Superseded before it answered: a later run (a new view, or React's
      // development double-run of effects) must be free to ask again.
      if (requestedRef.current === key) {
        requestedRef.current = null;
      }
    };
  }, [key, attempt, followingAuth]);

  // Remember the categories of whatever is on screen.
  const shownItems = view.status === "ready" ? view.items : undefined;
  useEffect(() => {
    if (shownItems === undefined) {
      return;
    }
    setSeenCategories((current) => {
      const merged = [...new Set([...current, ...categoriesOf(shownItems)])];
      return merged.length === current.length ? current : merged;
    });
  }, [shownItems]);

  const retry = useCallback(() => {
    requestedRef.current = null;
    setAttempt((count) => count + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (view.status !== "ready" || view.nextCursor === null || view.loadingMore) {
      return;
    }
    const { key: askedKey, nextCursor } = view;
    const asked = stateRef.current;
    setView({ ...view, loadingMore: true, moreError: null });

    loaderRef.current(asked, nextCursor).then(
      (page) => {
        setView((current) =>
          current.status === "ready" && current.key === askedKey
            ? {
                ...current,
                items: appendItems(current.items, page.items),
                nextCursor: page.nextCursor,
                loadingMore: false,
              }
            : current,
        );
      },
      (error: unknown) => {
        setView((current) =>
          current.status === "ready" && current.key === askedKey
            ? {
                ...current,
                loadingMore: false,
                moreError: describeFeedError(error, asked.tab),
              }
            : current,
        );
      },
    );
  }, [view]);

  const chooseTab = (tab: FeedTab, event: MouseEvent<HTMLAnchorElement>): void => {
    if (!isPlainClick(event)) {
      return;
    }
    event.preventDefault();
    if (tab !== state.tab) {
      apply({ ...state, tab });
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // The selectors apply as they change; Enter in one must not reload the page.
    event.preventDefault();
  };

  const choices = categoryChoices(seenCategories, state.category);
  const signedOutFollowing = state.tab === "following" && auth === "signed-out";

  return (
    <div className="fd-page">
      <h1 className="fd-visually-hidden">{FEED_HEADINGS[state.tab]}</h1>

      <div className="fd-controls">
        <nav className="fd-tabs" aria-label="Feed">
          {FEED_TABS.map((tab) => {
            const active = tab === state.tab;
            return (
              <a
                key={tab}
                className={active ? "fd-tab fd-tab--active" : "fd-tab"}
                href={feedHref({ ...state, tab })}
                aria-current={active ? "page" : undefined}
                onClick={(event) => chooseTab(tab, event)}
              >
                {FEED_TAB_LABELS[tab]}
              </a>
            );
          })}
        </nav>

        <form className="fd-selectors" action={FEED_PATH} method="get" onSubmit={onSubmit}>
          <input type="hidden" name="tab" value={state.tab} />

          <label className="fd-select">
            <span className="fd-select-label">Category</span>
            <select
              name="category"
              value={state.category}
              onChange={(event) => apply({ ...state, category: event.target.value })}
            >
              <option value="">All categories</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>

          <label className="fd-select">
            <span className="fd-select-label">Sort</span>
            <select
              name="sort"
              value={state.sort}
              onChange={(event) =>
                apply({ ...state, sort: event.target.value as FeedSort })
              }
            >
              {FEED_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {FEED_SORT_LABELS[sort]}
                </option>
              ))}
            </select>
          </label>

          <noscript>
            <button type="submit" className="fd-apply">
              Apply
            </button>
          </noscript>
        </form>
      </div>

      {state.tab === "latest" && !state.category ? latestRecommendations : null}

      <section
        className="fd-results"
        aria-label={FEED_HEADINGS[state.tab]}
        aria-busy={view.status === "loading" && !signedOutFollowing}
      >
        {signedOutFollowing ? (
          <EmptyState
            className="fd-empty"
            sentence="Sign in to follow categories and see their new papers here."
            action={{ label: "Sign in", href: signInHref(state) }}
          />
        ) : null}

        {!signedOutFollowing && view.status === "loading" ? (
          <p className="fd-loading" role="status">
            Loading papers…
          </p>
        ) : null}

        {!signedOutFollowing && view.status === "error" ? (
          <div className="fd-error" role="alert">
            <p className="fd-error-message">{view.message}</p>
            <button type="button" className="fd-button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : null}

        {!signedOutFollowing && view.status === "ready" ? (
          view.items.length === 0 ? (
            <EmptyView state={state} apply={apply} />
          ) : (
            <>
              <ol className="fd-list">
                {view.items.map((item) => (
                  <FeedRow
                    key={itemKey(item)}
                    item={item}
                    sort={state.sort}
                    now={now}
                  />
                ))}
              </ol>

              {view.moreError !== null ? (
                <p className="fd-more-error" role="alert">
                  {view.moreError}
                </p>
              ) : null}

              {view.nextCursor !== null ? (
                <div className="fd-more">
                  <button
                    type="button"
                    className="fd-button fd-button--quiet"
                    disabled={view.loadingMore}
                    onClick={loadMore}
                  >
                    {view.loadingMore ? "Loading…" : "Show more papers"}
                  </button>
                </div>
              ) : null}
            </>
          )
        ) : null}
      </section>
    </div>
  );
}

/**
 * The empty view: one sentence and one way forward (docs/design.md §7). The
 * way forward is the nearest wider view — every category, the latest papers,
 * or a category to follow.
 */
function EmptyView({
  state,
  apply,
}: {
  state: FeedState;
  apply: (next: FeedState) => void;
}) {
  const sentence = emptyFeedSentence(state);

  const go = (next: FeedState) => ({
    href: feedHref(next),
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (isPlainClick(event)) {
        event.preventDefault();
        apply(next);
      }
    },
  });

  if (state.category.trim() !== "") {
    return (
      <EmptyState
        className="fd-empty"
        sentence={sentence}
        action={{ label: "Show all categories", ...go({ ...state, category: "" }) }}
      />
    );
  }
  if (state.tab === "reviewed") {
    return (
      <EmptyState
        className="fd-empty"
        sentence={sentence}
        action={{ label: "See the latest papers", ...go({ ...state, tab: "latest" }) }}
      />
    );
  }
  if (state.tab === "following") {
    const first = DEFAULT_CATEGORIES[0];
    return (
      <EmptyState
        className="fd-empty"
        sentence={sentence}
        action={{
          label: first ? `Open ${first.id}` : "See the latest papers",
          ...(first
            ? { href: `/c/${encodeURIComponent(first.id)}` }
            : go({ ...state, tab: "latest" })),
        }}
      />
    );
  }
  return (
    <EmptyState
      className="fd-empty"
      sentence={sentence}
      action={{ label: "Submit a paper", href: "/submit" }}
    />
  );
}

export default FeedPage;
