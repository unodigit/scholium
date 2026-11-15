"use client";

/**
 * Hooks for the review card's actions: who is looking, and the paper's byline.
 *
 * Both only decide which control to put in front of the reader; the API is the
 * gate (see `viewer.ts`).
 */

import { useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";
import {
  SIGNED_OUT,
  loadPaperAuthors,
  viewerFromToken,
  type LoadPaperAuthors,
  type Viewer,
} from "./viewer";

function sameViewer(left: Viewer, right: Viewer): boolean {
  return (
    left.signedIn === right.signedIn &&
    left.did === right.did &&
    left.tier === right.tier
  );
}

/**
 * The signed-in viewer, from the shared token store.
 *
 * Like the nav, the first render matches the server's signed-out HTML and the
 * store's answer is applied after mount, so there is no hydration mismatch; a
 * sign-in, a refresh or a sign-out anywhere in the app updates it live.
 * `override` wins whenever it is given, so hosts and tests can pin the viewer.
 */
export function useViewer(override?: Viewer): Viewer {
  const [stored, setStored] = useState<Viewer>(SIGNED_OUT);

  useEffect(() => {
    if (override !== undefined) return;
    const update = (): void => {
      const next = viewerFromToken(tokenStore.get()?.accessToken);
      setStored((current) => (sameViewer(current, next) ? current : next));
    };
    update();
    return tokenStore.subscribe(update);
  }, [override]);

  return override ?? stored;
}

/** Where the byline read stands. */
export type AuthorsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly dids: readonly string[] }
  | { readonly status: "failed" };

const IDLE: AuthorsState = { status: "idle" };
const LOADING: AuthorsState = { status: "loading" };
const FAILED: AuthorsState = { status: "failed" };

/**
 * Reads in flight, by paper. A reviews tab with five cards mounts five of
 * these at once; they share one request rather than making five. Nothing is
 * kept once a read settles, so a later mount asks again.
 */
const inFlight = new Map<string, Promise<readonly string[]>>();

/** {@link loadPaperAuthors}, shared between cards that ask at the same time. */
export const loadPaperAuthorsShared: LoadPaperAuthors = (paperId) => {
  const pending = inFlight.get(paperId);
  if (pending !== undefined) return pending;

  const started = loadPaperAuthors(paperId).finally(() => {
    if (inFlight.get(paperId) === started) inFlight.delete(paperId);
  });
  inFlight.set(paperId, started);
  return started;
};

/**
 * The paper's authors' DIDs, read only when `enabled` (a signed-out reader has
 * no use for them, so costs no request).
 *
 * `provided` skips the read: a host that already knows the byline passes it.
 * A failed read is `failed`, not an error: the card then offers only what it
 * can without a byline.
 */
export function usePaperAuthors(
  paperId: string,
  enabled: boolean,
  provided?: readonly string[],
  load: LoadPaperAuthors = loadPaperAuthorsShared,
): AuthorsState {
  const [state, setState] = useState<{ key: string; value: AuthorsState }>({
    key: "",
    value: IDLE,
  });

  // The latest loader, without making an inline function restart the read.
  const loadRef = useRef<LoadPaperAuthors>(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const needsRead = enabled && provided === undefined;
  useEffect(() => {
    if (!needsRead) return;
    let cancelled = false;
    // A fresh read for this paper starts from `loading`, never from another
    // paper's answer.
    setState({ key: paperId, value: LOADING });
    loadRef.current(paperId).then(
      (dids) => {
        if (!cancelled) setState({ key: paperId, value: { status: "ready", dids } });
      },
      () => {
        if (!cancelled) setState({ key: paperId, value: FAILED });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paperId, needsRead]);

  if (provided !== undefined) return { status: "ready", dids: provided };
  if (!needsRead) return IDLE;
  // The first render after `needsRead` flips has no read yet (the effect has
  // not run): that is loading, not idle, so the card never flashes a control
  // that the byline would then remove.
  return state.key === paperId ? state.value : LOADING;
}
