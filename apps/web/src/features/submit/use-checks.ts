"use client";

/**
 * Keeps a version's check results live while the node is still working.
 *
 * It asks once on mount, then again every `intervalMs` for as long as the
 * version is `scanning` or a file is still being scanned. When the checks
 * settle it stops; the author can always ask again with `refresh` after
 * replacing a file. A failed request keeps the last good report on screen and
 * is retried after the same interval.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checksAreRunning,
  checksErrorMessage,
  fetchVersionChecks,
  type ChecksVersionRef,
  type FetchChecks,
  type VersionChecks,
} from "./checks";

export const DEFAULT_CHECK_POLL_MS = 5_000;

export interface UseChecksOptions {
  fetcher?: FetchChecks;
  intervalMs?: number;
}

export interface ChecksState {
  /** `idle`: no version to ask about. */
  phase: "idle" | "loading" | "ready" | "error";
  report: VersionChecks | null;
  /** A sentence for the author when the last request failed. */
  error: string | null;
  /** Ask again now. */
  refresh: () => void;
}

export function useChecks(
  ref: ChecksVersionRef | null | undefined,
  { fetcher = fetchVersionChecks, intervalMs = DEFAULT_CHECK_POLL_MS }: UseChecksOptions = {},
): ChecksState {
  const [report, setReport] = useState<VersionChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ChecksState["phase"]>(ref ? "loading" : "idle");
  const [nonce, setNonce] = useState(0);

  // Callers pass new object and function identities on every render; only the
  // values decide when to start over.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const paper = ref?.paper;
  const version = ref?.version;

  useEffect(() => {
    if (paper === undefined || version === undefined) {
      setReport(null);
      setError(null);
      setPhase("idle");
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPhase((current) => (current === "ready" ? current : "loading"));

    const poll = async (): Promise<void> => {
      let again = true;
      try {
        const next = await fetcherRef.current({ paper, version }, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setReport(next);
        setError(null);
        setPhase("ready");
        again = checksAreRunning(next);
      } catch (failure) {
        if (controller.signal.aborted) {
          return;
        }
        setError(checksErrorMessage(failure));
        setPhase("error");
      }
      if (again && intervalMs > 0) {
        timer = setTimeout(() => void poll(), intervalMs);
      }
    };

    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [paper, version, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { phase, report, error, refresh };
}
