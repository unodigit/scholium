"use client";

/**
 * The moderation detail view (docs/design.md §5.7): what was flagged beside
 * the decision form.
 *
 * The route `/mod/{cid}` opens whatever a flag named — a paper version, a
 * discussion post, an inline annotation or a review. The item is read from
 * its signed record (`GET /v1/records/{cid}`): a paper version becomes the
 * paper pane with its PDF and extracted text, anything else becomes a record
 * pane (author, text, owning paper) with the flags against it. The form cites
 * one of the clauses from `GET /v1/moderation/policies`. The reads are
 * public, but the console is a tier-4 surface, so a visitor with no session is
 * asked to sign in before any request is made, and the API still refuses a
 * decision from a non-moderator.
 *
 * The version's PDF and text are not public while it waits, so they are
 * fetched with the moderator's token, each on its own: a PDF or text that
 * cannot be read never hides the form.
 *
 * The first paint is the shell and a loading line (as on `/mod`): the record
 * and clauses are fetched in the browser so the server HTML never depends on
 * an API that may be unreachable, and a signed-in moderator never sees a
 * flash of the sign-in prompt.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { tokenStore } from "../../lib/api";
import type { PolicyClause } from "../policies-page";
import { RecordLink } from "../ui-kit";
import { formatDate } from "./wire";
import {
  PAPER_SIGNED_OUT_FAILURE,
  classifyPaperError,
  loadDecisionClauses,
  loadVersionState,
  shortenDid,
  type DecisionSigner,
  type DecisionSubmitter,
  type LoadVersionState,
  type ModeratedPaper,
  type PaperAuthor,
  type PaperFailure,
} from "./decision";
import { DecisionForm } from "./decision-form";
import { licenceName } from "./licence";
import {
  VersionContent,
  type LoadPdfFile,
  type LoadText,
} from "./version-content";
import { MOD_PATH, modDetailSignInHref } from "./queue";
import {
  REVIEW_FORMAL_TYPE,
  loadModerationItem,
  recordHeading,
  recordKindLabel,
  recordPaperHref,
  type LoadFlagTarget,
  type LoadItem,
  type ModerationItem,
  type ModeratedRecord,
} from "./record";
import type { LoadTargetFlags } from "./flags";
import { PersonName, type LoadPersonName } from "./person";
import { RecordDecisionForm } from "./record-decision-form";
import { RecordFlags } from "./record-flags";
import type { LoadPdfjs } from "../paper-page/pdf-render";
import "./mod-console.css";

/** Reads the version's signed record; replaceable in tests. */
export type LoadPaper = (versionCid: string) => Promise<ModeratedPaper>;

/** Reads the policy clauses; replaceable in tests. */
export type LoadClauses = () => Promise<readonly PolicyClause[]>;

/** Props for {@link ModDetail}. */
export interface ModDetailProps {
  /** The record being decided (the route's `[cid]`). */
  versionCid: string;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  signedIn?: boolean;
  /**
   * Replace the whole item loader, for tests or an alternate API client. By
   * default the record is read from `GET /v1/records/{cid}`: a paper version
   * becomes the paper pane, anything else a record pane.
   */
  loadItem?: LoadItem;
  /**
   * Replace the paper loader alone, for tests that only ever decide a paper
   * version. An explicit {@link loadItem} wins.
   */
  loadPaper?: LoadPaper;
  /** Replace the clause loader, for tests or an alternate API client. */
  loadClauses?: LoadClauses;
  /**
   * Replace the reader of the version's state (`listed`, `moderation`, …),
   * which decides whether "List the paper" is offered. By default it is read
   * from `GET /v1/moderation/targets/{cid}`; a state it cannot read offers
   * every action.
   */
  loadVersionState?: LoadVersionState;
  /** Replace the flags-against-this-record loader, for tests. */
  loadFlags?: LoadTargetFlags;
  /** Replace the flag-target summary loader, for tests. */
  loadTarget?: LoadFlagTarget;
  /** Replace how a person's profile name is read, for tests. */
  loadPerson?: LoadPersonName;
  /** Replace the text loader, for tests or an alternate API client. */
  loadText?: LoadText;
  /** Replace the PDF finder, for tests or an alternate API client. */
  loadPdfFile?: LoadPdfFile;
  /** Replace how PDF.js is fetched, for tests. Opens files with the moderator's token by default. */
  loadPdfjs?: LoadPdfjs;
  /**
   * Pin the moderator's trust tier, which decides whether the legal takedown
   * is offered. When omitted it is read from the access token.
   */
  tier?: number | null;
  /** Replace the passkey signer, for tests. */
  signDecision?: DecisionSigner;
  /** Replace the submitter, for tests. */
  submitDecision?: DecisionSubmitter;
}

