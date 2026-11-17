"use client";

/**
 * The decision form for a flagged record that is not a paper version.
 *
 * A flag can name a discussion post, an inline annotation or a review. Those
 * records have no version state to move, so the paper form's `list`/`hold`/
 * `reclassify`/`reject`/`delist` choices say nothing true about them — the API
 * refuses each with a 422 that names the actions the record does accept. This
 * form offers exactly those two:
 *
 * - **dismiss the flag** (`dismiss`) — the record stays as it is, the flag is
 *   settled and its reporter hears the outcome;
 * - **hide the record** (`hide`) — the signed record stays in the log but its
 *   body is withheld from public reads with a "hidden by moderation"
 *   placeholder and the reason, reversible on appeal.
 *
 * Every decision is signed on the moderator's device and posted to the same
 * `POST /v1/moderation/decisions` the paper form uses, so the record it
 * produces is the same public signed record.
 *
 * The required fields are the same as the paper form's: an action, a policy
 * clause from `GET /v1/moderation/policies`, and a reason. Signing needs the
 * device key, which exists only in the browser, so the form is client-only;
 * the rules live in `decision.ts`.
 */

import { useId, useState, type FormEvent } from "react";

import { policyHref, type PolicyClause } from "../policies-page";
import { Icon, RecordLink } from "../ui-kit";
import {
  PUBLIC_RECORD_NOTICE,
  RECORD_DECISION_ACTIONS,
  buildDecisionBody,
  describeDecisionError,
  signModerationDecision,
  submitModerationDecision,
  validateDecisionDraft,
  type DecisionAccepted,
  type DecisionDraft,
  type DecisionSigner,
  type DecisionSubmitter,
} from "./decision";
import { MOD_PATH } from "./queue";
import {
  PAPER_GENESIS_TYPE,
  recordKindLabel,
  recordNoun,
  type ModeratedRecord,
} from "./record";
import "./mod-console.css";

/** One decision this form can sign for a non-paper record. */
export type RecordDecisionAction = (typeof RECORD_DECISION_ACTIONS)[number];

/** How an action reads for this record, in words that name the record. */
export function recordActionLabel(
  action: RecordDecisionAction,
  record: ModeratedRecord,
): string {
  const noun = recordNoun(record);
  switch (action) {
    case "dismiss":
      return `Dismiss the flag (leave the ${noun} as it is)`;
    case "hide":
      return `Hide the ${noun} from public reads`;
  }
}

/** What the moderator is about to settle, in one sentence; `null` before a choice. */
export function recordOutcome(
  action: RecordDecisionAction | "",
  record: ModeratedRecord,
): string | null {
  const noun = recordNoun(record);
  switch (action) {
    case "dismiss":
      return `The ${noun} stays as it is, and the flag is settled.`;
    case "hide":
      return `The ${noun} is hidden from public reads with the reason below, and the flag is settled.`;
    default:
      return null;
  }
}

/** Props for {@link RecordDecisionForm}. */
export interface RecordDecisionFormProps {
  /** The flagged record being decided. */
  record: ModeratedRecord;
  /** Every clause a decision may cite, from `GET /v1/moderation/policies`. */
  clauses: readonly PolicyClause[];
  /** Injectable signer; defaults to the passkey-gated device key. */
  signDecision?: DecisionSigner;
  /** Injectable submitter; defaults to `POST /v1/moderation/decisions`. */
  submitDecision?: DecisionSubmitter;
  /** Called after the API accepts the decision, e.g. to reload the flags. */
  onPublished?: (accepted: DecisionAccepted) => void;
}

type Phase = "idle" | "signing" | "submitting" | "published";

