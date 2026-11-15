"use client";

/**
 * `/network` — what this Scholium node says about itself.
 *
 * The public transparency page of docs/design.md §5.8: the node's standing,
 * the head of its record log, the state of its last public-timestamp anchor,
 * its replication summary, and its moderation decisions counted by policy
 * clause (each clause linking to the rule on `/policies` it cites, through the
 * same anchor a decision banner uses). No account is needed; nothing here is
 * secret, and nothing on this page is an error state — "anchor pending" and
 * "1 of 1 local" are states, not failures (§1 "Calm under failure").
 *
 * Rendering is server-first: the route (`app/(network-page)/network/page.tsx`)
 * fetches once and passes `initialStatus`, so the HTML contains the whole
 * status with no API request from the browser (which also sidesteps CORS).
 * The client fallback exists for two reasons:
 *
 * - a direct render of this component without server data fetches on mount, and
 * - if the server-side fetch failed (API down, or a test that stubs the API
 *   only in the browser), the browser retries once and keeps the page useful.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { EmptyState, Icon, IdPill, type IconName } from "../ui-kit";
import { POLICIES_PATH, policyHref } from "../policies-page";

import {
  NETWORK_TITLE,
  anchorSpec,
  describeNetworkError,
  loadNetworkStatus as fetchNetworkStatus,
  moderationCountLine,
  replicaSegments,
  standingSpec,
  type AnchorSpec,
  type LogHeadStatus,
  type NetworkStatus,
  type ReplicaSummary,
  type StandingSpec,
  type StatusTone,
} from "./network";
import "./network-page.css";

/** Loads the status document; replaceable in tests. */
export type LoadNetworkStatus = () => Promise<NetworkStatus>;

/** Props for {@link NetworkPage}. Everything is optional. */
export interface NetworkPageProps {
  /**
   * Status fetched by the server route. When present the component renders it
   * immediately and does not fetch on mount.
   */
  initialStatus?: NetworkStatus;
  /** Failure message from a server-side fetch; the client retries on mount. */
  initialError?: string;
  /** Replace the loader, for tests or an alternate API client. */
  loadNetworkStatus?: LoadNetworkStatus;
}

type NetworkState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: NetworkStatus };

/** First paint state: server data wins, then a server error, then loading. */
function initialState(
  initialStatus: NetworkStatus | undefined,
  initialError: string | undefined,
): NetworkState {
  if (initialStatus) {
    return { status: "ready", summary: initialStatus };
  }
  if (initialError) {
    return { status: "error", message: initialError };
  }
  return { status: "loading" };
}

