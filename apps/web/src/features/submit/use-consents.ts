"use client";

/**
 * Keeps a paper version's consent report fresh while someone is still waiting.
 *
 * It asks once on mount, then again every `intervalMs` for as long as any
 * author is waiting. Everyone signed (or the version back in draft after a
 * decline) means nothing more will change without the author doing something,
 * so polling stops. A failed request keeps the last good report on screen and
 * is tried again after the same interval.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  consentsErrorMessage,
  fetchConsents,
  type ConsentReport,
  type FetchConsents,
  type VersionRef,
} from "./consents";

export const DEFAULT_CONSENT_POLL_MS = 15_000;

export interface UseConsentsOptions {
  fetcher?: FetchConsents;
  intervalMs?: number;
}

export interface ConsentsState {
  /** `idle`: no version to ask about. */
  phase: "idle" | "loading" | "ready" | "error";
  report: ConsentReport | null;
  /** A sentence for the author when the last request failed. */
  error: string | null;
  /** Ask again now. */
  refresh: () => void;
}

export function useConsents(
  ref: VersionRef | null | undefined,
  { fetcher = fetchConsents, intervalMs = DEFAULT_CONSENT_POLL_MS }: UseConsentsOptions = {},
): ConsentsState {
  const [report, setReport] = useState<ConsentReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConsentsState["phase"]>(ref ? "loading" : "idle");
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
        again = next.waiting > 0 && next.declined === 0;
      } catch (failure) {
        if (controller.signal.aborted) {
          return;
        }
        setError(consentsErrorMessage(failure));
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
