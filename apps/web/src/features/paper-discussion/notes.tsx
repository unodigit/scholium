/**
 * The two sentences the Discussion tab says in more than one place.
 *
 * - {@link FailureText}: why an action did not go through, with a Sign in link
 *   when the session is the problem. Words, never colour alone; announced as
 *   it appears (`role="alert"`), except a repeated helpful mark, which is
 *   information rather than an error (`role="status"`).
 * - {@link SignInNote}: what a signed-out reader sees where a form would be.
 */

import type { ActionFailure } from "./discussion";

export interface FailureTextProps {
  failure: ActionFailure;
  signInHref: string;
  id?: string;
}

export function FailureText({ failure, signInHref, id }: FailureTextProps) {
  return (
    <p
      className="pd-error-text"
      id={id}
      role={failure.alreadyDone ? "status" : "alert"}
      data-already-done={failure.alreadyDone || undefined}
    >
      {failure.message}
      {failure.signIn ? (
        <>
          {" "}
          <a className="pd-link" href={signInHref}>
            Sign in
          </a>
        </>
      ) : null}
    </p>
  );
}

export interface SignInNoteProps {
  /** What signing in lets the reader do: "reply", "report a post", … */
  to: string;
  signInHref: string;
}

export function SignInNote({ to, signInHref }: SignInNoteProps) {
  return (
    <p className="pd-note" role="note" data-note="sign-in">
      <a className="pd-link" href={signInHref}>
        Sign in
      </a>
      {` to ${to}.`}
    </p>
  );
}
