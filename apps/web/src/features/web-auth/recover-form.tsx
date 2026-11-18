"use client";

/**
 * The `/recover` card (feature 144): identify by ORCID iD, then follow the
 * guardians' approvals and the 72-hour safety window.
 *
 * The design's flow (`docs/design.md` §6):
 *
 * ```text
 * "Lost your device?" → identify by ORCID → guardians approve
 *   → progress "2 of 3 approvals" → 72-hour safety window with a cancel link
 *   → new passkey
 * ```
 *
 * Two states, one card:
 *
 * - **identify** — the ORCID iD input and a short "what happens next" note.
 *   Submitting creates the new passkey on this device when there is none and
 *   opens the request.
 * - **progress** — the approval meter (`2 of 3 approvals`), the guardian
 *   count, the 72-hour safety window with its deadline, and the cancel link.
 *   "Check for approvals" re-reads the status; a cancel prompts for the
 *   passkey of the key still on the account.
 *
 * Behaviour lives in `useRecover`; this file is markup only, apart from one
 * best-effort read: once the status route names the account's DID, the page
 * reads its public profile so the card names the person by the name they
 * chose, with the ORCID iD secondary.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiClient } from "../../lib/api";

import {
  fetchRecoveryStatus,
  loadRecoveryAccountName,
  normalizeOrcid,
  isCancellable,
  formatRecoveryDeadline,
  type RecoveryClient,
  type RecoverySnapshot,
} from "./recover";
import {
  RECOVER_ACCOUNT_LABEL,
  RECOVER_APPROVALS_HEADING,
  RECOVER_BACK_TO_SIGNIN,
  RECOVER_CANCEL_ACTION,
  RECOVER_CANCEL_NOTE,
  RECOVER_CANCELLING,
  RECOVER_HOW_IT_WORKS,
  RECOVER_HOW_IT_WORKS_TITLE,
  RECOVER_LEDE,
  RECOVER_ORCID_HINT,
  RECOVER_ORCID_LABEL,
  RECOVER_ORCID_PLACEHOLDER,
  RECOVER_REFRESHING,
  RECOVER_REFRESH_ACTION,
  RECOVER_REQUEST_ID_LABEL,
  RECOVER_RESET_ACTION,
  RECOVER_SAFETY_WINDOW_HEADING,
  RECOVER_STARTING,
  RECOVER_START_ACTION,
  RECOVER_STATUS_UNAVAILABLE_NOTE,
  RECOVER_TITLE,
  recoveryAccountLabel,
  recoveryProgressLine,
  recoveryProgressNote,
  recoveryStatusLabel,
  safetyWindowNote,
} from "./recover-messages";
import { useRecover, type RecoveryServices } from "./use-recover";

/** Props for {@link RecoverForm}. */
export interface RecoverFormProps {
  /** Request id from `?request=`, when a link sent the visitor here. */
  requestId?: string;
  /** ORCID iD from `?orcid=`, to prefill the form. */
  initialOrcid?: string;
  /** Service override, for tests. */
  services?: RecoveryServices;
}

/** The `/recover` page. */
export function RecoverForm({ requestId, initialOrcid, services }: RecoverFormProps) {
  const recover = useRecover({ requestId, initialOrcid, services });
  // The profile name of the account is read from the API slice the page was
  // given, so a test (or a host) sees the read it injects.
  const client = services?.client ?? apiClient;

  return (
    <section className="wa-card wa-recover" aria-labelledby="recover-heading">
      <p className="wa-wordmark">scholium</p>
      <h1 id="recover-heading" className="wa-title">
        {RECOVER_TITLE}
      </h1>

      {recover.snapshot ? (
        <ProgressBody
          recover={recover}
          snapshot={recover.snapshot}
          client={client}
        />
      ) : (
        <IdentifyBody recover={recover} initialOrcid={initialOrcid} />
      )}
    </section>
  );
}

/** One render pass of the hook, for the sub-components. */
type RecoverState = ReturnType<typeof useRecover>;

/** Step 1: identify the account by ORCID iD. */
function IdentifyBody({
  recover,
  initialOrcid,
}: {
  recover: RecoverState;
  initialOrcid?: string;
}) {
  const [orcid, setOrcid] = useState(initialOrcid ?? "");
  const invalid = orcid.trim() !== "" && normalizeOrcid(orcid) === null;

  return (
    <>
      <p className="wa-lede">{RECOVER_LEDE}</p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void recover.start(orcid);
        }}
      >
        <div className="wa-field">
          <label className="wa-field-label" htmlFor="recover-orcid">
            {RECOVER_ORCID_LABEL}
          </label>
          <input
            id="recover-orcid"
            className="wa-input wa-input--mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={RECOVER_ORCID_PLACEHOLDER}
            value={orcid}
            onChange={(event) => setOrcid(event.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby="recover-orcid-hint"
          />
          <p className="wa-note" id="recover-orcid-hint">
            {RECOVER_ORCID_HINT}
          </p>
        </div>

        <button
          type="submit"
          className="wa-button wa-recover-start"
          disabled={!recover.ready || recover.busy || orcid.trim() === ""}
          aria-busy={recover.busy}
        >
          {recover.busy ? RECOVER_STARTING : RECOVER_START_ACTION}
        </button>
      </form>

      <p className="wa-progress" role="status" aria-live="polite">
        {recover.progress}
      </p>

      {recover.error ? (
        <p className="wa-error" role="alert">
          <strong>Couldn&rsquo;t start the recovery.</strong> {recover.error}
        </p>
      ) : null}

      <div className="wa-recover-how">
        <h2 className="wa-recover-how-title">{RECOVER_HOW_IT_WORKS_TITLE}</h2>
        <p className="wa-note">{RECOVER_HOW_IT_WORKS}</p>
      </div>

      <p className="wa-meta">
        <Link className="wa-link" href="/signin">
          {RECOVER_BACK_TO_SIGNIN}
        </Link>
      </p>
    </>
  );
}

