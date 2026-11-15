"use client";

/**
 * `/policies` — the public moderation policy clauses.
 *
 * The page lists every clause from `GET /v1/moderation/policies` with its id,
 * title and text. Each clause is a target anchor (`#MOD-02`) so a moderation
 * decision banner can link straight to the rule it cites — use
 * {@link policyHref} from this feature, never a hand-built fragment.
 *
 * Rendering is server-first: the route (`app/(policies-page)/policies/page.tsx`)
 * fetches once and passes `initialClauses`, so the HTML contains the whole list
 * with no API request from the browser (which also sidesteps CORS). The client
 * fallback exists for two reasons:
 *
 * - a direct render of this component without server data fetches on mount, and
 * - if the server-side fetch failed (API down, or a test that stubs the API
 *   only in the browser), the browser retries once and keeps the page useful.
 *
 * The markup is plain HTML + design tokens; no per-clause interactivity.
 */

import { useCallback, useEffect, useState } from "react";

import {
  POLICIES_TITLE,
  describePoliciesError,
  loadPolicies as fetchPolicies,
  policyAnchorId,
  policyHref,
  type PolicyClause,
} from "./policies";
import "./policies-page.css";

/** Loads the clause list; replaceable in tests. */
export type LoadPolicies = () => Promise<readonly PolicyClause[]>;

/** Props for {@link PoliciesPage}. Everything is optional. */
export interface PoliciesPageProps {
  /**
   * Clauses fetched by the server route. When present the component renders
   * them immediately and does not fetch on mount.
   */
  initialClauses?: readonly PolicyClause[];
  /** Failure message from a server-side fetch; the client retries on mount. */
  initialError?: string;
  /** Replace the loader, for tests or an alternate API client. */
  loadPolicies?: LoadPolicies;
}

type PoliciesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; clauses: readonly PolicyClause[] };

/** First paint state: server data wins, then a server error, then loading. */
function initialState(
  initialClauses: readonly PolicyClause[] | undefined,
  initialError: string | undefined,
): PoliciesState {
  if (initialClauses) {
    return { status: "ready", clauses: initialClauses };
  }
  if (initialError) {
    return { status: "error", message: initialError };
  }
  return { status: "loading" };
}

/** The clause list, its loading line and its error state. */
export function PoliciesPage({
  initialClauses,
  initialError,
  loadPolicies,
}: PoliciesPageProps = {}) {
  const [state, setState] = useState<PoliciesState>(() =>
    initialState(initialClauses, initialError),
  );
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    // Server data is already the answer; only fetch when there is none, or
    // when the reader asked to retry a failed load.
    if (initialClauses && attempt === 0) {
      return;
    }

    let cancelled = false;
    const load = loadPolicies ?? fetchPolicies;
    setState({ status: "loading" });

    load().then(
      (clauses) => {
        if (!cancelled) {
          setState({ status: "ready", clauses });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describePoliciesError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, initialClauses, loadPolicies]);

  return (
    <div className="pp-page">
      <PoliciesHeader />

      {state.status === "loading" ? (
        <p className="pp-loading" role="status">
          Loading moderation policies…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="pp-notice" role="alert">
          <h2 className="pp-notice-title">Couldn&rsquo;t load the policies</h2>
          <p className="pp-notice-text">{state.message}</p>
          <button type="button" className="pp-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <PolicyClauseList clauses={state.clauses} />
      ) : null}
    </div>
  );
}

/** The page title and the promise this page makes to readers. */
function PoliciesHeader() {
  return (
    <header className="pp-header">
      <p className="pp-kicker mono-id">scholium / policies</p>
      <h1 className="pp-title">{POLICIES_TITLE}</h1>
      <p className="pp-lede">
        Every moderation decision cites one of these clauses by id. A decision
        is a public, signed record, and its banner links straight to the clause
        it cites.
      </p>
    </header>
  );
}

/** The clause list, or the one-sentence empty state (design.md §7). */
function PolicyClauseList({ clauses }: { clauses: readonly PolicyClause[] }) {
  if (clauses.length === 0) {
    return (
      <p className="pp-empty" role="status">
        No moderation policy clauses have been published yet.
      </p>
    );
  }

  return (
    <>
      <p className="pp-count meta" role="status">
        {clauses.length === 1 ? "1 clause" : `${clauses.length} clauses`}
      </p>
      <ol className="pp-list">
        {clauses.map((clause) => (
          <PolicyClauseCard key={clause.id} clause={clause} />
        ))}
      </ol>
    </>
  );
}

/** One clause: an anchor target and a permalink to itself. */
function PolicyClauseCard({ clause }: { clause: PolicyClause }) {
  const anchor = policyAnchorId(clause.id);
  const titleId = `${anchor}-title`;

  return (
    <li className="pp-clause" id={anchor}>
      <article className="pp-clause-body" aria-labelledby={titleId}>
        <header className="pp-clause-head">
          <h2 className="pp-clause-title" id={titleId}>
            {clause.title}
          </h2>
          <a
            className="pp-permalink mono-id"
            href={policyHref(clause.id)}
            aria-label={`Link to clause ${clause.id}: ${clause.title}`}
          >
            {clause.id}
          </a>
        </header>
        <p className="pp-clause-text">{clause.text}</p>
      </article>
    </li>
  );
}

export default PoliciesPage;