/** The record decision form and, once published, the record it produced. */
export function RecordDecisionForm({
  record,
  clauses,
  signDecision = signModerationDecision,
  submitDecision = submitModerationDecision,
  onPublished,
}: RecordDecisionFormProps) {
  const [action, setAction] = useState<RecordDecisionAction | "">("");
  const [clause, setClause] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<ReturnType<typeof validateDecisionDraft>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<DecisionAccepted | null>(null);

  const baseId = useId();
  const actionId = `${baseId}-action`;
  const clauseId = `${baseId}-clause`;
  const reasonId = `${baseId}-reason`;
  const outcomeId = `${baseId}-outcome`;
  const noticeId = `${baseId}-notice`;
  const failureId = `${baseId}-failure`;

  const busy = phase === "signing" || phase === "submitting";
  const noClauses = clauses.length === 0;
  // A flag may name the paper itself: dismissing it settles the report, while
  // there is no version whose content a hide could withdraw.
  const actions =
    record.type === PAPER_GENESIS_TYPE
      ? RECORD_DECISION_ACTIONS.filter((value) => value === "dismiss")
      : RECORD_DECISION_ACTIONS;
  const selectedClause = clauses.find((item) => item.id === clause) ?? null;
  const outcome = recordOutcome(action, record);

  const clearError = (field: keyof ReturnType<typeof validateDecisionDraft>) => {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || phase === "published") return;

    const draft: DecisionDraft = {
      action,
      clause,
      reason,
      category: "",
    };
    const nextErrors = validateDecisionDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFailure(null);
      return;
    }

    setFailure(null);
    let result: DecisionAccepted;
    try {
      const body = buildDecisionBody(record.cid, draft);
      setPhase("signing");
      const signed = await signDecision(body);
      setPhase("submitting");
      result = await submitDecision(signed);
    } catch (error) {
      setFailure(describeDecisionError(error));
      setPhase("idle");
      return;
    }

    setAccepted(result);
    setPhase("published");
    onPublished?.(result);
  };

  if (phase === "published" && accepted !== null) {
    return (
      <RecordDecisionPublished
        accepted={accepted}
        action={action}
        record={record}
        reason={reason.trim()}
      />
    );
  }

  return (
    <form
      className="mc-decision-card"
      onSubmit={handleSubmit}
      aria-labelledby={`${baseId}-heading`}
      aria-describedby={failure === null ? undefined : failureId}
      noValidate
    >
      <p className="mc-section-kicker">Decision</p>
      <h2 id={`${baseId}-heading`} className="mc-decision-title">
        Record a decision
      </h2>
      <p className="mc-decision-lede">
        This record is not a paper version, so it has no version state to move.
        Decide what happens to it and to the flag filed against it. Nothing is
        published until you sign.
      </p>

      <div className="mc-field">
        <label className="mc-label" htmlFor={actionId}>
          Action <span className="mc-required">(required)</span>
        </label>
        <select
          id={actionId}
          className="mc-select"
          value={action}
          required
          aria-required="true"
          aria-invalid={errors.action !== undefined}
          aria-describedby={errors.action === undefined ? undefined : `${actionId}-error`}
          disabled={busy}
          onChange={(event) => {
            setAction(event.target.value as RecordDecisionAction | "");
            clearError("action");
          }}
        >
          <option value="">Choose an action…</option>
          {actions.map((value) => (
            <option key={value} value={value}>
              {recordActionLabel(value, record)}
            </option>
          ))}
        </select>
        {errors.action !== undefined ? (
          <FieldError id={`${actionId}-error`} message={errors.action} />
        ) : null}
      </div>

      <div className="mc-field">
        <label className="mc-label" htmlFor={clauseId}>
          Policy clause <span className="mc-required">(required)</span>
        </label>
        <select
          id={clauseId}
          className="mc-select"
          value={clause}
          required
          aria-required="true"
          aria-invalid={errors.clause !== undefined}
          aria-describedby={errors.clause === undefined ? undefined : `${clauseId}-error`}
          disabled={busy || noClauses}
          onChange={(event) => {
            setClause(event.target.value);
            clearError("clause");
          }}
        >
          <option value="">Choose a policy clause…</option>
          {clauses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} — {item.title}
            </option>
          ))}
        </select>
        {errors.clause !== undefined ? (
          <FieldError id={`${clauseId}-error`} message={errors.clause} />
        ) : null}
        {noClauses ? (
          <p className="mc-hint">
            No policy clauses are published, so a decision cannot be recorded.
          </p>
        ) : selectedClause !== null ? (
          <p className="mc-hint">
            {selectedClause.text}{" "}
            <a className="mc-link" href={policyHref(selectedClause.id)}>
              Read policy {selectedClause.id}
            </a>
          </p>
        ) : null}
      </div>

      <div className="mc-field">
        <label className="mc-label" htmlFor={reasonId}>
          Reason for the decision <span className="mc-required">(required)</span>
        </label>
        <textarea
          id={reasonId}
          className="mc-textarea"
          value={reason}
          required
          aria-required="true"
          aria-invalid={errors.reason !== undefined}
          aria-describedby={[
            `${reasonId}-hint`,
            errors.reason === undefined ? null : `${reasonId}-error`,
          ]
            .filter((value): value is string => value !== null)
            .join(" ")}
          rows={5}
          placeholder="Explain the decision in plain language."
          disabled={busy}
          onChange={(event) => {
            setReason(event.target.value);
            clearError("reason");
          }}
        />
        <p id={`${reasonId}-hint`} className="mc-hint">
          This text is published with the decision, and the person who reported
          the record sees the flag&rsquo;s outcome.
        </p>
        {errors.reason !== undefined ? (
          <FieldError id={`${reasonId}-error`} message={errors.reason} />
        ) : null}
      </div>

      <section className="mc-author-preview" aria-labelledby={outcomeId} aria-describedby={noticeId}>
        <h3 id={outcomeId} className="mc-preview-title">
          Preview of the outcome
        </h3>
        {outcome === null ? (
          <p className="mc-preview-placeholder">
            Choose an action to preview the outcome.
          </p>
        ) : (
          <p className="mc-preview-headline">{outcome}</p>
        )}
        {outcome !== null && reason.trim() !== "" ? (
          <p className="mc-preview-reason">{reason.trim()}</p>
        ) : null}
        {outcome !== null && selectedClause !== null ? (
          <p className="mc-preview-policy">
            Policy{" "}
            <a className="mc-link" href={policyHref(selectedClause.id)}>
              {selectedClause.id}
            </a>{" "}
            — {selectedClause.title}
          </p>
        ) : null}
      </section>

      <p id={noticeId} className="mc-record-notice">
        {PUBLIC_RECORD_NOTICE}
      </p>

      {failure !== null ? (
        <div id={failureId} className="mc-form-error" role="alert">
          <Icon name="alert" className="mc-form-error-icon" />
          <p className="mc-form-error-text">{failure}</p>
        </div>
      ) : null}

      <div className="mc-actions">
        <button type="submit" className="mc-button" disabled={busy || noClauses} aria-busy={busy}>
          {phase === "signing"
            ? "Waiting for your passkey…"
            : phase === "submitting"
              ? "Publishing the decision…"
              : "Sign decision"}
        </button>
        <a className="mc-button mc-button--quiet" href={MOD_PATH}>
          Back to the queue
        </a>
      </div>
      <p className="mc-sign-hint">
        You sign with your passkey. Scholium never sees your key.
      </p>
    </form>
  );
}

