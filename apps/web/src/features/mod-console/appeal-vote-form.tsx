"use client";

/**
 * The panel vote form: one drawn member's outcome and reasons for an appeal.
 *
 * Submitting posts to `POST /v1/appeals/{cid}/votes` with the signed-in
 * account's bearer token. Once two of the three seated members back the same
 * outcome the node publishes the panel's decision, and the answer says so.
 *
 * **The API decides who may vote.** No endpoint names the three members drawn
 * for an appeal, so the form is offered on every open appeal and the API's
 * answer settles it: a `403` replaces the form with a plain note that this
 * account holds no seat (there is nothing to vote on), instead of treating a
 * reader who was never drawn as having made a mistake.
 *
 * A vote can be changed until the panel decides (the API keeps a member's
 * latest vote), so a recorded vote offers "Change my vote" until then. Rules
 * live in `panel-vote.ts`, so validation and wording are testable without the
 * DOM.
 */

import { useId, useState, type FormEvent } from "react";

import { Icon, RecordLink } from "../ui-kit";
import { outcomeLabel } from "./appeals";
import {
  DECIDING_VOTES,
  PANEL_RECORD_NOTICE,
  PANEL_SIZE,
  VOTE_CHOICES,
  castPanelVote,
  describeVoteError,
  isVoteOutcome,
  validateVoteDraft,
  type VoteAccepted,
  type VoteCaster,
  type VoteDraft,
  type VoteFailure,
  type VoteOutcome,
  type VoteValidation,
} from "./panel-vote";
import { SIGNIN_HREF } from "./queue";
import { formatDate } from "./wire";
import "./mod-console.css";

/** Props for {@link AppealVoteForm}. */
export interface AppealVoteFormProps {
  /** The appeal being voted on (the `{cid}` of the vote endpoint). */
  appealCid: string;
  /** Injectable vote sender; defaults to `POST /v1/appeals/{cid}/votes`. */
  castVote?: VoteCaster;
  /**
   * Called when the API reports that this vote completed the panel's decision,
   * so the card around the form can mark the appeal decided.
   */
  onDecided?: (accepted: VoteAccepted) => void;
}

type Phase = "idle" | "submitting" | "recorded" | "not-seated";

