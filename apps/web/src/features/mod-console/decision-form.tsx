"use client";

/**
 * The decision form beside the paper (docs/design.md §5.7).
 *
 * The moderator chooses an action, cites a required policy clause, writes the
 * reason the author will see, and checks the live author preview. Submitting
 * signs a `moderation.decision` with the moderator's passkey and posts it to
 * `POST /v1/moderation/decisions`.
 *
 * Every decision states {@link PUBLIC_RECORD_NOTICE}, word for word, beside
 * the form and again once it is published.
 *
 * The form is deliberately client-only: signing needs the device key, which
 * exists only in the browser. Rules live in `decision.ts` so the same
 * validation, body-building and preview are testable without a passkey.
 */

import { useId, useState, type FormEvent } from "react";

import { policyHref, type PolicyClause } from "../policies-page";
import { Icon, RecordLink } from "../ui-kit";
import {
  DECISION_ACTIONS,
  DECISION_ACTION_LABELS,
  PUBLIC_RECORD_NOTICE,
  authorPreview,
  buildDecisionBody,
  describeDecisionError,
  signModerationDecision,
  submitModerationDecision,
  validateDecisionDraft,
  type DecisionAccepted,
  type DecisionAction,
  type DecisionDraft,
  type DecisionSigner,
  type DecisionSubmitter,
  type DecisionValidation,
} from "./decision";
import { MOD_PATH } from "./queue";
import "./mod-console.css";

/** Props for {@link DecisionForm}. */
export interface DecisionFormProps {
  /** The version being decided. */
  versionCid: string;
  /** Every clause a decision may cite, from `GET /v1/moderation/policies`. */
  clauses: readonly PolicyClause[];
  /** Injectable signer; defaults to the passkey-gated device key. */
  signDecision?: DecisionSigner;
  /** Injectable submitter; defaults to `POST /v1/moderation/decisions`. */
  submitDecision?: DecisionSubmitter;
  /**
   * Called after the API accepts the decision. The detail view uses it to say
   * the paper has moved on; the form itself already shows the result.
   */
  onPublished?: (accepted: DecisionAccepted) => void;
}

type Phase = "idle" | "signing" | "submitting" | "published";

/** A human word for the version state the API reports after a decision. */
export function stateLabel(state: string): string {
  switch (state) {
    case "listed":
      return "Listed";
    case "held":
      return "Held";
    case "rejected":
      return "Rejected";
    case "moderation":
      return "Still waiting for a decision";
    default:
      return state === "" ? "Updated" : state;
  }
}

