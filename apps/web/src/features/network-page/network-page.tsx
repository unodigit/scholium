"use client";

/**
 * `/network` — what this Scholium node says about itself.
 *
 * The public transparency page of docs/design.md §5.8: who operates the node
 * and which software it runs, its standing, the head of its record log, the
 * state of its last public-timestamp anchor, its availability-probe pass rate,
 * its replication summary (with the policy target and how many listed papers
 * sit at each replica health), its moderation decisions counted by policy
 * clause (each clause linking to the rule on `/policies` it cites, through the
 * same anchor a decision banner uses), its incident log, and how to download
 * the public export and rebuild it independently (PRD NET-2). No account is
 * needed; nothing here is secret, and nothing on this page is an error state —
 * "anchor pending", "1 of 1 local" and "No probes run yet" are states, not
 * failures (§1 "Calm under failure").
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
  EXPORT_ARCHIVE_PATH,
  EXPORT_REBUILD_COMMAND,
  EXPORT_VERIFY_COMMAND,
  NETWORK_TITLE,
  REPLICA_HEALTHS,
  anchorSpec,
  archiveExportHref,
  describeNetworkError,
  incidentDate,
  listedPapersLine,
  loadNetworkStatus as fetchNetworkStatus,
  moderationCountLine,
  policyTargetSentence,
  probeSummary,
  replicaHealthSegments,
  replicaHealthSpec,
  replicaSegments,
  standingSpec,
  type AnchorSpec,
  type IncidentEntry,
  type LogHeadStatus,
  type NetworkStatus,
  type ProbeStatistics,
  type ReplicaHealthCounts,
  type ReplicaSummary,
  type ReplicationPolicy,
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
        What this node says about itself, in public: who runs it, its standing,
        the head of its record log, its replication, its moderation record and
        its incidents. No account is needed to read any of it.
      </p>
    </header>
  );
}

/** The status document as fact cards, the moderation statistics, incidents and the export. */
function NetworkStatusView({ summary }: { summary: NetworkStatus }) {
  const clauses = Object.entries(summary.moderation.by_clause);

  return (
    <>
      <div className="np-grid">
        <NodeCard
          standing={standingSpec(summary.standing)}
          nodeDid={summary.node_did}
          operator={summary.operator}
          softwareVersion={summary.software_version}
        />
        <LogHeadCard head={summary.log_head} />
        <AnchorCard anchor={anchorSpec(summary.last_anchor.status)} />
        <ProbeCard probes={summary.probes} />
        <ReplicationCard
          replicas={summary.replicas}
          policy={summary.replication_policy}
          papersByHealth={summary.papers_by_replica_health}
        />
      </div>

      <ModerationSection total={summary.moderation.total} clauses={clauses} />

      <IncidentLogSection incidents={summary.incidents} />

      <PublicExportSection />
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
function NodeCard({
  standing,
  nodeDid,
  operator,
  softwareVersion,
}: {
  standing: StandingSpec;
  nodeDid: string;
  operator: string;
  softwareVersion: string;
}) {
  return (
    <section className="np-card" aria-labelledby="np-node-heading">
      <h2 className="np-card-heading" id="np-node-heading">
        This node
      </h2>
      <dl className="np-facts">
        <Fact term="Operator">
          <p className="np-value">{operator}</p>
        </Fact>
        <Fact term="Software version">
          <code className="np-value mono-id">{softwareVersion}</code>
        </Fact>
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

/** The replication summary: the node's own words, the policy target, and papers by health. */
function ReplicationCard({
  replicas,
  policy,
  papersByHealth,
}: {
  replicas: ReplicaSummary;
  policy: ReplicationPolicy;
  papersByHealth: ReplicaHealthCounts;
}) {
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
        <Fact term="Target">
          <p className="np-note">{policyTargetSentence(policy)}</p>
        </Fact>
        <Fact term="Listed papers">
          <PapersByHealth counts={papersByHealth} />
        </Fact>
      </dl>
    </section>
  );
}

/**
 * Listed papers at each replica health: a sentence, a segmented bar and one row
 * per health. Every health is listed, zero included. The bar only pictures the
 * rows (each carries its word and count), so it is hidden from assistive
 * technology and a colour is never the only way to read it.
 */
function PapersByHealth({ counts }: { counts: ReplicaHealthCounts }) {
  const segments = replicaHealthSegments(counts);

  return (
    <>
      <p className="np-note">{listedPapersLine(counts)}</p>
      {segments.length > 0 ? (
        <div className="np-health-meter" aria-hidden="true">
          {segments.map(({ health, count }) => (
            <span
              key={health}
              className="np-health-segment"
              data-health={health}
              style={{ flexGrow: count }}
            />
          ))}
        </div>
      ) : null}
      <ul className="np-health-list">
        {REPLICA_HEALTHS.map((health) => {
          const spec = replicaHealthSpec(health);
          return (
            <li key={health} className="np-health-row">
              <span
                className="np-health-swatch"
                data-health={health}
                aria-hidden="true"
              />
              <span className="np-health-label">{spec.label}</span>
              <span className="np-health-count">{counts[health]}</span>
              <span className="np-health-meaning">{spec.meaning}</span>
            </li>
          );
        })}
      </ul>
    </>
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

/** Availability-probe pass rate over the last 24 hours, or that none have run. */
function ProbeCard({ probes }: { probes: ProbeStatistics }) {
  const summary = probeSummary(probes);

  return (
    <section className="np-card" aria-labelledby="np-probes-heading">
      <h2 className="np-card-heading" id="np-probes-heading">
        Probe pass rate
      </h2>
      <dl className="np-facts">
        <Fact term={`Last ${probes.window_hours} hours`}>
          <p className="np-value">{summary.figure}</p>
          <p className="np-note">{summary.detail}</p>
        </Fact>
      </dl>
    </section>
  );
}

/** The public incident log; an empty one says so rather than disappearing. */
function IncidentLogSection({
  incidents,
}: {
  incidents: readonly IncidentEntry[];
}) {
  return (
    <section className="np-mod" aria-labelledby="np-incidents-heading">
      <h2 className="np-section-heading" id="np-incidents-heading">
        Incident log
      </h2>
      {incidents.length === 0 ? (
        <p className="np-note">No incidents recorded.</p>
      ) : (
        <ul className="np-incidents">
          {incidents.map((incident) => (
            <li
              key={`${incident.occurred_at}|${incident.title}`}
              className="np-incident"
            >
              <p className="np-incident-head">
                <time className="np-incident-date" dateTime={incident.occurred_at}>
                  {incidentDate(incident.occurred_at)}
                </time>
                <span className="np-incident-title">{incident.title}</span>
              </p>
              <p className="np-note">{incident.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How to take the whole public archive and check it without trusting this node
 * (PRD NET-2): the download link and the two commands that verify and rebuild it.
 */
function PublicExportSection() {
  return (
    <section className="np-mod" aria-labelledby="np-export-heading">
      <h2 className="np-section-heading" id="np-export-heading">
        Public export
      </h2>
      <p className="np-note">
        Every signed record, every public file and the whole log are available
        as one archive. Download it, check it, and rebuild it yourself; none of
        it depends on trusting this node.
      </p>
      <p className="np-export-download">
        <a className="np-export-link mono-id" href={archiveExportHref()}>
          {EXPORT_ARCHIVE_PATH}
        </a>
      </p>
      <div className="np-step">
        <p className="np-note">
          Check that every block and record in it is intact:
        </p>
        <pre className="np-code" tabIndex={0}>
          <code>{EXPORT_VERIFY_COMMAND}</code>
        </pre>
      </div>
      <div className="np-step">
        <p className="np-note">
          Rebuild its papers, versions and statuses into a fresh database:
        </p>
        <pre className="np-code" tabIndex={0}>
          <code>{EXPORT_REBUILD_COMMAND}</code>
        </pre>
      </div>
      <p className="np-note">
        Both commands exit 0 when everything checks out and 1 if anything in the
        archive was altered; a failed rebuild leaves no database behind.
      </p>
    </section>
  );
}

export default NetworkPage;
