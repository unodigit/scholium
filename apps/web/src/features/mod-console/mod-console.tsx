"use client";

/**
 * `/mod` — the moderation console (tier 4), docs/design.md §5.7.
 *
 * The queue of versions waiting for a decision, from
 * `GET /v1/moderation/queue`: paper, category, age and the automated signals
 * (similarity %, unresolved references, scan result, new-account flag).
 *
 * The queue needs the signed-in account's bearer token, which lives in the
 * browser, so this page is rendered on the client: the server HTML is the
 * shell and a loading line, and the table arrives once the API has answered.
 * Who may see it is the API's call, not the page's — it answers a lower tier
 * with `403`, and that answer is what puts up the "Moderators only" notice.
 * (The tier is a claim inside a short-lived access token, so a page that
 * read it itself could keep a freshly promoted moderator out.) A visitor with
 * no session at all is sent to sign in without a request being made.
 */

import { useCallback, useEffect, useState } from "react";

import { tokenStore } from "../../lib/api";
import { EmptyState } from "../ui-kit/empty-state";
import {
  MOD_TITLE,
  SIGNED_OUT_FAILURE,
  SIGNIN_HREF,
  classifyQueueError,
  loadQueue as fetchQueue,
  type QueueEntry,
  type QueueFailure,
} from "./queue";
import { QueueTable } from "./queue-table";
import "./mod-console.css";

/** Loads the queue; replaceable in tests. */
export type LoadQueue = () => Promise<readonly QueueEntry[]>;

/** Props for {@link ModConsole}. Everything is optional. */
export interface ModConsoleProps {
  /** Replace the loader, for tests or an alternate API client. */
  loadQueue?: LoadQueue;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  signedIn?: boolean;
}

type ConsoleState =
  | { status: "loading" }
  | {
      status: "ready";
      entries: readonly QueueEntry[];
      /** A refresh is in flight; the table stays up meanwhile. */
      refreshing: boolean;
    }
  | { status: "failed"; failure: QueueFailure };

/** The queue, its loading line and every reason it might not be shown. */
export function ModConsole({ loadQueue, signedIn }: ModConsoleProps = {}) {
  const [state, setState] = useState<ConsoleState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    // The token store is only readable in the browser, so the answer is read
    // here (after mount) rather than during render: the first paint then
    // matches the server's HTML instead of flashing a sign-in prompt.
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "failed", failure: SIGNED_OUT_FAILURE });
      return;
    }

    let cancelled = false;
    // A refresh keeps the table on screen; only a first load shows the line.
    setState((current) =>
      current.status === "ready"
        ? { ...current, refreshing: true }
        : { status: "loading" },
    );

    const load = loadQueue ?? fetchQueue;
    load().then(
      (entries) => {
        if (!cancelled) {
          setState({ status: "ready", entries, refreshing: false });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", failure: classifyQueueError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, loadQueue, signedIn]);

  return (
    <div className="mc-page">
      <ConsoleHeader />

      {state.status === "loading" ? (
        <p className="mc-loading" role="status">
          Loading the moderation queue…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <FailureNotice failure={state.failure} onRetry={reload} />
      ) : null}

      {state.status === "ready" ? (
        <QueueView
          entries={state.entries}
          refreshing={state.refreshing}
          onRefresh={reload}
        />
      ) : null}
    </div>
  );
}

/** The page title and what the table is. */
function ConsoleHeader() {
  return (
    <header className="mc-header">
      <p className="mc-kicker mono-id">scholium / mod</p>
      <h1 className="mc-title">{MOD_TITLE}</h1>
      <p className="mc-lede">
        Versions waiting for a listing decision, oldest first. The signals come
        from automated checks and are there to inform your decision.
      </p>
    </header>
  );
}

/** The table with its count and refresh, or the one-sentence empty state. */
function QueueView({
  entries,
  refreshing,
  onRefresh,
}: {
  entries: readonly QueueEntry[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        className="mc-empty"
        sentence="Nothing is waiting for moderation."
        action={{ label: "Check again", onClick: onRefresh, disabled: refreshing }}
      />
    );
  }

  return (
    <>
      <div className="mc-toolbar">
        <p className="mc-count meta" role="status">
          {entries.length === 1
            ? "1 paper waiting"
            : `${entries.length} papers waiting`}
        </p>
        <button
          type="button"
          className="mc-button mc-button--quiet"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <QueueTable entries={entries} />
    </>
  );
}

/** Why there is no queue: no session, not a moderator, or a failed load. */
function FailureNotice({
  failure,
  onRetry,
}: {
  failure: QueueFailure;
  onRetry: () => void;
}) {
  if (failure.kind === "signed-out") {
    return (
      <div className="mc-notice" role="alert">
        <h2 className="mc-notice-title">Sign in to continue</h2>
        <p className="mc-notice-text">{failure.message}</p>
        <a className="mc-button" href={SIGNIN_HREF}>
          Sign in
        </a>
      </div>
    );
  }

  if (failure.kind === "forbidden") {
    return (
      <div className="mc-notice" role="alert">
        <h2 className="mc-notice-title">Moderators only</h2>
        <p className="mc-notice-text">
          {failure.message}
          {failure.callerTier === null
            ? ""
            : ` Your account is tier ${failure.callerTier}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="mc-notice" role="alert">
      <h2 className="mc-notice-title">Couldn&rsquo;t load the queue</h2>
      <p className="mc-notice-text">{failure.message}</p>
      <button type="button" className="mc-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default ModConsole;