/** The decision form and, once published, the record it produced. */
export function DecisionForm({
  versionCid,
  clauses,
  signDecision = signModerationDecision,
  submitDecision = submitModerationDecision,
  onPublished,
}: DecisionFormProps) {
  const [action, setAction] = useState<DecisionAction | "">("");
  const [clause, setClause] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("");
  const [errors, setErrors] = useState<DecisionValidation>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<DecisionAccepted | null>(null);

  const baseId = useId();
  const actionId = `${baseId}-action`;
  const clauseId = `${baseId}-clause`;
  const reasonId = `${baseId}-reason`;
  const categoryId = `${baseId}-category`;
  const previewId = `${baseId}-preview`;
  const noticeId = `${baseId}-notice`;
  const failureId = `${baseId}-failure`;

  const draft: DecisionDraft = { action, clause, reason, category };
  const preview = authorPreview(draft, clauses);
  const selectedClause = clauses.find((item) => item.id === clause) ?? null;
  const noClauses = clauses.length === 0;
  const busy = phase === "signing" || phase === "submitting";

  const clearError = (field: keyof DecisionValidation) => {
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

    const nextErrors = validateDecisionDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFailure(null);
      return;
    }

    setFailure(null);
    let result: DecisionAccepted;
    try {
      const body = buildDecisionBody(versionCid, draft);
      setPhase("signing");
      const record = await signDecision(body);
      setPhase("submitting");
      result = await submitDecision(record);
    } catch (error) {
      setFailure(describeDecisionError(error));
      setPhase("idle");
      return;
    }

    // The decision is published; a listener failing afterwards must not make
    // the moderator think it was not.
    setAccepted(result);
    setPhase("published");
    onPublished?.(result);
  };

  if (phase === "published" && accepted !== null) {
    return (
      <DecisionPublished
        accepted={accepted}
        action={isPublishedAction(accepted.action) ? accepted.action : action}
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
        Record your decision
      </h2>
      <p className="mc-decision-lede">
        Every decision cites a policy clause and gives the author a reason.
        Nothing is published until you sign.
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
          aria-describedby={
            errors.action === undefined ? undefined : `${actionId}-error`
          }
          disabled={busy}
          onChange={(event) => {
            setAction(event.target.value as DecisionAction | "");
            clearError("action");
            if (event.target.value !== "reclassify") {
              clearError("category");
            }
          }}
        >
          <option value="">Choose an action…</option>
          {DECISION_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {DECISION_ACTION_LABELS[value]}
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
          aria-describedby={
            errors.clause === undefined ? undefined : `${clauseId}-error`
          }
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

      {action === "reclassify" ? (
        <div className="mc-field">
          <label className="mc-label" htmlFor={categoryId}>
            New category <span className="mc-required">(required)</span>
          </label>
          <input
            id={categoryId}
            className="mc-input"
            type="text"
            value={category}
            required
            aria-required="true"
            aria-invalid={errors.category !== undefined}
            aria-describedby={
              errors.category === undefined ? undefined : `${categoryId}-error`
            }
            placeholder="e.g. cs.LG"
            disabled={busy}
            onChange={(event) => {
              setCategory(event.target.value);
              clearError("category");
            }}
          />
          {errors.category !== undefined ? (
            <FieldError id={`${categoryId}-error`} message={errors.category} />
          ) : null}
        </div>
      ) : null}

      <div className="mc-field">
        <label className="mc-label" htmlFor={reasonId}>
          Reason shown to the author{" "}
          <span className="mc-required">(required)</span>
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
          This text is published with the decision and shown to the author.
        </p>
        {errors.reason !== undefined ? (
          <FieldError id={`${reasonId}-error`} message={errors.reason} />
        ) : null}
      </div>

      <section
        className="mc-author-preview"
        aria-labelledby={previewId}
        aria-describedby={noticeId}
      >
        <h3 id={previewId} className="mc-preview-title">
          Preview of what the author will see
        </h3>
        <AuthorPreviewMessage preview={preview} />
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
        <button
          type="submit"
          className="mc-button"
          disabled={busy || noClauses}
          aria-busy={busy}
        >
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

/** The author's message while it is still a preview. */
function AuthorPreviewMessage({
  preview,
}: {
  preview: ReturnType<typeof authorPreview>;
}) {
  if (preview === null) {
    return (
      <p className="mc-preview-placeholder">
        Choose an action to preview the author&rsquo;s message.
      </p>
    );
  }

  return (
    <>
      <p className="mc-preview-headline">{preview.headline}</p>
      {preview.reason === "" ? (
        <p className="mc-preview-placeholder">
          The reason you write will appear here.
        </p>
      ) : (
        <p className="mc-preview-reason">{preview.reason}</p>
      )}
      {preview.clause === null ? (
        <p className="mc-preview-placeholder">
          The policy clause you cite will appear here.
        </p>
      ) : (
        <p className="mc-preview-policy">
          Policy{" "}
          <a className="mc-link" href={policyHref(preview.clause.id)}>
            {preview.clause.id}
          </a>{" "}
          — {preview.clause.title}
        </p>
      )}
      {preview.appeal !== null ? (
        <p className="mc-preview-appeal">{preview.appeal}</p>
      ) : null}
    </>
  );
}

function isPublishedAction(value: string): value is DecisionAction {
  return (DECISION_ACTIONS as readonly string[]).includes(value);
}

/** The record the moderator just published, with a link to read it back. */
function DecisionPublished({
  accepted,
  action,
  reason,
}: {
  accepted: DecisionAccepted;
  action: DecisionAction | "";
  /** The reason as signed, shown so the moderator can read back the record. */
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
            {action === "" ? accepted.action : DECISION_ACTION_LABELS[action]}
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
          <dt>Version state</dt>
          <dd>{stateLabel(accepted.state)}</dd>
        </div>
      </dl>

      {reason !== "" ? (
        <section className="mc-published-reason" aria-labelledby={`${headingId}-reason`}>
          <h3 id={`${headingId}-reason`} className="mc-abstract-title">
            Reason shown to the author
          </h3>
          <p className="mc-preview-reason">{reason}</p>
        </section>
      ) : null}

      <p className="mc-record-notice">{PUBLIC_RECORD_NOTICE}</p>

      <div className="mc-actions">
        <RecordLink
          cid={accepted.id}
          label="View the signed record"
          className="mc-button"
        />
        <a className="mc-button mc-button--quiet" href={MOD_PATH}>
          Back to the queue
        </a>
      </div>
    </section>
  );
}

export default DecisionForm;
