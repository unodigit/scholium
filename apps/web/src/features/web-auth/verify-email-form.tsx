"use client";

/**
 * `/verify-email` — the page an emailed verification link opens.
 *
 * The API's verification route only accepts POST, so the email must point at
 * this page instead. It reads `?did=…&token=…` from its own address, takes the
 * one-time values out of history, POSTs the token to the API and then shows
 * one of three states: working, verified, or failed. A failed link that is
 * invalid or expired offers a resend (owner-only on the API, so a signed-out
 * visitor is sent to sign in first); a transient failure offers a retry.
 *
 * Behaviour and copy live in `verify-email.ts`; this file is markup plus the
 * two request callbacks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { apiClient } from "../../lib/api";

import {
  VERIFY_EMAIL_EXPIRED_NOTE,
  VERIFY_EMAIL_LINK_INCOMPLETE_MESSAGE,
  VERIFY_EMAIL_RESEND_ACTION,
  VERIFY_EMAIL_RESEND_SIGNIN_ACTION,
  VERIFY_EMAIL_RESENDING,
  VERIFY_EMAIL_RESENT_MESSAGE,
  VERIFY_EMAIL_SESSION_EXPIRED_MESSAGE,
  describeVerifyEmailFailure,
  isOnboardingComplete,
  loadVerifyEmailAccountName,
  parseVerifyEmailLink,
  resendVerificationEmail,
  shortDid,
  verifyEmailAddress,
  verifyEmailContinueHref,
  verifyEmailContinueLabel,
  type VerifyEmailFailure,
  type VerifyEmailLink,
} from "./verify-email";

/** What the page knows about the link it was opened with. */
type Phase =
  | { kind: "checking" }
  | { kind: "verified" }
  | { kind: "failed"; failure: VerifyEmailFailure; canRetry: boolean };

/** The resend control's own little state machine. */
type ResendState = "idle" | "sending" | "sent" | "failed";

/** Copy for the three states. */
const COPY = {
  checking: {
    title: "Verifying your email…",
    message: "Confirming the email address saved on this Scholium account.",
    glyph: "•",
    tone: "checking",
  },
  verified: {
    title: "Email verified",
    message: "The email address saved on this account is now confirmed.",
    glyph: "✓",
    tone: "verified",
  },
  failed: {
    title: "We couldn't verify your email",
    message: "",
    glyph: "!",
    tone: "failed",
  },
} as const;

