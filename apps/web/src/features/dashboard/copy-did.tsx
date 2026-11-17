"use client";

/**
 * "Copy DID" beside the short DID in a profile's header.
 *
 * The header shows a DID shortened to something readable (`z6MkpT…vktH`);
 * this puts the *full* one on the clipboard, which is what a reader pastes
 * into a search, a bug report or an endorsement.
 *
 * Feedback is one message in one place: the status element beside the button
 * is both what a sighted reader sees ("Copied", "Copy failed") and the live
 * region a screen reader announces, so both get the same words. It sits
 * outside the button, since a button's children are presentational and a live
 * region inside one is not reliably announced. The check icon replaces the
 * copy icon on success, so the outcome never rests on colour alone.
 *
 * The button is never disabled while the message shows: copying is
 * idempotent, and disabling would drop keyboard focus and block a retry after
 * a failure. A repeated click restarts the timer rather than stacking one.
 */

import { useEffect, useRef, useState } from "react";

/** How long the message stays before the status is cleared (ms). */
const MESSAGE_MS = 2000;

type CopyOutcome = "copied" | "failed" | null;

/** Props for {@link CopyDid}. */
export interface CopyDidProps {
  /** The full DID to put on the clipboard. */
  readonly did: string;
}

export function CopyDid({ did }: CopyDidProps) {
  const [outcome, setOutcome] = useState<CopyOutcome>(null);
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // VoiceOver skips a message identical to the previous one from the same
  // region, so a repeat gets a no-break space (not read aloud) to differ.
  const lastMessage = useRef("");

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    clearTimeout(timer.current);
    let ok = false;
    try {
      await navigator.clipboard.writeText(did);
      ok = true;
    } catch {
      // Denied, or no clipboard (an insecure context): reported below.
    }
    let next = ok ? "Copied" : "Copy failed";
    if (next === lastMessage.current) {
      next += " ";
    }
    lastMessage.current = ok ? "Copied" : "Copy failed";
    setOutcome(ok ? "copied" : "failed");
    setMessage(next);
    timer.current = setTimeout(() => {
      setOutcome(null);
      setMessage("");
    }, MESSAGE_MS);
  };

  return (
    <span className="pp-copy">
      <button
        type="button"
        className="pp-copy-button"
        data-copied={outcome === "copied" ? "" : undefined}
        data-failed={outcome === "failed" ? "" : undefined}
        onClick={() => void copy()}
      >
        <svg
          className="pp-copy-icon"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {outcome === "copied" ? (
            <path d="M3 8.5l3.2 3L13 4.5" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="7.5" height="8" rx="1.5" />
              <path d="M10.5 3.5a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 3.5V10a1.5 1.5 0 0 0 1.5 1.5" />
            </>
          )}
        </svg>
        Copy DID
      </button>
      <span className="pp-copy-tip" role="status">
        {message}
      </span>
    </span>
  );
}

export default CopyDid;