/** The vote form and, once a vote is cast, what the API said about it. */
export function AppealVoteForm({
  appealCid,
  castVote = castPanelVote,
  onDecided,
}: AppealVoteFormProps) {
  const [outcome, setOutcome] = useState<VoteOutcome | "">("");
  const [reasons, setReasons] = useState("");
  const [errors, setErrors] = useState<VoteValidation>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<VoteFailure | null>(null);
  const [accepted, setAccepted] = useState<VoteAccepted | null>(null);

  const baseId = useId();
  const outcomeId = `${baseId}-outcome`;
  const reasonsId = `${baseId}-reasons`;
  const noticeId = `${baseId}-notice`;
  const failureId = `${baseId}-failure`;

  const draft: VoteDraft = { outcome, reasons };
  const busy = phase === "submitting";
  const chosen = VOTE_CHOICES.find((choice) => choice.value === outcome);

  const clearError = (field: keyof VoteValidation) => {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const nextErrors = validateVoteDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFailure(null);
      return;
    }

    setFailure(null);
    setPhase("submitting");
    let result: VoteAccepted;
    try {
      result = await castVote(appealCid, draft);
    } catch (error) {
      const failed = describeVoteError(error);
      setFailure(failed);
      setPhase(failed.kind === "not-seated" ? "not-seated" : "idle");
      return;
    }

    // The vote is recorded; a listener failing afterwards must not make the
    // member think it was not.
    setAccepted(result);
    setPhase("recorded");
    if (result.decisionCid !== null) {
      onDecided?.(result);
    }
  };

  if (phase === "not-seated" && failure !== null) {
    return (
      <div className="mc-vote mc-vote--note" role="status">
        <Icon name="question" className="mc-form-error-icon" />
        <p className="mc-form-error-text">{failure.message}</p>
      </div>
    );
  }

  if (phase === "recorded" && accepted !== null) {
    return (
      <VoteRecorded
        accepted={accepted}
        onChange={() => {
          setPhase("idle");
          setAccepted(null);
        }}
      />
    );
  }

  return (
    <form
      className="mc-vote"
      onSubmit={handleSubmit}
      aria-labelledby={`${baseId}-heading`}
      aria-describedby={failure === null ? undefined : failureId}
      noValidate
    >
      <h4 id={`${baseId}-heading`} className="mc-vote-title">
        Your panel vote
      </h4>
      <p className="mc-vote-lede">
        {PANEL_SIZE} members are drawn for each appeal. When {DECIDING_VOTES}{" "}
        back the same outcome, the panel&rsquo;s decision is published. Only a
        drawn member&rsquo;s vote is counted; the server checks your seat when
        you vote.
      </p>

      <div className="mc-field">
        <label className="mc-label" htmlFor={outcomeId}>
          Outcome <span className="mc-required">(required)</span>
        </label>
        <select
          id={outcomeId}
          className="mc-select"
          value={outcome}
          required
          aria-required="true"
          aria-invalid={errors.outcome !== undefined}
          aria-describedby={
            errors.outcome === undefined ? undefined : `${outcomeId}-error`
          }
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            setOutcome(isVoteOutcome(value) ? value : "");
            clearError("outcome");
          }}
        >
          <option value="">Choose an outcome…</option>
          {VOTE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {errors.outcome !== undefined ? (
          <FieldError id={`${outcomeId}-error`} message={errors.outcome} />
        ) : chosen !== undefined ? (
          <p className="mc-hint">{chosen.hint}</p>
        ) : null}
      </div>

      <div className="mc-field">
        <label className="mc-label" htmlFor={reasonsId}>
          Your reasons <span className="mc-required">(required)</span>
        </label>
        <textarea
          id={reasonsId}
          className="mc-textarea"
          value={reasons}
          required
          aria-required="true"
          aria-invalid={errors.reasons !== undefined}
          aria-describedby={[
            noticeId,
            errors.reasons === undefined ? null : `${reasonsId}-error`,
          ]
            .filter((value): value is string => value !== null)
            .join(" ")}
          rows={4}
          placeholder="Say what in the grounds, the decision or the policy led you to this outcome."
          disabled={busy}
          onChange={(event) => {
            setReasons(event.target.value);
            clearError("reasons");
          }}
        />
        {errors.reasons !== undefined ? (
          <FieldError id={`${reasonsId}-error`} message={errors.reasons} />
        ) : null}
      </div>

      <p id={noticeId} className="mc-record-notice">
        {PANEL_RECORD_NOTICE}
      </p>

      {failure !== null ? (
        <div id={failureId} className="mc-form-error" role="alert">
          <Icon name="alert" className="mc-form-error-icon" />
          <p className="mc-form-error-text">
            {failure.message}{" "}
            {failure.kind === "signed-out" ? (
              <a className="mc-link" href={SIGNIN_HREF}>
                Sign in
              </a>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="mc-actions">
        <button
          type="submit"
          className="mc-button"
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Recording your vote…" : "Cast my vote"}
        </button>
      </div>
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

/** The member's vote as the sentence "You voted to …" wants it. */
const VOTE_VERBS: Readonly<Record<string, string>> = {
  upheld: "uphold",
  overturned: "overturn",
  modified: "modify",
  remanded: "remand",
  granted: "grant",
  grant: "grant",
  denied: "deny",
  deny: "deny",
  allowed: "allow",
  dismissed: "dismiss",
};

/** What the API said once the vote was recorded. */
function VoteRecorded({
  accepted,
  onChange,
}: {
  accepted: VoteAccepted;
  onChange: () => void;
}) {
  const decided = accepted.decisionCid !== null;
  const headingId = useId();
  // The member's own words for what they chose, as a verb: "You voted to
  // uphold/overturn the decision", matching the notices' wording.
  const verb = VOTE_VERBS[accepted.outcome];
  const voted =
    verb !== undefined
      ? `to ${verb} the decision`
      : (VOTE_CHOICES.find((choice) => choice.value === accepted.outcome)?.label ??
        outcomeLabel(accepted.outcome));
  const votedOn = formatDate(accepted.votedAt ?? null);

  return (
    <section className="mc-vote mc-vote--recorded" aria-labelledby={headingId}>
      <h4 id={headingId} className="mc-vote-title">
        <Icon name="check" className="mc-vote-icon" />
        {decided ? "The panel has decided" : "Your vote is recorded"}
      </h4>

      {decided ? (
        <p className="mc-vote-lede" role="status">
          {DECIDING_VOTES} members agree:{" "}
          <strong>
            {outcomeLabel(accepted.decidedOutcome ?? accepted.outcome)}
          </strong>
          . The decision is published.
        </p>
      ) : (
        <p className="mc-vote-lede" role="status">
          You voted {voted}{votedOn === null ? "" : ` on ${votedOn}`}.{" "}
          {accepted.votes === null
            ? ""
            : `${accepted.votes} of ${PANEL_SIZE} members have voted. `}
          {DECIDING_VOTES} matching votes decide the appeal, and you can change
          your vote until then.
        </p>
      )}

      <p className="mc-record-notice">{PANEL_RECORD_NOTICE}</p>

      <div className="mc-actions">
        {decided && accepted.decisionCid !== null ? (
          <RecordLink
            cid={accepted.decisionCid}
            label="View the panel's decision"
            className="mc-button"
          />
        ) : (
          <button
            type="button"
            className="mc-button mc-button--quiet"
            onClick={onChange}
          >
            Change my vote
          </button>
        )}
      </div>
    </section>
  );
}

export default AppealVoteForm;
