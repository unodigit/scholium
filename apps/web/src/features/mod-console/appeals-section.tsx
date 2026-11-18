"use client";

/**
 * Appeals in `/mod`: every appeal on this server, open ones first, each with
 * the panel vote form while the panel has not decided.
 *
 * The appeals come from the public log (see `appeals.ts`), which needs no
 * session; the API then says, per appeal, whether the signed-in account holds a
 * seat and what the decision was about. Casting a vote needs the session too,
 * and the API alone decides whether the account holds a seat. The section therefore does not depend on the queue's
 * tier-4 answer: a panel is drawn from tier 3 as well as tier 4, and a
 * reviewer who is not a moderator must still be able to reach their vote.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { EmptyState } from "../ui-kit/empty-state";
import { AppealCard } from "./appeal-card";
import type { LoadPersonName } from "./person";
import {
  describeAppealsError,
  isAppealOpen,
  loadAppealsForViewer,
  type AppealsLoad,
} from "./appeals";
import type { VoteCaster } from "./panel-vote";
import "./mod-console.css";

/** Loads the appeals; replaceable in tests. */
export type LoadAppeals = () => Promise<AppealsLoad>;

/** Props for {@link AppealsSection}. */
export interface AppealsSectionProps {
  /** Replace the loader, for tests or an alternate source. */
  loadAppeals?: LoadAppeals;
  /** Replace the vote sender, for tests. */
  castVote?: VoteCaster;
  /** Reads an appellant's profile name; replaceable in tests. */
  loadPerson?: LoadPersonName;
}

type SectionState =
  | { status: "loading" }
  | { status: "ready"; load: AppealsLoad; refreshing: boolean }
  | { status: "failed"; message: string };

/** The appeals list, its loading line and every reason it might not be shown. */
export function AppealsSection({
  loadAppeals,
  castVote,
  loadPerson,
}: AppealsSectionProps = {}) {
  const [state, setState] = useState<SectionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();

  const reload = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A refresh keeps the list on screen; only a first load shows the line.
    setState((current) =>
      current.status === "ready"
        ? { ...current, refreshing: true }
        : { status: "loading" },
    );

    const load = loadAppeals ?? loadAppealsForViewer;
    load().then(
      (result) => {
        if (!cancelled) {
          setState({ status: "ready", load: result, refreshing: false });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", message: describeAppealsError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, loadAppeals]);

  // Scroll to (and focus) the appeal named by the URL hash, both on load and
  // after client-side navigation.
  useEffect(() => {
    if (state.status !== "ready") return;
    const scrollToHash = () => {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      if (hash === "") return;
      const id = hash.replace(/^#/, "");
      const element = document.getElementById(id);
      if (element !== null) {
        if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ block: "start" });
        }
        if (typeof (element as HTMLElement).focus === "function") {
          (element as HTMLElement).focus();
        }
      }
    };
    scrollToHash();
    const onHashChange = () => scrollToHash();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [state.status, state.status === "ready" ? state.load : null]);

  return (
    <section className="mc-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="mc-section-title">
        Appeals
      </h2>
      <p className="mc-section-lede">
        An author can appeal a moderation decision once. Three members are drawn
        as a panel for each appeal, and when two of them agree the panel&rsquo;s
        decision is published.
      </p>

      {state.status === "loading" ? (
        <p className="mc-loading" role="status">
          Loading appeals…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <div className="mc-notice" role="alert">
          <h3 className="mc-notice-title">Couldn&rsquo;t load the appeals</h3>
          <p className="mc-notice-text">{state.message}</p>
          <button type="button" className="mc-button" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <AppealsList
          load={state.load}
          refreshing={state.refreshing}
          onRefresh={reload}
          castVote={castVote}
          loadPerson={loadPerson}
        />
      ) : null}
    </section>
  );
}

function AppealsList({
  load,
  refreshing,
  onRefresh,
  castVote,
  loadPerson,
}: {
  load: AppealsLoad;
  refreshing: boolean;
  onRefresh: () => void;
  castVote: VoteCaster | undefined;
  loadPerson?: LoadPersonName;
}) {
  const { cases, truncated } = load;

  if (cases.length === 0) {
    return (
      <>
        {truncated ? <TruncatedNote /> : null}
        <EmptyState
          className="mc-empty"
          sentence="No appeals have been filed."
          action={{
            label: "Check again",
            onClick: onRefresh,
            disabled: refreshing,
          }}
        />
      </>
    );
  }

  const open = cases.filter(isAppealOpen).length;
  return (
    <>
      <div className="mc-toolbar">
        <p className="mc-count meta" role="status">
          {open === 1 ? "1 appeal" : `${open} appeals`} waiting for a panel ·{" "}
          {cases.length - open} decided
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
      {truncated ? <TruncatedNote /> : null}
      <ul className="mc-case-list" aria-label="Appeals">
        {cases.map((appeal) => (
          <li key={appeal.appealCid}>
            <AppealCard appeal={appeal} castVote={castVote} loadPerson={loadPerson} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** The log was longer than the console reads; say so rather than hide appeals. */
function TruncatedNote() {
  return (
    <p className="mc-note" role="status">
      This server&rsquo;s log is longer than the console reads in one go, so
      appeals filed after the point it stopped are not shown.
    </p>
  );
}

export default AppealsSection;