/** Step 2: approval progress, the safety window and the cancel link. */
function ProgressBody({
  recover,
  snapshot,
  client,
}: {
  recover: RecoverState;
  snapshot: RecoverySnapshot;
  /** API slice for the account's public profile read. */
  client: RecoveryClient;
}) {
  const progressLine = recoveryProgressLine(snapshot);
  const threshold = Math.max(1, snapshot.threshold);
  const done = Math.max(0, Math.min(snapshot.approvals, threshold));
  const percent = Math.round((done / threshold) * 100);
  const cancellable = isCancellable(snapshot);

  // The public profile name of the account being recovered. The status route
  // names its DID; when this browser's snapshot predates that reply (or was
  // opened before any status read) it is read once here. A profile that cannot
  // be read leaves the ORCID iD on the card.
  const accountDid = snapshot.accountDid?.trim() ?? "";
  const [accountName, setAccountName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<string | null> => {
      let did = accountDid;
      if (did === "" && snapshot.requestId.trim() !== "") {
        try {
          did =
            (await fetchRecoveryStatus(snapshot.requestId, client)).accountDid?.trim() ??
            "";
        } catch {
          return null;
        }
      }
      return did === "" ? null : loadRecoveryAccountName(did, client);
    };
    void load().then((name) => {
      if (!cancelled) {
        setAccountName(name);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountDid, client, snapshot.requestId]);

  return (
    <>
      <p className="wa-lede">{`Recovering ${recoveryAccountLabel(
        accountName,
        snapshot.orcid,
      )}.`}</p>

      <dl className="wa-recover-facts">
        <div className="wa-recover-fact">
          <dt>{RECOVER_REQUEST_ID_LABEL}</dt>
          <dd className="wa-mono">{snapshot.requestId}</dd>
        </div>
        {snapshot.orcid || accountName !== null ? (
          <div className="wa-recover-fact">
            <dt>{RECOVER_ACCOUNT_LABEL}</dt>
            <dd className={accountName === null ? "wa-mono" : undefined}>
              {accountName === null ? (
                snapshot.orcid
              ) : (
                <>
                  <span>{accountName}</span>
                  {snapshot.orcid ? (
                    <>
                      {" "}
                      <span className="wa-mono">{snapshot.orcid}</span>
                    </>
                  ) : null}
                </>
              )}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="wa-recover-panel">
        <div className="wa-recover-panel-head">
          <h2 className="wa-step-title" id="recover-approvals-heading">
            {RECOVER_APPROVALS_HEADING}
          </h2>
          <span className={`wa-status-chip wa-status-chip--${snapshot.status}`}>
            {recoveryStatusLabel(snapshot.status)}
          </span>
        </div>

        <p className="wa-count" id="recover-progress-text">
          {progressLine}
        </p>
        <div
          className="wa-progressbar"
          role="progressbar"
          aria-labelledby="recover-approvals-heading"
          aria-valuemin={0}
          aria-valuemax={threshold}
          aria-valuenow={done}
          aria-valuetext={progressLine}
        >
          <span className="wa-progressbar-fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="wa-note">{recoveryProgressNote(snapshot)}</p>

        <div className="wa-recover-actions">
          <button
            type="button"
            className="wa-button wa-button--small wa-button--quiet"
            onClick={() => void recover.refresh()}
            disabled={recover.refreshing || recover.busy}
            aria-busy={recover.refreshing}
          >
            {recover.refreshing ? RECOVER_REFRESHING : RECOVER_REFRESH_ACTION}
          </button>
        </div>
      </div>

      <div className="wa-recover-panel">
        <h2 className="wa-step-title" id="recover-window-heading">
          {RECOVER_SAFETY_WINDOW_HEADING}
        </h2>
        <p
          className="wa-note"
          id="recover-window-note"
          title={formatRecoveryDeadline(snapshot.contestUntil) ?? undefined}
        >
          {safetyWindowNote(snapshot)}
        </p>

        {cancellable ? (
          <>
            <p className="wa-recover-cancel">
              <button
                type="button"
                className="wa-link wa-link-button"
                onClick={() => void recover.cancel()}
                disabled={recover.busy}
                aria-busy={recover.busy}
                aria-describedby="recover-cancel-note"
              >
                {recover.busy ? RECOVER_CANCELLING : RECOVER_CANCEL_ACTION}
              </button>
            </p>
            <p className="wa-note" id="recover-cancel-note">
              {RECOVER_CANCEL_NOTE}
            </p>
          </>
        ) : null}

        {!recover.statusLive && cancellable ? (
          <p className="wa-meta">{RECOVER_STATUS_UNAVAILABLE_NOTE}</p>
        ) : null}
      </div>

      <p className="wa-progress" role="status" aria-live="polite">
        {recover.progress}
      </p>

      {recover.notice ? (
        <p className="wa-notice" role="status">
          {recover.notice}
        </p>
      ) : null}

      {recover.error ? (
        <p className="wa-error" role="alert">
          <strong>Couldn&rsquo;t finish that.</strong> {recover.error}
        </p>
      ) : null}

      {snapshot.status === "finalized" ? (
        <p className="wa-meta">
          <a className="wa-button" href="/signin">
            Sign in with your new passkey
          </a>
        </p>
      ) : null}

      <p className="wa-meta">
        <button type="button" className="wa-link wa-link-button" onClick={recover.reset}>
          {RECOVER_RESET_ACTION}
        </button>
      </p>
    </>
  );
}

export default RecoverForm;