/** Read the link, then redeem it exactly once (StrictMode mounts twice). */
export function VerifyEmailForm() {
  const [link, setLink] = useState<VerifyEmailLink | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [resendState, setResendState] = useState<ResendState>("idle");
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendNeedsSignIn, setResendNeedsSignIn] = useState(false);
  const [onboarded, setOnboarded] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const startedRef = useRef(false);

  const runVerify = useCallback(async (target: VerifyEmailLink) => {
    setPhase({ kind: "checking" });
    try {
      await verifyEmailAddress(apiClient, target);
      setPhase({ kind: "verified" });
    } catch (failure) {
      const described = describeVerifyEmailFailure(failure);
      setPhase({
        kind: "failed",
        failure: described,
        // Expired/gone links need a new link, not another POST of the same one.
        canRetry: !described.expired && !described.sessionExpired,
      });
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    setOnboarded(isOnboardingComplete());
    const parsed = parseVerifyEmailLink(window.location.search);
    setLink(parsed);
    if (parsed === null) {
      setPhase({
        kind: "failed",
        failure: {
          message: VERIFY_EMAIL_LINK_INCOMPLETE_MESSAGE,
          expired: false,
          sessionExpired: false,
        },
        canRetry: false,
      });
      return;
    }

    // The token is bearer material; keep it out of the address bar and history.
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", pathname + hash);
    // Name the account as the reader knows it, not by its DID. Best-effort:
    // a profile that cannot be read leaves the DID on screen.
    void loadVerifyEmailAccountName(apiClient, parsed.did).then(setAccountName);
    void runVerify(parsed);
  }, [runVerify]);

  // Announce the result from the heading once it is known.
  useEffect(() => {
    if (phase.kind !== "checking") {
      headingRef.current?.focus();
    }
  }, [phase.kind]);

  const resend = useCallback(async () => {
    if (link === null) {
      return;
    }
    setResendState("sending");
    setResendMessage(null);
    setResendNeedsSignIn(false);
    try {
      await resendVerificationEmail(apiClient, link.did);
      setResendState("sent");
    } catch (failure) {
      const described = describeVerifyEmailFailure(failure);
      setResendState("failed");
      setResendMessage(described.message);
      setResendNeedsSignIn(described.sessionExpired);
    }
  }, [link]);

  const copy = COPY[phase.kind];
  const message =
    phase.kind === "failed" ? phase.failure.message : copy.message;

  return (
    <section
      className="wa-card we-card"
      aria-labelledby="verify-email-heading"
      aria-busy={phase.kind === "checking"}
    >
      <style>{STYLES}</style>
      <p className="wa-wordmark">scholium</p>
      <span className={`we-status we-status--${copy.tone}`} aria-hidden="true">
        {copy.glyph}
      </span>
      <h1
        id="verify-email-heading"
        className="wa-title"
        ref={headingRef}
        tabIndex={-1}
      >
        {copy.title}
      </h1>
      <p
        className={
          phase.kind === "failed" ? "wa-lede we-failure" : "wa-lede"
        }
        role="status"
      >
        {message}
      </p>

      {link !== null ? (
        <p className="we-account">
          Account{" "}
          {accountName === null ? (
            <code>{link.did}</code>
          ) : (
            <>
              <span className="we-account-name">{accountName}</span>{" "}
              <code>{shortDid(link.did)}</code>
            </>
          )}
        </p>
      ) : null}

      {phase.kind === "verified" ? (
        <div className="we-actions">
          <Link className="wa-button" href={verifyEmailContinueHref(onboarded)}>
            {verifyEmailContinueLabel(onboarded)}
          </Link>
          <p className="wa-meta">
            <Link className="wa-link" href="/">
              Go to Scholium
            </Link>
          </p>
        </div>
      ) : null}

      {phase.kind === "failed" ? (
        <div className="we-actions">
          {phase.failure.sessionExpired && link !== null ? (
            <Link className="wa-button" href="/signin">
              Sign in again
            </Link>
          ) : null}

          {phase.canRetry ? (
            <button
              type="button"
              className="wa-button"
              onClick={() => {
                if (link !== null) {
                  void runVerify(link);
                }
              }}
            >
              Try again
            </button>
          ) : null}

          {link !== null && phase.failure.expired ? (
            <div className="we-resend">
              <p className="we-expiry">{VERIFY_EMAIL_EXPIRED_NOTE}</p>
              {resendState === "sent" ? (
                <p className="we-note" role="status">
                  {VERIFY_EMAIL_RESENT_MESSAGE}
                </p>
              ) : resendNeedsSignIn ? (
                <>
                  <p className="we-note" role="status">
                    {VERIFY_EMAIL_SESSION_EXPIRED_MESSAGE}
                  </p>
                  <Link className="wa-button" href="/signin">
                    {VERIFY_EMAIL_RESEND_SIGNIN_ACTION}
                  </Link>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="wa-button"
                    onClick={() => void resend()}
                    disabled={resendState === "sending"}
                  >
                    {resendState === "sending"
                      ? VERIFY_EMAIL_RESENDING
                      : VERIFY_EMAIL_RESEND_ACTION}
                  </button>
                  {resendState === "failed" && resendMessage ? (
                    <p className="we-note we-failure" role="alert">
                      {resendMessage}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          <p className="wa-meta">
            <Link className="wa-link" href="/onboarding">
              Back to setup
            </Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Scoped styles for this page. `web-auth.css` supplies the shared card, type
 * and button tokens; these rules add the status ornament, the account line and
 * the small press/reduced-motion details without touching the shared sheet.
 */
const STYLES = `
.we-card {
  border-radius: 16px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    0 0 0 0.5px rgba(0, 0, 0, 0.04),
    0 2px 8px rgba(0, 0, 0, 0.06),
    0 16px 48px rgba(0, 0, 0, 0.12);
}
.we-status {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin: 0 0 20px;
  border-radius: 999px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
}
.we-status--checking {
  background: rgba(47, 75, 160, 0.12);
  color: var(--wa-accent);
  animation: we-pulse 1.4s ease-in-out infinite;
}
.we-status--verified { background: rgba(52, 152, 88, 0.14); color: #217a43; }
.we-status--failed { background: rgba(179, 49, 43, 0.12); color: var(--wa-critical); }
.we-account {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 18px;
  color: var(--wa-ink-2);
}
.we-account code {
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--wa-ink);
}
.we-account-name { font-weight: 600; color: var(--wa-ink); }
.we-actions { display: flex; flex-direction: column; gap: 12px; }
.we-actions .wa-button {
  transition:
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 120ms cubic-bezier(0.23, 1, 0.32, 1);
}
.we-actions .wa-button:active:not(:disabled) { transform: scale(0.98); }
.we-resend { display: flex; flex-direction: column; gap: 12px; }
.we-expiry,
.we-note {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--wa-ink-2);
}
.we-failure { color: var(--wa-critical); }
.we-card .wa-meta { margin: 4px 0 0; }
@keyframes we-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.94); }
}
@media (prefers-color-scheme: dark) {
  .we-card {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.12),
      0 0 0 0.5px rgba(0, 0, 0, 0.4),
      0 2px 8px rgba(0, 0, 0, 0.36),
      0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .we-status--verified { color: #6ee7a0; }
}
@media (prefers-reduced-motion: reduce) {
  .we-status--checking { animation: none; }
  .we-actions .wa-button { transition: none; }
  .we-actions .wa-button:active:not(:disabled) { transform: none; }
}
`;
