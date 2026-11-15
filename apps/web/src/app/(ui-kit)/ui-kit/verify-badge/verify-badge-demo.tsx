"use client";

import { useEffect, useRef, useState } from "react";

import { VerifyBadge, type VerifyState } from "../../../../features/ui-kit";

/** How long the demo "checks" before it shows a verdict. */
const CHECK_MS = 1500;

/** What each press of "Re-run check" ends on, in turn. */
const OUTCOMES: readonly VerifyState[] = [
  "verified",
  "anchor_pending",
  "cannot_verify",
  "failed",
];

/**
 * A live badge for `/ui-kit/verify-badge`.
 *
 * "Re-run check" puts the badge in "Checking…" and, a moment later, in the next
 * outcome. It is one badge, re-rendered with a new `state`, never remounted:
 * that is what makes its live region announce the verdict to a screen reader.
 */
export function VerifyBadgeDemo() {
  const [state, setState] = useState<VerifyState>("verified");
  const [runs, setRuns] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const checking = state === "checking";

  const rerun = () => {
    if (checking) return;
    setState("checking");
    timer.current = setTimeout(() => {
      setState(OUTCOMES[(runs + 1) % OUTCOMES.length]);
      setRuns((count) => count + 1);
    }, CHECK_MS);
  };

  return (
    <article className="uk-panel uk-examples">
      <div className="uk-chips">
        <VerifyBadge state={state} />
        <button
          type="button"
          className="uk-button"
          onClick={rerun}
          disabled={checking}
        >
          Re-run check
        </button>
      </div>
      <p className="uk-note">
        Each press shows &ldquo;Checking&hellip;&rdquo; for a moment and then
        the next outcome. With a screen reader on, the new words are read out
        without moving focus.
      </p>
    </article>
  );
}
