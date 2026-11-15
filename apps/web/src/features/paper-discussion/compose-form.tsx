"use client";

/**
 * The form that writes a post: a new thread, or a reply (docs/design.md §5.2).
 *
 * One textarea and one button. The button says **Sign and submit** and the
 * line under it says what that means (docs/design.md §8): the post is signed
 * on this device behind a passkey prompt, and Scholium never sees the key.
 *
 * The form does not post anything itself. `onSubmit` receives the text and
 * either resolves (the post is in; the form clears) or rejects (the form shows
 * why, in words, and keeps what was typed — a reader's words are theirs even
 * when the network is not). The failure is described by
 * {@link describeActionError}, so a cancelled passkey, a missing key, a
 * rate limit and a lost connection each say what happened and whether anything
 * was sent.
 *
 * Accessibility: a real `<label>` on the textarea; the count, the hint and any
 * problem are tied to it with `aria-describedby`; a problem is words in a
 * `role="alert"`, never colour alone; the button is at least 44 px tall.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  POST_TEXT_MAX,
  describeActionError,
  postTextProblem,
  type ActionFailure,
} from "./discussion";
import { FailureText } from "./notes";

export interface ComposeFormProps {
  /** The visible label above the textarea, e.g. "Your reply". */
  label: string;
  /** Posts the text. Resolve when the post is in; reject to show why not. */
  onSubmit: (text: string) => Promise<void>;
  /** Where "Sign in" goes when the session has ended. */
  signInHref: string;
  /** Present for a reply, which can be given up; the thread starter stays open. */
  onCancel?: () => void;
  /** Focus the textarea on mount (a reply panel opened by the reader). */
  autoFocus?: boolean;
  /** The button's words at rest. */
  submitLabel?: string;
  /** Stable hook for tests and hosts: `thread` or `reply`. */
  kind: "thread" | "reply";
}

export function ComposeForm({
  label,
  onSubmit,
  signInHref,
  onCancel,
  autoFocus = false,
  submitLabel = "Sign and submit",
  kind,
}: ComposeFormProps) {
  const uid = useId();
  const textId = `${uid}-text`;
  const hintId = `${uid}-hint`;
  const countId = `${uid}-count`;
  const problemId = `${uid}-problem`;

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // A problem with the text is shown once the reader tries to post, not while
  // they are still typing the first words.
  const [textProblem, setTextProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The form can be closed (and unmounted) by the host while a post is in
  // flight; never write state after that. Set on every mount so StrictMode's
  // mount, unmount, mount sequence ends true.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const length = text.trim().length;
  const over = length > POST_TEXT_MAX;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const problem = postTextProblem(text);
    if (problem !== null) {
      setTextProblem(problem);
      setFailure(null);
      textareaRef.current?.focus();
      return;
    }
    setTextProblem(null);
    setFailure(null);
    setBusy(true);
    try {
      await onSubmit(text);
      if (mounted.current) setText("");
    } catch (error) {
      if (mounted.current) setFailure(describeActionError(error, "post"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const problem = textProblem ?? (over ? postTextProblem(text) : null);
  const describedBy = [hintId, countId, problem !== null ? problemId : null]
    .filter((id): id is string => id !== null)
    .join(" ");

  return (
    <form
      className="pd-compose"
      data-kind={kind}
      data-busy={busy}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <label className="pd-compose__label" htmlFor={textId}>
        {label}
      </label>
      <textarea
        id={textId}
        ref={textareaRef}
        className="pd-compose__text"
        rows={4}
        value={text}
        autoFocus={autoFocus}
        disabled={busy}
        aria-invalid={problem !== null}
        aria-describedby={describedBy}
        onChange={(event) => {
          setText(event.target.value);
          if (textProblem !== null) setTextProblem(null);
        }}
      />
      <p className="pd-compose__count" id={countId} data-over={over}>
        {`${length.toLocaleString("en-GB")} / ${POST_TEXT_MAX.toLocaleString("en-GB")}`}
      </p>

      {problem !== null ? (
        <p className="pd-error-text" id={problemId} role="alert">
          {problem}
        </p>
      ) : null}

      {failure !== null ? <FailureText failure={failure} signInHref={signInHref} /> : null}

      <div className="pd-compose__actions">
        <button type="submit" className="pd-button pd-button--primary" disabled={busy}>
          {busy ? "Waiting for your passkey…" : submitLabel}
        </button>
        {onCancel !== undefined ? (
          <button type="button" className="pd-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <p className="pd-compose__hint" id={hintId}>
        You’re signing with your passkey. Scholium never sees your key.
      </p>
    </form>
  );
}
