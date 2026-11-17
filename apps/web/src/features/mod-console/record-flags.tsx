"use client";

/**
 * The flags filed against one moderation item.
 *
 * The decision view shows the record that was flagged beside the flags that
 * named it (`GET /v1/flags?target={cid}&state=all`), so the moderator sees
 * both what is being decided and how earlier reports on the same record
 * ended. The read is moderator-only; a `403`, a server without the list, and
 * a transport failure each read as one sentence, and none of them hides the
 * decision form beside it.
 *
 * `refreshKey` reloads the list after a decision is published, so the flag
 * the moderator just settled turns into its decision link without a reload.
 */

import { useCallback, useEffect, useId, useState } from "react";

import {
  classifyFlagsError,
  loadFlagsForTarget,
  type FlagEntry,
  type FlagsFailure,
  type LoadTargetFlags,
} from "./flags";
import { FlagCard } from "./flags-section";
import type { LoadPersonName } from "./person";
import type { LoadFlagTarget } from "./record";
import "./mod-console.css";

export interface RecordFlagsProps {
  /** The record whose flags are shown (the route's `{cid}`). */
  targetCid: string;
  /** Replace the flag loader, for tests or an alternate API client. */
  loadFlags?: LoadTargetFlags;
  /** Reads what each flag is about; replaceable in tests. */
  loadTarget?: LoadFlagTarget;
  /** Reads a reporter's profile name; replaceable in tests. */
  loadPerson?: LoadPersonName;
  /** Bump to reload the list, e.g. after a decision was published. */
  refreshKey?: number;
}

type FlagsState =
  | { status: "loading" }
  | { status: "ready"; flags: readonly FlagEntry[] }
  | { status: "failed"; failure: FlagsFailure };

/** The flags against one record, with their own load/failure/retry states. */
export function RecordFlags({
  targetCid,
  loadFlags,
  loadTarget,
  loadPerson,
  refreshKey = 0,
}: RecordFlagsProps) {
  const [state, setState] = useState<FlagsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();

  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const load = loadFlags ?? loadFlagsForTarget;
    load(targetCid).then(
      (flags) => {
        if (!cancelled) {
          setState({ status: "ready", flags });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", failure: classifyFlagsError(error, "list") });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, loadFlags, refreshKey, targetCid]);

  return (
    <section className="mc-record-flags" aria-label="Flags against this record">
      <h2 id={headingId} className="mc-record-flags-title">
        Flags against this record
      </h2>

      {state.status === "loading" ? (
        <p className="mc-loading" role="status">
          Loading the flags against this record…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <FlagsNote failure={state.failure} onRetry={reload} />
      ) : null}

      {state.status === "ready" ? (
        state.flags.length === 0 ? (
          <p className="mc-note" role="status">
            No flags are recorded against this record.
          </p>
        ) : (
          <ul className="mc-case-list" aria-label="Flags against this record">
            {state.flags.map((flag) => (
              <li key={flag.id}>
                <FlagCard flag={flag} loadTarget={loadTarget} loadPerson={loadPerson} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

/** Why the flags are not shown: expected conditions are notes, faults an alert. */
function FlagsNote({
  failure,
  onRetry,
}: {
  failure: FlagsFailure;
  onRetry: () => void;
}) {
  if (
    failure.kind === "forbidden" ||
    failure.kind === "unsupported" ||
    failure.kind === "not-found"
  ) {
    return (
      <p className="mc-note" role="status">
        {failure.message}
      </p>
    );
  }

  if (failure.kind === "signed-out") {
    return (
      <p className="mc-note" role="status">
        {failure.message}
      </p>
    );
  }

  return (
    <div className="mc-notice" role="alert">
      <p className="mc-notice-text">{failure.message}</p>
      <button type="button" className="mc-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default RecordFlags;
