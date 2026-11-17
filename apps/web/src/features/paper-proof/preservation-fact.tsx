"use client";

/**
 * PreservationFact: the paper header's preservation line, one fact of the
 * byline's facts row (docs/design.md §5.2: "Preserved 5/5 replicas").
 *
 * ```tsx
 * <PreservationFact />            // inside the header's <p className="ppg-facts">
 * <PreservationFact load={read} /> // a test's own loader
 * ```
 *
 * It reads the node's replication summary (`GET /v1/network`, the same public
 * document `/network` shows) in the reader's browser and says it in words —
 * on this single-node deployment, "Preserved: 1 of 1 local copy" with the
 * qualifier beside it, linking to `/network`. A node that cannot be read is
 * silence rather than a guess: the fact never claims a preservation state the
 * node did not report.
 *
 * A client island on purpose: the header itself stays server-safe, and this
 * line appears after the first render, like the header's other islands.
 */

import { useEffect, useRef, useState } from "react";

import {
  NETWORK_PAGE_HREF,
  loadPreservation,
  preservationCopy,
  type PreservationInfo,
} from "./preservation";

export interface PreservationFactProps {
  /** Replace the loader, for tests or another source. Keep it stable. */
  readonly load?: typeof loadPreservation;
}

export function PreservationFact({ load = loadPreservation }: PreservationFactProps) {
  const [info, setInfo] = useState<PreservationInfo | null>(null);

  // The latest loader without making an inline function restart the read.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    loadRef.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setInfo(value);
      },
      () => {
        // `loadPreservation` never rejects; a custom loader's refusal is silence.
      },
    );
    return () => controller.abort();
  }, []);

  if (info === null) return null;
  const copy = preservationCopy(info);
  return (
    <span className="ppg-fact ppg-preserved">
      <a className="ppg-preserved__link" href={NETWORK_PAGE_HREF}>
        {copy.label}
        <span className="ppg-visually-hidden"> — network details</span>
      </a>
      {copy.note !== null ? <span className="ppg-preserved__note">{copy.note}</span> : null}
    </span>
  );
}
