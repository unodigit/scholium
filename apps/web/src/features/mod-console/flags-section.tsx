"use client";

/**
 * Flags in `/mod`: reports of a paper, post or review, and a way to open one
 * by its id.
 *
 * Flags are moderator-only (`GET /v1/flags/{id}` answers a lower tier `404`),
 * and the API decides: this section never reads the tier itself. Two reads
 * feed it (see `flags.ts`):
 *
 * - the **list**, which this server may not serve yet. When it does not
 *   (`404`/`405`), the section says so in one sentence rather than showing an
 *   empty list, which would claim there are no flags;
 * - the **lookup by id**, which works today.
 */

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
} from "react";

import { EmptyState } from "../ui-kit/empty-state";
import { Icon, RecordLink } from "../ui-kit";
import { shortenDid } from "./decision";
import {
  classifyFlagsError,
  flagDecisionHref,
  flagSignal,
  formatFlagReason,
  isFlagOpen,
  loadFlag as fetchFlag,
  loadFlags as fetchFlags,
  type FlagEntry,
  type FlagsFailure,
} from "./flags";
import { SIGNIN_HREF } from "./queue";
import { SignalCell } from "./queue-table";
import "./mod-console.css";

/** Loads the flag list; replaceable in tests. */
export type LoadFlags = () => Promise<readonly FlagEntry[]>;

/** Loads one flag by id; replaceable in tests. */
export type LoadFlag = (id: string) => Promise<FlagEntry>;

/** Props for {@link FlagsSection}. */
export interface FlagsSectionProps {
  loadFlags?: LoadFlags;
  loadFlag?: LoadFlag;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; flags: readonly FlagEntry[]; refreshing: boolean }
  | { status: "failed"; failure: FlagsFailure };

/** The flag list, the lookup by id, and every reason either might not show. */
export function FlagsSection({ loadFlags, loadFlag }: FlagsSectionProps = {}) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();

  const reload = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((current) =>
      current.status === "ready"
        ? { ...current, refreshing: true }
        : { status: "loading" },
    );

    const load = loadFlags ?? fetchFlags;
    load().then(
      (flags) => {
        if (!cancelled) {
          setState({ status: "ready", flags, refreshing: false });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "failed",
            failure: classifyFlagsError(error, "list"),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, loadFlags]);

  return (
    <section className="mc-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="mc-section-title">
        Flags
      </h2>
      <p className="mc-section-lede">
        Members can flag a paper, post or review. A moderation decision settles
        the flag, and the person who reported it sees the outcome.
      </p>

      {state.status === "loading" ? (
        <p className="mc-loading" role="status">
          Loading flags…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <FlagsFailureNotice failure={state.failure} onRetry={reload} />
      ) : null}

      {state.status === "ready" ? (
        <FlagList
          flags={state.flags}
          refreshing={state.refreshing}
          onRefresh={reload}
        />
      ) : null}

      <FlagLookup loadFlag={loadFlag} />
    </section>
  );
}

