"use client";

/**
 * The "Saved searches" card on `/me`.
 *
 * ```text
 * Saved searches
 * pulsar timing                                        [ Delete ]
 * cs.CR · reviewed · has code · 2026-03-02 – 2026-04-01
 * ```
 *
 * Each title links to `/search` with the saved filters, which re-runs the
 * search. Delete removes the row once the API confirms; a failed delete keeps
 * the row and says why on it. The card loads on its own (not from
 * `GET /v1/me/dashboard`), so a failure here never blanks the rest of `/me`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";
import { EmptyState } from "../ui-kit";
import { SEARCH_PATH } from "../search-page/search";

import { Card } from "./card";
import {
  deleteSavedSearch as removeSavedSearch,
  describeSavedSearchError,
  loadSavedSearches as fetchSavedSearches,
  savedSearchFilters,
  savedSearchHref,
  savedSearchTitle,
  type SavedSearch,
} from "./saved-searches";

/** Props for {@link SavedSearchesCard}. Everything is optional. */
export interface SavedSearchesCardProps {
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store. The card asks for the reader's own list, so without a session it
   * never calls the API.
   */
  readonly signedIn?: boolean;
  /** Replace the loader, for tests or an alternate API client. */
  readonly loadSavedSearches?: () => Promise<readonly SavedSearch[]>;
  /** Replace the delete call, for tests or an alternate API client. */
  readonly deleteSavedSearch?: (id: string) => Promise<void>;
}

type CardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: readonly SavedSearch[] };

/** The reader's saved searches, each with a Delete action. */
export function SavedSearchesCard({
  signedIn,
  loadSavedSearches = fetchSavedSearches,
  deleteSavedSearch = removeSavedSearch,
}: SavedSearchesCardProps = {}) {
  const [state, setState] = useState<CardState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Where focus goes once a deleted row has left the DOM; `null` when idle.
  const focusIndex = useRef<number | null>(null);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadSavedSearches().then(
      (items) => {
        if (!cancelled) {
          setState({ status: "ready", items });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeSavedSearchError(error, "load") });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, loadSavedSearches, signedIn]);

  // A deleted row takes the focused button with it: hand focus to the next row,
  // or to the card body when the list is now empty, instead of dropping to <body>.
  useEffect(() => {
    if (focusIndex.current === null || state.status !== "ready") {
      return;
    }
    const buttons = listRef.current?.querySelectorAll<HTMLElement>("button");
    const target = buttons?.[Math.min(focusIndex.current, buttons.length - 1)];
    (target ?? bodyRef.current)?.focus();
    focusIndex.current = null;
  }, [state]);

  const remove = async (search: SavedSearch, index: number) => {
    if (removing.has(search.id)) {
      return;
    }
    setRemoving((current) => new Set(current).add(search.id));
    setRowErrors(({ [search.id]: _cleared, ...rest }) => rest);
    try {
      await deleteSavedSearch(search.id);
      focusIndex.current = index;
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", items: current.items.filter((item) => item.id !== search.id) }
          : current,
      );
      setNotice(`Deleted saved search “${savedSearchTitle(search.query)}”.`);
    } catch (error: unknown) {
      setRowErrors((current) => ({
        ...current,
        [search.id]: describeSavedSearchError(error, "delete"),
      }));
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(search.id);
        return next;
      });
    }
  };

  return (
    <Card title="Saved searches" anchor="saved-searches">
      <div className="db-saved-body" ref={bodyRef} tabIndex={-1}>
        {state.status === "loading" ? (
          <p className="db-loading" role="status">
            Loading your saved searches…
          </p>
        ) : null}

        {state.status === "error" ? (
          <div className="db-saved-error" role="alert">
            <p className="db-item-detail meta">{state.message}</p>
            <button type="button" className="db-button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : null}

        {state.status === "ready" && state.items.length === 0 ? (
          <EmptyState
            sentence="You have no saved searches yet."
            action={{ label: "Search papers", href: SEARCH_PATH }}
          />
        ) : null}

        {state.status === "ready" && state.items.length > 0 ? (
          <ul className="db-list" ref={listRef}>
            {state.items.map((search, index) => {
              const title = savedSearchTitle(search.query);
              // Only filters beyond the title: a filter-only search is titled by them.
              const filters = search.query.q === undefined ? [] : savedSearchFilters(search.query);
              const busy = removing.has(search.id);
              return (
                <li className="db-saved" key={search.id}>
                  <div className="db-saved-head">
                    <a className="db-link db-saved-title" href={savedSearchHref(search.query)}>
                      {title}
                    </a>
                    <button
                      type="button"
                      className="db-button db-saved-delete"
                      aria-label={`Delete saved search ${title}`}
                      aria-disabled={busy}
                      aria-busy={busy}
                      onClick={() => remove(search, index)}
                    >
                      {busy ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                  {filters.length > 0 ? (
                    <p className="db-saved-meta meta">{filters.join(" · ")}</p>
                  ) : null}
                  {rowErrors[search.id] !== undefined ? (
                    <p className="db-saved-row-error meta" role="alert">
                      {rowErrors[search.id]}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Always mounted so a screen reader announces the text when it changes. */}
        <p className="db-visually-hidden" role="status">
          {notice}
        </p>
      </div>
    </Card>
  );
}

export default SavedSearchesCard;
