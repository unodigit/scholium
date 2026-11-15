"use client";

/**
 * Loads the version a consent link names, once, and again on request.
 *
 * Unlike the consent report this does not poll: the signed version never
 * changes, only who has answered does (`useConsents` watches that).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadConsentVersion,
  versionErrorMessage,
  type ConsentVersion,
  type LoadConsentVersion,
} from "./consent-version";

export interface ConsentVersionState {
  phase: "loading" | "ready" | "error";
  version: ConsentVersion | null;
  /** A sentence for the reader when loading failed. */
  error: string | null;
  /** Ask again now. */
  reload: () => void;
}

export function useConsentVersion(
  cid: string,
  { loader = loadConsentVersion }: { loader?: LoadConsentVersion } = {},
): ConsentVersionState {
  const [version, setVersion] = useState<ConsentVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConsentVersionState["phase"]>("loading");
  const [nonce, setNonce] = useState(0);

  // Callers pass a new function identity on every render; only the cid and an
  // explicit reload decide when to start over.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    setPhase("loading");
    setError(null);
    loaderRef
      .current(cid, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        setVersion(loaded);
        setPhase("ready");
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setVersion(null);
        setError(versionErrorMessage(failure));
        setPhase("error");
      });
    return () => controller.abort();
  }, [cid, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { phase, version, error, reload };
}
