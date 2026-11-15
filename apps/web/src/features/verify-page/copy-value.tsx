"use client";

/**
 * A value in monospace that copies on click and confirms with the "Copied"
 * toast, the way an ID pill does (docs/design.md §2 "always copyable", §7).
 *
 * It is a real button, so Tab, Enter and Space work, and it never claims a
 * copy the browser refused. The full value is what is copied and what the
 * button is named after; `abbreviate` only shortens what is drawn.
 */

import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { shortCid } from "../submit/fingerprint";
import {
  COPIED_MESSAGE,
  COPIED_RESET_MS,
  COPY_FAILED_MESSAGE,
  Icon,
  copyText,
  ensureToastRegion,
  showToast,
} from "../ui-kit";

export interface CopyValueProps {
  /** The full value: what is copied. */
  value: string;
  /** What it is, for the button's name: "Copy Its fingerprint: …". */
  label: string;
  /** Draw it shortened (`bafkreihdwdcef…vyku`); the full value is the tooltip. */
  abbreviate?: boolean;
}

export function CopyValue({ value, label, abbreviate = false }: CopyValueProps) {
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    // The live region must exist before the first toast for it to be announced.
    ensureToastRegion();
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Read the theme now: `currentTarget` is gone once the handler returns.
    const theme = event.currentTarget.closest("[data-theme]")?.getAttribute("data-theme") ?? null;
    // Started inside the click, which is what lets the browser allow the write.
    void copyText(value).then((ok) => {
      showToast(ok ? COPIED_MESSAGE : COPY_FAILED_MESSAGE, { theme });
      if (!ok || !mounted.current) return;
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, COPIED_RESET_MS);
    });
  };

  return (
    <button
      type="button"
      className="vp-copy"
      data-copied={copied}
      aria-label={`Copy ${label}: ${value}`}
      title={abbreviate ? value : undefined}
      onClick={handleClick}
    >
      <code className="vp-copy__value">{abbreviate ? shortCid(value) : value}</code>
      <Icon name={copied ? "check" : "copy"} className="vp-copy__icon" />
    </button>
  );
}