/** A field error: icon plus words, so the state is never colour alone. */
function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="mc-field-error" role="alert">
      <Icon name="alert" className="mc-field-error-icon" />
      <span>{message}</span>
    </p>
  );
}

/** The published decision: what was signed, with a link to read it back. */
function RecordDecisionPublished({
  accepted,
  action,
  record,
  reason,
}: {
  accepted: DecisionAccepted;
  action: RecordDecisionAction | "";
  record: ModeratedRecord;
  reason: string;
}) {
  const headingId = useId();
  return (
    <section
      className="mc-decision-card mc-decision-card--published"
      aria-labelledby={headingId}
    >
      <p className="mc-section-kicker">Decision published</p>
      <h2 id={headingId} className="mc-decision-title">
        Decision published
      </h2>
      <dl className="mc-published-facts">
        <div>
          <dt>Action</dt>
          <dd>
            {action === ""
              ? accepted.action
              : recordActionLabel(action, record)}
          </dd>
        </div>
        <div>
          <dt>Policy clause</dt>
          <dd>
            <a className="mc-link" href={policyHref(accepted.clause)}>
              {accepted.clause}
            </a>
          </dd>
        </div>
        <div>
          <dt>Flagged record</dt>
          <dd>
            {recordKindLabel(record)} <span className="mono-id">{record.cid}</span>
          </dd>
        </div>
      </dl>

      {reason !== "" ? (
        <section className="mc-published-reason" aria-labelledby={`${headingId}-reason`}>
          <h3 id={`${headingId}-reason`} className="mc-abstract-title">
            Reason for the decision
          </h3>
          <p className="mc-preview-reason">{reason}</p>
        </section>
      ) : null}

      <p className="mc-record-notice">{PUBLIC_RECORD_NOTICE}</p>

      <div className="mc-actions">
        <RecordLink cid={accepted.id} label="View the signed record" className="mc-button" />
        <a className="mc-button mc-button--quiet" href={MOD_PATH}>
          Back to the queue
        </a>
      </div>
    </section>
  );
}

export default RecordDecisionForm;