/** The transparency page: header, the live status, and its fallbacks. */
export function NetworkPage({
  initialStatus,
  initialError,
  loadNetworkStatus,
}: NetworkPageProps = {}) {
  const [state, setState] = useState<NetworkState>(() =>
    initialState(initialStatus, initialError),
  );
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    // Server data is already the answer; only fetch when there is none, or
    // when the reader asked to retry a failed load.
    if (initialStatus && attempt === 0) {
      return;
    }

    let cancelled = false;
    const load = loadNetworkStatus ?? fetchNetworkStatus;
    setState({ status: "loading" });

    load().then(
      (summary) => {
        if (!cancelled) {
          setState({ status: "ready", summary });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeNetworkError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, initialStatus, loadNetworkStatus]);

  return (
    <div className="np-page">
      <NetworkHeader />

      {state.status === "loading" ? (
        <p className="np-loading" role="status">
          Loading network status…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="np-notice" role="alert">
          <h2 className="np-notice-title">Couldn&rsquo;t load the network status</h2>
          <p className="np-notice-text">{state.message}</p>
          <button type="button" className="np-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <NetworkStatusView summary={state.summary} />
      ) : null}
    </div>
  );
}

/** The page title and the promise this page makes to readers. */
function NetworkHeader() {
  return (
    <header className="np-header">
      <p className="np-kicker mono-id">scholium / network</p>
      <h1 className="np-title">{NETWORK_TITLE}</h1>
      <p className="np-lede">
        What this node says about itself, in public: its standing, the head of
        its record log, its replication, and its moderation record. No account
        is needed to read any of it.
      </p>
    </header>
  );
}

/** The status document as four fact cards and the moderation statistics. */
function NetworkStatusView({ summary }: { summary: NetworkStatus }) {
  const clauses = Object.entries(summary.moderation.by_clause);

  return (
    <>
      <div className="np-grid">
        <NodeCard standing={standingSpec(summary.standing)} nodeDid={summary.node_did} />
        <LogHeadCard head={summary.log_head} />
        <AnchorCard anchor={anchorSpec(summary.last_anchor.status)} />
        <ReplicationCard replicas={summary.replicas} />
      </div>

      <ModerationSection total={summary.moderation.total} clauses={clauses} />
    </>
  );
}

/** A state chip: an icon, a word and a colour family — never colour alone. */
function Chip({
  icon,
  label,
  tone,
}: {
  icon: IconName;
  label: string;
  tone: StatusTone;
}) {
  return (
    <span className="np-chip" data-tone={tone}>
      <Icon name={icon} className="np-chip__icon" />
      <span className="np-chip__label">{label}</span>
    </span>
  );
}

/** One term and its value, the shape every card's facts share. */
function Fact({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) {
  return (
    <div className="np-fact">
      <dt className="np-fact-term">{term}</dt>
      <dd className="np-fact-value">{children}</dd>
    </div>
  );
}

/** This node: its federation standing and the DID a peer audits against. */
function NodeCard({ standing, nodeDid }: { standing: StandingSpec; nodeDid: string }) {
  return (
    <section className="np-card" aria-labelledby="np-node-heading">
      <h2 className="np-card-heading" id="np-node-heading">
        This node
      </h2>
      <dl className="np-facts">
        <Fact term="Standing">
          <Chip icon="circle" label={standing.label} tone={standing.tone} />
          <p className="np-note">{standing.meaning}</p>
        </Fact>
        <Fact term="Node DID">
          {/* The DID is reference text: copyable monospace, never a status. */}
          <IdPill schId={nodeDid} className="np-did" />
        </Fact>
      </dl>
    </section>
  );
}

/** The head of the append-only record log every public record appends to. */
function LogHeadCard({ head }: { head: LogHeadStatus }) {
  return (
    <section className="np-card" aria-labelledby="np-log-heading">
      <h2 className="np-card-heading" id="np-log-heading">
        Log head
      </h2>
      <dl className="np-facts">
        <Fact term="Sequence">
          <p className="np-sequence">{head.seq}</p>
          <p className="np-note">
            The last entry of the append-only record log every public record
            appends to.
          </p>
        </Fact>
        <Fact term="Entry hash">
          <code className="np-hash mono-id">{head.entry_hash}</code>
        </Fact>
      </dl>
    </section>
  );
}

/** The state of the node's most recent public-timestamp anchor. */
function AnchorCard({ anchor }: { anchor: AnchorSpec }) {
  return (
    <section className="np-card" aria-labelledby="np-anchor-heading">
      <h2 className="np-card-heading" id="np-anchor-heading">
        Public timestamp
      </h2>
      <dl className="np-facts">
        <Fact term="Last anchor">
          <Chip icon="pending" label={anchor.label} tone={anchor.tone} />
          <p className="np-note">{anchor.meaning}</p>
        </Fact>
      </dl>
    </section>
  );
}

/** The replication summary: a meter, the node's own words, and what they mean. */
function ReplicationCard({ replicas }: { replicas: ReplicaSummary }) {
  const segments = replicaSegments(replicas);

  return (
    <section className="np-card" aria-labelledby="np-replicas-heading">
      <h2 className="np-card-heading" id="np-replicas-heading">
        Replication
      </h2>
      <dl className="np-facts">
        <Fact term="Replicas">
          <p className="np-replica-summary">{replicas.summary}</p>
          {/* The meter is a picture of the summary line above it; the words
              carry the state, so the bar itself is hidden from assistive
              technology (status is never colour alone, design.md §3). */}
          <div className="np-meter" aria-hidden="true">
            {segments.map((filled, index) => (
              <span
                key={index}
                className="np-meter-segment"
                data-filled={filled ? "true" : "false"}
              />
            ))}
          </div>
          <p className="np-note">
            The only copy of every record lives on this server. Replication
            across several operators is not enabled yet.
          </p>
        </Fact>
      </dl>
    </section>
  );
}

/** Accepted moderation decisions, counted by the policy clause each cites. */
function ModerationSection({
  total,
  clauses,
}: {
  total: number;
  clauses: readonly (readonly [string, number])[];
}) {
  return (
    <section className="np-mod" aria-labelledby="np-mod-heading">
      <h2 className="np-section-heading" id="np-mod-heading">
        Moderation
      </h2>

      {clauses.length === 0 ? (
        <EmptyState
          sentence="No moderation decisions have been accepted yet."
          action={{ label: "Read the policies", href: POLICIES_PATH }}
        />
      ) : (
        <>
          <p className="np-count meta" role="status">
            {moderationCountLine(total)}
          </p>
          <table className="np-table">
            <caption className="np-visually-hidden">
              Accepted moderation decisions by policy clause
            </caption>
            <thead>
              <tr>
                <th scope="col" className="np-table-clause">
                  Policy clause
                </th>
                <th scope="col" className="np-num">
                  Decisions
                </th>
              </tr>
            </thead>
            <tbody>
              {clauses.map(([clause, count]) => (
                <tr key={clause}>
                  <th scope="row" className="np-table-clause">
                    <a className="np-clause-link mono-id" href={policyHref(clause)}>
                      {clause}
                    </a>
                  </th>
                  <td className="np-num">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export default NetworkPage;
