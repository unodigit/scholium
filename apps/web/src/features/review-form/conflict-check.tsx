"use client";

/**
 * The conflict check above the review form (docs/design.md §5.5).
 *
 * Three checks — not an author, no recent co-authorship, a different
 * institution — each shown with a shape and a word, never colour alone. The
 * panel sits between the anonymity notice and the form.
 *
 * Who may ask is part of the answer: a signed-out visitor is asked to sign in
 * rather than shown three empty rows. Once signed in, the panel loads
 * `GET /v1/papers/{id}/coi-check` on mount and offers a retry if it fails; the
 * failure never hides the form, because the conflict check is advisory.
 *
 * Every network seam is injectable for tests.
 */

import { useEffect, useId, useRef, useState } from "react";

import { useSignedIn } from "../../components/nav/session";
import { Icon } from "../ui-kit/icons";
import {
  CONFLICT_CHECK_TITLE,
  CONFLICT_STATUS_SPECS,
  describeConflictError,
  describeConflictSummary,
  loadConflictCheck,
  type ConflictReport,
  type LoadConflictCheck,
} from "./conflict";
import { reviewSignInHref } from "./links";
import "./review-form.css";

export interface ConflictCheckProps {
  /** The paper's id, `sch:xxxx-xxxx-xxxx`. */
  paperId: string;
  /** A report fetched elsewhere, so the first paint already shows it. */
  initial?: ConflictReport;
  /** Why a server fetch failed; the panel offers a retry. */
  initialError?: string;
  /** Replace the loader, for tests or another source. Keep it stable. */
  load?: LoadConflictCheck;
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /** Where "Sign in" goes; defaults to sign-in, then back to this review. */
  signInHref?: string;
}

type View =
  | { readonly kind: "signed-out" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string; readonly signIn: boolean }
  | { readonly kind: "ready"; readonly report: ConflictReport };

/** Sign-in with a way back to this review: `/signin?next=%2Freview%2F…`. */
export function conflictSignInHref(paperId: string): string {
  return reviewSignInHref(paperId);
}

function initialView(
  signedIn: boolean,
  initial: ConflictReport | undefined,
  initialError: string | undefined,
): View {
  // A report that is already here is shown whether or not this render can see
  // the session: the server may have fetched it for a signed-in reviewer.
  if (initialError !== undefined && initialError !== "") {
    return { kind: "error", message: initialError, signIn: false };
  }
  if (initial !== undefined) return { kind: "ready", report: initial };
  if (!signedIn) return { kind: "signed-out" };
  return { kind: "loading" };
}

export function ConflictCheck({
  paperId,
  initial,
  initialError,
  load,
  signedIn: signedInOverride,
  signInHref: signInHrefOverride,
}: ConflictCheckProps) {
  const signedIn = useSignedIn(signedInOverride);
  const signInHref = signInHrefOverride ?? conflictSignInHref(paperId);
  const uid = useId();
  const titleId = `${uid}-title`;

  const [view, setView] = useState<View>(() =>
    initialView(signedIn, initial, initialError),
  );
  // A retry is the only reason to ask again once the server has answered.
  const answered = initial !== undefined || (initialError !== undefined && initialError !== "");
  const [attempt, setAttempt] = useState(0);
  const [sourceKey, setSourceKey] = useState(paperId);

  // An SPA can move to another paper without remounting: never show the old
  // paper's conflicts under the new title.
  if (sourceKey !== paperId) {
    setSourceKey(paperId);
    setAttempt(0);
    setView(initialView(signedIn, initial, initialError));
  }

  // The latest loader without making an inline function restart the request.
  const loadRef = useRef<LoadConflictCheck>(load ?? loadConflictCheck);
  useEffect(() => {
    loadRef.current = load ?? loadConflictCheck;
  }, [load]);

  useEffect(() => {
    if (attempt === 0 && answered) {
      // The server already answered; only a retry asks again.
      setView(initialView(signedIn, initial, initialError));
      return;
    }
    if (!signedIn) {
      setView({ kind: "signed-out" });
      return;
    }

    let cancelled = false;
    setView({ kind: "loading" });
    loadRef.current(paperId).then(
      (report) => {
        if (!cancelled) setView({ kind: "ready", report });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = describeConflictError(error);
        setView({
          kind: "error",
          message,
          signIn: /session has ended/i.test(message),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paperId, signedIn, attempt, answered, initial, initialError]);

  return (
    <section
      className="rf-coi"
      aria-labelledby={titleId}
      data-state={view.kind}
    >
      <h2 id={titleId} className="rf-coi-title">
        {CONFLICT_CHECK_TITLE}
      </h2>

      {view.kind === "signed-out" ? (
        <p className="rf-coi-note">
          Sign in to check for conflicts of interest before you review this
          paper.{" "}
          <a className="rf-link" href={signInHref}>
            Sign in
          </a>
        </p>
      ) : null}

      {view.kind === "loading" ? (
        <p className="rf-coi-loading" role="status">
          <Icon name="spinner" className="rf-coi-spinner" />
          Checking for conflicts…
        </p>
      ) : null}

      {view.kind === "error" ? (
        <div className="rf-coi-error" role="alert">
          <p className="rf-coi-error-message">{view.message}</p>
          <button
            type="button"
            className="rf-button rf-button--quiet"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
          {view.signIn ? (
            <a className="rf-link" href={signInHref}>
              Sign in
            </a>
          ) : null}
        </div>
      ) : null}

      {view.kind === "ready" ? <ConflictRows report={view.report} /> : null}
    </section>
  );
}

function ConflictRows({ report }: { report: ConflictReport }) {
  return (
    <>
      <p className="rf-coi-summary">{describeConflictSummary(report)}</p>
      <ul className="rf-coi-list" aria-label="Conflict checks">
        {report.checks.map((check) => {
          const spec = CONFLICT_STATUS_SPECS[check.status];
          return (
            <li
              key={check.id}
              className="rf-coi-row"
              data-check={check.id}
              data-status={check.status}
            >
              <span className="rf-coi-status">
                <Icon name={spec.icon} className="rf-coi-status-icon" />
                <span className="rf-coi-status-word">{spec.label}</span>
              </span>
              <span className="rf-coi-check-label">{check.label}</span>
              {check.detail === "" ? null : (
                <span className="rf-coi-detail">{check.detail}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default ConflictCheck;