function FlagList({
  flags,
  refreshing,
  onRefresh,
}: {
  flags: readonly FlagEntry[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (flags.length === 0) {
    return (
      <EmptyState
        className="mc-empty"
        sentence="No flags are waiting."
        action={{
          label: "Check again",
          onClick: onRefresh,
          disabled: refreshing,
        }}
      />
    );
  }

  const open = flags.filter(isFlagOpen).length;
  return (
    <>
      <div className="mc-toolbar">
        <p className="mc-count meta" role="status">
          {open === 1 ? "1 flag" : `${open} flags`} waiting ·{" "}
          {flags.length - open} decided
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
      <ul className="mc-case-list" aria-label="Flags">
        {flags.map((flag) => (
          <li key={flag.id}>
            <FlagCard flag={flag} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** One flag: why it was raised, what it is about, and where it stands. */
export function FlagCard({ flag }: { flag: FlagEntry }) {
  const open = isFlagOpen(flag);
  const headingId = `flag-${flag.id}-title`;
  return (
    <article className="mc-case" aria-labelledby={headingId}>
      <header className="mc-case-header">
        <div className="mc-case-heading">
          <p className="mc-section-kicker">Flag</p>
          <h3 id={headingId} className="mc-case-title">
            {formatFlagReason(flag.reason)}
          </h3>
        </div>
        <SignalCell signal={flagSignal(flag)} />
      </header>

      <dl className="mc-case-facts">
        <div>
          <dt>Flagged record</dt>
          <dd className="mono-id mc-case-id">{flag.targetCid}</dd>
        </div>
        {flag.reporterDid !== null ? (
          <div>
            <dt>Reported by</dt>
            <dd>{shortenDid(flag.reporterDid)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Flag id</dt>
          <dd className="mono-id mc-case-id">{flag.id}</dd>
        </div>
      </dl>

      <div className="mc-case-links">
        <RecordLink
          cid={flag.targetCid}
          label="View the flagged record"
          title="Flagged record"
          className="mc-button mc-button--quiet"
        />
        {open ? (
          <a className="mc-button" href={flagDecisionHref(flag)}>
            Decide on it
          </a>
        ) : flag.decisionCid !== null ? (
          <RecordLink
            cid={flag.decisionCid}
            label="View the decision"
            title="Signed moderation decision"
            className="mc-button mc-button--quiet"
          />
        ) : null}
      </div>
    </article>
  );
}

/** Why the list is not shown. Expected conditions are a note; faults are an alert. */
function FlagsFailureNotice({
  failure,
  onRetry,
}: {
  failure: FlagsFailure;
  onRetry: () => void;
}) {
  if (failure.kind === "unsupported") {
    return (
      <p className="mc-note" role="status">
        {failure.message}
      </p>
    );
  }

  if (failure.kind === "forbidden") {
    return (
      <p className="mc-note" role="status">
        {failure.message}
        {failure.callerTier === null
          ? ""
          : ` Your account is tier ${failure.callerTier}.`}
      </p>
    );
  }

  if (failure.kind === "signed-out") {
    return (
      <div className="mc-notice" role="alert">
        <h3 className="mc-notice-title">Sign in to see flags</h3>
        <p className="mc-notice-text">{failure.message}</p>
        <a className="mc-button" href={SIGNIN_HREF}>
          Sign in
        </a>
      </div>
    );
  }

  return (
    <div className="mc-notice" role="alert">
      <h3 className="mc-notice-title">Couldn&rsquo;t load the flags</h3>
      <p className="mc-notice-text">{failure.message}</p>
      <button type="button" className="mc-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "found"; flag: FlagEntry }
  | { status: "failed"; message: string };

/** Open one flag by its id (`GET /v1/flags/{id}`). */
function FlagLookup({ loadFlag }: { loadFlag: LoadFlag | undefined }) {
  const [id, setId] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });
  const baseId = useId();
  const inputId = `${baseId}-flag-id`;
  const busy = state.status === "loading";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const wanted = id.trim();
    if (wanted === "") {
      setState({ status: "failed", message: "Enter the id of the flag." });
      return;
    }

    setState({ status: "loading" });
    try {
      const flag = await (loadFlag ?? fetchFlag)(wanted);
      setState({ status: "found", flag });
    } catch (error) {
      setState({
        status: "failed",
        message: classifyFlagsError(error, "lookup").message,
      });
    }
  };

  return (
    <form
      className="mc-lookup"
      onSubmit={handleSubmit}
      aria-label="Flag lookup"
      noValidate
    >
      <label className="mc-label" htmlFor={inputId}>
        Open a flag by its id
      </label>
      <div className="mc-lookup-row">
        <input
          id={inputId}
          className="mc-input"
          type="text"
          value={id}
          placeholder="Flag id"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setId(event.target.value)}
        />
        <button
          type="submit"
          className="mc-button"
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Opening…" : "Open flag"}
        </button>
      </div>

      {state.status === "failed" ? (
        <div className="mc-form-error" role="alert">
          <Icon name="alert" className="mc-form-error-icon" />
          <p className="mc-form-error-text">{state.message}</p>
        </div>
      ) : null}

      {state.status === "found" ? (
        <div className="mc-lookup-result">
          <FlagCard flag={state.flag} />
        </div>
      ) : null}
    </form>
  );
}

export default FlagsSection;
