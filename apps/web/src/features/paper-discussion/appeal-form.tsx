"use client";

/**
 * The form an author files an appeal of their hidden post with.
 *
 * ```text
 * Why should this decision be reconsidered?
 * ┌──────────────────────────────────────────┐
 * │                                          │
 * └──────────────────────────────────────────┘
 *                                 0 characters
 * [Sign and file appeal] [Cancel]
 * This is signed into the public record and read by the panel, so say what
 * the decision got wrong.
 * ```
 *
 * It is laid out like the reply form (a label, a full-width textarea, the
 * count, the buttons, the hint), and its words are the paper-hold appeal
 * dialog's (`../paper-page/appeal-dialog.tsx`): an appeal reads the same
 * wherever it is filed.
 *
 * The form files nothing itself. `onSubmit` receives the grounds and either
 * resolves (the appeal is in) or rejects (the form says why, in words, and
 * keeps what was typed). Accessibility: a real `<label>`; the hint and the
 * count are tied to the textarea with `aria-describedby`; a failure is words
 * in a `role="alert"`, never colour alone.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { describeActionError, type ActionFailure } from "./discussion";
import { FailureText } from "./notes";

/** The visible label above the grounds field. */
export const APPEAL_GROUNDS_QUESTION = "Why should this decision be reconsidered?";

export interface AppealFormProps {
  /** Files the appeal. Resolve when it is in; reject to show why not. */
  onSubmit: (grounds: string) => Promise<void>;
  /** Give up: closes the form. */
  onCancel: () => void;
  /** Where "Sign in" goes when the session has ended. */
  signInHref: string;
}

export function AppealForm({ onSubmit, onCancel, signInHref }: AppealFormProps) {
  const uid = useId();
  const groundsId = `${uid}-grounds`;
  const hintId = `${uid}-hint`;
  const countId = `${uid}-count`;

  const [grounds, setGrounds] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  // The form is unmounted once the appeal is filed; never write state after
  // that. Set on every mount so StrictMode's mount, unmount, mount ends true.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const length = grounds.trim().length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    setBusy(true);
    try {
      await onSubmit(grounds);
    } catch (error) {
      if (mounted.current) setFailure(describeActionError(error, "appeal"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="pd-panel">
      <form
        className="pd-compose"
        data-kind="appeal"
        data-busy={busy}
        onSubmit={(event) => void submit(event)}
      >
        <label className="pd-compose__label" htmlFor={groundsId}>
          {APPEAL_GROUNDS_QUESTION}
        </label>
        <textarea
          id={groundsId}
          className="pd-compose__text"
          name="grounds"
          rows={4}
          value={grounds}
          required
          autoFocus
          disabled={busy}
          aria-describedby={`${hintId} ${countId}`}
          onChange={(event) => setGrounds(event.target.value)}
        />
        <p className="pd-compose__count" id={countId}>
          {`${length.toLocaleString("en-GB")} ${length === 1 ? "character" : "characters"}`}
        </p>

        {failure !== null ? <FailureText failure={failure} signInHref={signInHref} /> : null}

        <div className="pd-compose__actions">
          <button type="submit" className="pd-button pd-button--primary" disabled={busy}>
            {busy ? "Waiting for your passkey…" : "Sign and file appeal"}
          </button>
          <button type="button" className="pd-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
        <p className="pd-compose__hint" id={hintId}>
          This is signed into the public record and read by the panel, so say what the decision
          got wrong.
        </p>
      </form>
    </div>
  );
}
