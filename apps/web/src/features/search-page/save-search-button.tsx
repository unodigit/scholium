"use client";

/**
 * "Save this search" on `/search`.
 *
 * A signed-in reader can keep the query and the facet filters they are looking
 * at, so `/me`'s Saved searches card can re-run it later. The save is a
 * `POST /v1/me/saved-searches` with the same filters `GET /v1/search` takes
 * (see `../dashboard/saved-searches`); the button reads its state from the
 * shared token store, exactly like `FollowToggle`, so the server HTML and the
 * first client render agree and a no-JS reader gets a sign-in link instead of
 * a button that could not work.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";
import {
  saveSearch as saveSearchRequest,
  savedSearchQuery,
  type SavedSearch,
} from "../dashboard/saved-searches";

import {
  hasActiveFilters,
  searchHref,
  searchStateKey,
  type SearchState,
} from "./search";

/** Props for {@link SaveSearchButton}. Only `state` is required. */
export interface SaveSearchButtonProps {
  /** The search on screen: its query and every filter. */
  readonly state: SearchState;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount and kept in step with it.
   */
  readonly signedIn?: boolean;
  /** Replace the save call, for tests or an alternate API client. */
  readonly save?: (
    state: SearchState,
    options: { readonly digest: boolean },
  ) => Promise<SavedSearch>;
}

/** The `/signin?next=…` link that returns to this search afterwards. */
export function saveSearchSigninHref(state: SearchState): string {
  return `/signin?next=${encodeURIComponent(searchHref(state))}`;
}

/** Save the search on screen, or point a signed-out reader at sign-in. */
export function SaveSearchButton({
  state,
  signedIn,
  save,
}: SaveSearchButtonProps) {
  const [sessionKnown, setSessionKnown] = useState(false);
  const [digest, setDigest] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The search the "Saved" state belongs to. A new filter or term starts over.
  const savedKey = useRef<string | null>(null);

  // The access token lives in memory only, so a page load starts signed out
  // until the session provider restores it. Subscribe so the control upgrades
  // when that answer arrives, without a reload.
  useEffect(() => {
    if (signedIn !== undefined) {
      return;
    }
    const read = (): void => setSessionKnown(tokenStore.isAuthenticated);
    read();
    return tokenStore.subscribe(read);
  }, [signedIn]);

  const key = searchStateKey(state);
  useEffect(() => {
    if (savedKey.current !== null && savedKey.current !== key) {
      savedKey.current = null;
      setSaved(false);
      setError(null);
    }
  }, [key]);

  const isSignedIn = signedIn ?? sessionKnown;
  const saveable = state.q.trim() !== "" || hasActiveFilters(state);

  const onSave = useCallback(async () => {
    if (pending || saved) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (save !== undefined) {
        await save(state, { digest });
      } else {
        await saveSearchRequest(savedSearchQuery(state), { digest });
      }
      savedKey.current = key;
      setSaved(true);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message.trim() !== ""
          ? failure.message
          : "Couldn’t save this search. Try again.",
      );
    } finally {
      setPending(false);
    }
  }, [digest, key, pending, save, saved, state]);

  // An empty search has nothing to re-run; the API refuses it too.
  if (!saveable) {
    return null;
  }

  if (!isSignedIn) {
    return (
      <div className="sp-save">
        <a className="sp-save-button" href={saveSearchSigninHref(state)}>
          Save this search
        </a>
      </div>
    );
  }

  return (
    <div className="sp-save">
      <div className="sp-save-row">
        {/* aria-disabled, not disabled: the control keeps keyboard focus. */}
        <button
          type="button"
          className="sp-save-button"
          aria-label="Save this search"
          aria-busy={pending}
          aria-disabled={pending || saved}
          onClick={onSave}
        >
          {saved ? "✓ Saved" : pending ? "Saving…" : "Save this search"}
        </button>

        <label className="sp-save-digest">
          <input
            type="checkbox"
            name="digest"
            checked={digest}
            onChange={(event) => setDigest(event.target.checked)}
          />
          Email me new matches in the daily digest
        </label>
      </div>

      {error !== null ? (
        <p className="sp-save-error" role="alert">
          {error}
        </p>
      ) : null}

      {saved ? (
        <p className="sp-save-status" role="status">
          Saved.{" "}
          <a className="sp-save-link" href="/me">
            See your saved searches
          </a>
        </p>
      ) : null}
    </div>
  );
}

export default SaveSearchButton;