type DetailState =
  | { status: "loading" }
  | {
      status: "ready";
      item: ModerationItem;
      clauses: readonly PolicyClause[];
      /** The state of the paper version being decided; `null` when unknown. */
      versionState: string | null;
    }
  | { status: "failed"; failure: PaperFailure };

/** The record, the decision form, and every reason either might not appear. */
export function ModDetail({
  versionCid,
  signedIn,
  loadItem,
  loadPaper,
  loadClauses = loadDecisionClauses,
  loadVersionState: readVersionState = loadVersionState,
  loadFlags,
  loadTarget,
  loadPerson,
  loadText,
  loadPdfFile,
  loadPdfjs,
  tier,
  signDecision,
  submitDecision,
}: ModDetailProps) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [flagsRefresh, setFlagsRefresh] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  const load = useMemo<LoadItem>(() => {
    if (loadItem !== undefined) {
      return loadItem;
    }
    if (loadPaper !== undefined) {
      return async (cid) => ({ kind: "paper", paper: await loadPaper(cid) });
    }
    return loadModerationItem;
  }, [loadItem, loadPaper]);

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

    Promise.all([
      load(versionCid).then(async (item) => {
        // The form leaves out "List the paper" for a paper that is listed, so
        // the state is read before the form is shown. Not knowing it is not a
        // failure: every action is offered then, and the API is the gate.
        let versionState: string | null = null;
        if (item.kind === "paper") {
          try {
            versionState = await readVersionState(item.paper.versionCid);
          } catch {
            versionState = null;
          }
        }
        return { item, versionState };
      }),
      loadClauses(),
    ]).then(
      ([{ item, versionState }, clauses]) => {
        if (!cancelled) {
          setState({ status: "ready", item, clauses, versionState });
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
  }, [attempt, load, loadClauses, readVersionState, signedIn, versionCid]);

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

      {state.status === "ready" && state.item.kind === "paper" ? (
        <div className="mc-detail-grid">
          <div className="mc-detail-paper">
            <PaperPane paper={state.item.paper} loadPerson={loadPerson} />
            <VersionContent
              paper={state.item.paper}
              loadText={loadText}
              loadPdfFile={loadPdfFile}
              loadPdfjs={loadPdfjs}
            />
          </div>
          <DecisionForm
            versionCid={state.item.paper.versionCid}
            clauses={state.clauses}
            tier={tier}
            versionState={state.versionState}
            signDecision={signDecision}
            submitDecision={submitDecision}
          />
        </div>
      ) : null}

      {state.status === "ready" && state.item.kind === "record" ? (
        <div className="mc-detail-grid">
          <div className="mc-detail-paper">
            <RecordPane record={state.item.record} loadPerson={loadPerson} />
            <RecordFlags
              targetCid={state.item.record.cid}
              loadFlags={loadFlags}
              loadTarget={loadTarget}
              loadPerson={loadPerson}
              refreshKey={flagsRefresh}
            />
          </div>
          <RecordDecisionForm
            record={state.item.record}
            clauses={state.clauses}
            signDecision={signDecision}
            submitDecision={submitDecision}
            onPublished={() => setFlagsRefresh((count) => count + 1)}
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
        Read what was flagged, then record a decision. Every decision cites a
        policy clause and gives a reason.
      </p>
      <p className="mc-detail-back">
        <a className="mc-link" href={MOD_PATH}>
          ← Back to the queue
        </a>
        <span className="mc-sr-only">Record {versionCid}</span>
      </p>
    </header>
  );
}

/**
 * The paper as its signed version record describes it.
 *
 * The version is waiting for moderation, so it is not in the public catalog.
 * This card is the signed metadata and abstract; the PDF and extracted text
 * follow it ({@link VersionContent}). The record link opens the envelope itself.
 *
 * An author the byline names is shown as named; one the byline carries as a
 * bare DID is resolved through their public profile ({@link PersonName}), with
 * the DID kept as secondary text.
 */
export function PaperPane({
  paper,
  loadPerson,
}: {
  paper: ModeratedPaper;
  /** Replace how an author's profile name is read, for tests. */
  loadPerson?: LoadPersonName;
}) {
  const titleId = useId();
  const abstractId = useId();
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
          <dd>
            <PaperAuthors authors={paper.authors} loadPerson={loadPerson} />
          </dd>
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
          <dd>{paper.licence === null ? "—" : licenceName(paper.licence)}</dd>
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

/**
 * The byline's authors: a named one as named, a bare DID through their profile.
 *
 * The signed record names an author as the submitter chose to (a name, a DID,
 * or both); {@link parseVersionRecord} falls back to the DID when no name is
 * in the record, which is exactly the author whose profile the node may still
 * resolve — so that fallback, and only it, goes through {@link PersonName}.
 */
function PaperAuthors({
  authors,
  loadPerson,
}: {
  authors: readonly PaperAuthor[];
  loadPerson?: LoadPersonName;
}) {
  if (authors.length === 0) {
    return <>Not listed</>;
  }
  // A byline whose authors all carry a real name renders as a single text
  // node, so callers can match it verbatim; a byline that falls back to a DID
  // for at least one author resolves that DID through its profile instead.
  const allNamed = authors.every(
    (author) => author.did === "" || author.name !== shortenDid(author.did),
  );
  if (allNamed) {
    return <>{authors.map((author) => author.name).join(", ")}</>;
  }
  return (
    <>
      {authors.map((author, index) => (
        <span key={`${author.did}-${index}`}>
          {index > 0 ? ", " : null}
          {author.did !== "" && author.name === shortenDid(author.did) ? (
            <PersonName did={author.did} loadName={loadPerson} />
          ) : (
            author.name
          )}
        </span>
      ))}
    </>
  );
}

/**
 * A flagged record that is not a paper version: a post, an annotation or a
 * review.
 *
 * The moderator sees what the reporter saw — the author (their profile name
 * with the DID beside it when the node knows one), the text or quoted passage,
 * and the paper the record belongs to, linked — rather than an error. The
 * record is public and signed, so its own window is one click away. A record
 * whose owning paper the node cannot resolve is still shown; only the link is
 * missing.
 */
export function RecordPane({
  record,
  loadPerson,
}: {
  record: ModeratedRecord;
  /** Replace how the author's profile name is read, for tests. */
  loadPerson?: LoadPersonName;
}) {
  const titleId = useId();
  const textId = useId();
  const kind = recordKindLabel(record);
  const paperHref = recordPaperHref(record);
  const signed = formatDate(record.created);

  return (
    <article className="mc-paper-card mc-record-card" aria-labelledby={titleId}>
      <p className="mc-section-kicker">{kind}</p>
      <h2 id={titleId} className="mc-paper-title-lg">
        {recordHeading(record)}
      </h2>

      <dl className="mc-paper-facts">
        <div>
          <dt>{record.type === REVIEW_FORMAL_TYPE ? "Reviewer" : "Author"}</dt>
          <dd
            title={
              record.authorDid === "" || record.type === REVIEW_FORMAL_TYPE
                ? undefined
                : record.authorDid
            }
          >
            {record.type === REVIEW_FORMAL_TYPE ? (
              // A review is signed by a pseudonymous per-paper key: its public
              // label, never that key's DID.
              record.reviewerLabel ?? "Anonymous reviewer"
            ) : record.authorDid === "" ? (
              "Not listed"
            ) : (
              <PersonName did={record.authorDid} loadName={loadPerson} />
            )}
          </dd>
        </div>
        <div>
          <dt>Record type</dt>
          <dd>{record.type}</dd>
        </div>
        {record.paperTitle !== null ? (
          <div>
            <dt>Paper</dt>
            <dd>
              {paperHref === null ? (
                record.paperTitle
              ) : (
                <a className="mc-link" href={paperHref}>
                  {record.paperTitle}
                </a>
              )}
            </dd>
          </div>
        ) : null}
        {record.versionId !== null ? (
          <div>
            <dt>Version</dt>
            <dd className="mono-id">{record.versionId}</dd>
          </div>
        ) : null}
        {signed !== null ? (
          <div>
            <dt>Signed</dt>
            <dd>{signed}</dd>
          </div>
        ) : null}
      </dl>

      {record.quote !== null ? (
        <section className="mc-record-quote" aria-label="Quoted passage">
          <h3 className="mc-abstract-title">Quoted passage</h3>
          <blockquote>{record.quote}</blockquote>
        </section>
      ) : null}

      <section className="mc-paper-abstract" aria-labelledby={textId}>
        <h3 id={textId} className="mc-abstract-title">
          What was flagged
        </h3>
        {record.text === null ? (
          <p className="mc-paper-muted">
            This record carries no inline text. Open the signed record to read
            it in full.
          </p>
        ) : (
          <p className="mc-abstract-text mc-record-text">{record.text}</p>
        )}
      </section>

      <div className="mc-paper-record">
        <RecordLink cid={record.cid} label="View the signed record" />
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
