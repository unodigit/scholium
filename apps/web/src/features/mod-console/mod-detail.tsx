"use client";

/**
 * The moderation detail view (docs/design.md §5.7): the paper beside the
 * decision form.
 *
 * The route `/mod/{versionCid}` opens one version waiting in the queue. The
 * paper pane is read from the version's signed record
 * (`GET /v1/records/{cid}`); the form cites one of the clauses from
 * `GET /v1/moderation/policies`. Both are public reads, but the console is a
 * tier-4 surface, so a visitor with no session is asked to sign in before any
 * request is made, and the API still refuses a decision from a non-moderator.
 *
 * The first paint is the shell and a loading line (as on `/mod`): the record
 * and clauses are fetched in the browser so the server HTML never depends on
 * an API that may be unreachable, and a signed-in moderator never sees a
 * flash of the sign-in prompt.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { tokenStore } from "../../lib/api";
import type { PolicyClause } from "../policies-page";
import { RecordLink } from "../ui-kit";
import {
  PAPER_SIGNED_OUT_FAILURE,
  classifyPaperError,
  loadDecisionClauses,
  loadModeratedPaper,
  type ModeratedPaper,
  type PaperFailure,
  type DecisionSigner,
  type DecisionSubmitter,
} from "./decision";
import { DecisionForm } from "./decision-form";
import { MOD_PATH, modDetailSignInHref } from "./queue";
import "./mod-console.css";

/** Reads the version's signed record; replaceable in tests. */
export type LoadPaper = (versionCid: string) => Promise<ModeratedPaper>;

/** Reads the policy clauses; replaceable in tests. */
export type LoadClauses = () => Promise<readonly PolicyClause[]>;

/** Props for {@link ModDetail}. */
export interface ModDetailProps {
  /** The version being decided (the route's `[cid]`). */
  versionCid: string;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  signedIn?: boolean;
  /** Replace the paper loader, for tests or an alternate API client. */
  loadPaper?: LoadPaper;
  /** Replace the clause loader, for tests or an alternate API client. */
  loadClauses?: LoadClauses;
  /** Replace the passkey signer, for tests. */
  signDecision?: DecisionSigner;
  /** Replace the submitter, for tests. */
  submitDecision?: DecisionSubmitter;
}

type DetailState =
  | { status: "loading" }
  | {
      status: "ready";
      paper: ModeratedPaper;
      clauses: readonly PolicyClause[];
    }
  | { status: "failed"; failure: PaperFailure };

/** The paper, the decision form, and every reason either might not appear. */
export function ModDetail({
  versionCid,
  signedIn,
  loadPaper = loadModeratedPaper,
  loadClauses = loadDecisionClauses,
  signDecision,
  submitDecision,
}: ModDetailProps) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    // The token store is only readable in the browser, so it is read here
    // (after mount) rather than during render: the first paint matches the
    // server's HTML instead of flashing a sign-in prompt.
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "failed", failure: PAPER_SIGNED_OUT_FAILURE });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    Promise.all([loadPaper(versionCid), loadClauses()]).then(
      ([paper, clauses]) => {
        if (!cancelled) {
          setState({ status: "ready", paper, clauses });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", failure: classifyPaperError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, loadClauses, loadPaper, signedIn, versionCid]);

  return (
    <div className="mc-detail">
      <DetailHeader versionCid={versionCid} />

      {state.status === "loading" ? (
        <p className="mc-loading" role="status">
          Loading the paper…
        </p>
      ) : null}

      {state.status === "failed" ? (
        <DetailNotice
          failure={state.failure}
          versionCid={versionCid}
          onRetry={retry}
        />
      ) : null}

      {state.status === "ready" ? (
        <div className="mc-detail-grid">
          <PaperPane paper={state.paper} />
          <DecisionForm
            versionCid={state.paper.versionCid}
            clauses={state.clauses}
            signDecision={signDecision}
            submitDecision={submitDecision}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The page title and the promise the form makes. */
function DetailHeader({ versionCid }: { versionCid: string }) {
  return (
    <header className="mc-detail-header">
      <p className="mc-kicker mono-id">scholium / mod</p>
      <h1 className="mc-title">Moderation decision</h1>
      <p className="mc-lede">
        Read the paper, then record a decision. Every decision cites a policy
        clause and gives the author a reason.
      </p>
      <p className="mc-detail-back">
        <a className="mc-link" href={MOD_PATH}>
          ← Back to the queue
        </a>
        <span className="mc-sr-only">Version {versionCid}</span>
      </p>
    </header>
  );
}

/**
 * The paper as its signed version record describes it.
 *
 * The version is waiting for moderation, so it is not in the public catalog
 * and has no readable HTML rendition yet; what a moderator decides on is the
 * signed metadata and abstract. The record link opens the envelope itself.
 */
export function PaperPane({ paper }: { paper: ModeratedPaper }) {
  const titleId = useId();
  const abstractId = useId();
  const authors =
    paper.authors.length === 0
      ? "Not listed"
      : paper.authors.map((author) => author.name).join(", ");
  const categories =
    paper.categories.length === 0 ? "—" : paper.categories.join(", ");
  const version = paper.versionId ?? "—";

  return (
    <article className="mc-paper-card" aria-labelledby={titleId}>
      <p className="mc-section-kicker">The paper</p>
      <h2 id={titleId} className="mc-paper-title-lg">
        {paper.title}
      </h2>

      <dl className="mc-paper-facts">
        <div>
          <dt>Authors</dt>
          <dd>{authors}</dd>
        </div>
        <div>
          <dt>Categories</dt>
          <dd>{categories}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd className="mono-id">{version}</dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>{paper.licence ?? "—"}</dd>
        </div>
      </dl>

      <section className="mc-paper-abstract" aria-labelledby={abstractId}>
        <h3 id={abstractId} className="mc-abstract-title">
          Abstract
        </h3>
        {paper.abstract === "" ? (
          <p className="mc-paper-muted">This version has no abstract.</p>
        ) : (
          <p className="mc-abstract-text">{paper.abstract}</p>
        )}
      </section>

      {paper.changeNote !== null ? (
        <p className="mc-paper-change-note">
          <span className="mc-paper-fact-label">Change note:</span>{" "}
          {paper.changeNote}
        </p>
      ) : null}

      <div className="mc-paper-record">
        <RecordLink
          cid={paper.versionCid}
          label="View the signed version record"
        />
      </div>
    </article>
  );
}

/** Why there is no paper: no session, not a moderator, or a failed load. */
function DetailNotice({
  failure,
  versionCid,
  onRetry,
}: {
  failure: PaperFailure;
  versionCid: string;
  onRetry: () => void;
}) {
  if (failure.kind === "signed-out") {
    return (
      <div className="mc-notice" role="alert">
        <h2 className="mc-notice-title">Sign in to continue</h2>
        <p className="mc-notice-text">{failure.message}</p>
        <a className="mc-button" href={modDetailSignInHref(versionCid)}>
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
      <h2 className="mc-notice-title">Couldn&rsquo;t load this paper</h2>
      <p className="mc-notice-text">{failure.message}</p>
      <button type="button" className="mc-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default ModDetail;
