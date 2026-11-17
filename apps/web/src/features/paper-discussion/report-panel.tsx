"use client";

/**
 * The Report panel of a post (docs/design.md §11: "Report / flag is available
 * on every post and review; the reporter sees the outcome").
 *
 * A fieldset of reasons, none chosen for the reader, and **Send report**.
 * `onReport` files the flag (`POST /v1/flags`) and either resolves, after
 * which the card says the post was reported, or rejects, in which case the
 * panel stays open and says why in words. A report with no reason is refused
 * here, in words, before anything is sent.
 *
 * Accessibility: a `fieldset` with a `legend`; each reason is a radio with a
 * 44 px target and a one-line hint tied to it with `aria-describedby`; the
 * problem is words in a `role="alert"`, never colour alone.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  REPORT_REASONS,
  describeActionError,
  type ActionFailure,
  type ReportReason,
  type ReportReasonOption,
} from "./discussion";
import { FailureText } from "./notes";

export interface ReportPanelProps {
  /** What is being reported, for the legend: "Why are you reporting the review by …?" */
  subject?: string;
  /** Who wrote the post, for the legend: "Why are you reporting the post by …?" */
  authorLabel: string;
  /** Complete legend override, for a paper ("Why are you reporting this paper?"). */
  legend?: string;
  /** The reasons to offer; the post reasons by default. */
  reasons?: readonly ReportReasonOption[];
  /** Files the report. Resolve when it is filed; reject to show why not. */
  onReport: (reason: ReportReason) => Promise<void>;
  /** Give the report up without sending it. */
  onCancel: () => void;
  /** Where "Sign in" goes when the session has ended. */
  signInHref: string;
}

export function ReportPanel({
  subject = "post",
  authorLabel,
  legend,
  reasons = REPORT_REASONS,
  onReport,
  onCancel,
  signInHref,
}: ReportPanelProps) {
  const uid = useId();
  const [choice, setChoice] = useState<ReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (choice === null) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setFailure(null);
    setBusy(true);
    try {
      await onReport(choice);
    } catch (error) {
      if (mounted.current) setFailure(describeActionError(error, "report"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const problemId = `${uid}-problem`;

  return (
    <form
      className="pd-report"
      data-busy={busy}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <fieldset className="pd-report__fieldset" disabled={busy} aria-describedby={missing ? problemId : undefined}>
        <legend className="pd-report__legend">
          {legend ?? `Why are you reporting the ${subject} by ${authorLabel}?`}
        </legend>
        {reasons.map((reason) => (
          <div className="pd-reason" key={reason.id}>
            <input
              id={`${uid}-${reason.id}`}
              className="pd-reason__input"
              type="radio"
              name={`${uid}-reason`}
              value={reason.id}
              checked={choice === reason.id}
              aria-describedby={`${uid}-${reason.id}-hint`}
              onChange={() => {
                setChoice(reason.id as ReportReason);
                setMissing(false);
              }}
            />
            <label className="pd-reason__label" htmlFor={`${uid}-${reason.id}`}>
              <span className="pd-reason__name">{reason.label}</span>
              <span className="pd-reason__hint" id={`${uid}-${reason.id}-hint`}>
                {reason.hint}
              </span>
            </label>
          </div>
        ))}
      </fieldset>

      {missing ? (
        <p className="pd-error-text" id={problemId} role="alert">
          Choose a reason so a moderator knows what to look at.
        </p>
      ) : null}

      {failure !== null ? <FailureText failure={failure} signInHref={signInHref} /> : null}

      <div className="pd-report__actions">
        <button type="submit" className="pd-button pd-button--primary" disabled={busy}>
          {busy ? "Sending…" : "Send report"}
        </button>
        <button type="button" className="pd-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="pd-compose__hint">
        A moderator reviews every report. You will be told what was decided.
      </p>
    </form>
  );
}
