"use client";

/**
 * The `/signin` card: one button that signs the API's challenge nonce with
 * the device key (behind a passkey prompt) and then navigates.
 *
 * - New account (no device key yet) → `/onboarding`.
 * - Returning user → the sanitised `next` path, or `/`.
 *
 * Copy follows `docs/design.md`: "Sign-in is a passkey", "Scholium never sees
 * your key". Progress and failures are announced in a polite live region so
 * the flow is usable with a screen reader. Behaviour lives in `useSignIn`;
 * this file is markup only.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

import { SIGNIN_ROTATED_MESSAGE, SIGNIN_UNSUPPORTED_MESSAGE } from "./signin-messages";
import { useSignIn, type SignInAuth } from "./use-signin";

/** Props for {@link SignInForm}. */
export interface SignInFormProps {
  /** Where a returning user should land (from `?next=`); sanitised by `signIn`. */
  next?: string;
  /** Auth layer override, for tests. */
  auth?: SignInAuth;
  /** True when this device's key was just rotated. */
  rotated?: boolean;
}

/** The sign-in button, its progress line and its failure message. */
export function SignInForm({ next, auth, rotated = false }: SignInFormProps) {
  const router = useRouter();
  const { working, done, unsupported, progress, error, start } = useSignIn({
    next,
    auth,
    navigate: (path) => router.replace(path),
  });

  return (
    <section className="wa-card" aria-labelledby="signin-heading">
      <p className="wa-wordmark">scholium</p>
      <h1 id="signin-heading" className="wa-title">
        Sign in
      </h1>
      <p className="wa-lede">
        Use your passkey to sign in. Scholium never sees your key.
      </p>

      {rotated ? (
        <p className="wa-note" role="status">
          {SIGNIN_ROTATED_MESSAGE}
        </p>
      ) : null}

      <button
        type="button"
        className="wa-button"
        onClick={start}
        disabled={working || done || unsupported}
        aria-busy={working}
      >
        {working ? "Waiting for your passkey…" : "Sign in with passkey"}
      </button>

      {/* Always rendered so assistive tech registers the region before it changes. */}
      <p className="wa-progress" role="status" aria-live="polite">
        {progress}
      </p>

      {unsupported ? (
        <p className="wa-error" role="alert">
          <strong>Can&rsquo;t sign in here.</strong> {SIGNIN_UNSUPPORTED_MESSAGE}
        </p>
      ) : null}

      {error ? (
        <p className="wa-error" role="alert">
          <strong>Couldn&rsquo;t sign in.</strong> {error}
        </p>
      ) : null}

      <p className="wa-meta">
        New here? Your first sign-in on this device creates a passkey and your
        account.
      </p>

      <p className="wa-meta">
        Lost your device?{" "}
        <Link className="wa-link" href="/recover">
          Recover your account
        </Link>
      </p>
    </section>
  );
}

export default SignInForm;
