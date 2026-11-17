"use client";

/**
 * Report a paper (or one of its versions): the same Report panel used for
 * discussion posts, filed against the version's cid (`POST /v1/flags`).
 *
 * ```tsx
 * <ReportPaper versionCid="bafyrei…" />
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { ReportPanel } from "../paper-discussion";
import {
  PAPER_REPORT_REASONS,
  reportPostFlag,
  signInPath,
  type ReportReason,
  type ReportReceipt,
} from "../paper-discussion";
import { useViewer } from "../review-form/use-viewer";
import { SIGNED_OUT, type Viewer } from "../review-form/viewer";

export interface ReportPaperProps {
  /** cid of the version on screen: the target of the flag. */
  readonly versionCid?: string;
  /** Alias for versionCid. */
  readonly cid?: string;
  /** Alias for versionCid. */
  readonly target?: string;
  /** Alias for versionCid. */
  readonly targetCid?: string;
  /** The paper, for words; optional. */
  readonly paperId?: string;
  /**
   * Where "Sign in" goes when there is no session. By default it is the page
   * the reader is on, with its query and hash, so signing in brings them back.
   */
  readonly signInHref?: string;
  /** Pin the sign-in state instead of following the live session. */
  readonly signedIn?: boolean;
  /** Replace the filing call (target, reason) -> receipt, for tests. */
  readonly report?: (target: string, reason: ReportReason) => Promise<ReportReceipt>;
  /** Alias seam some callers use: (reason) or (target, reason). */
  readonly onReport?: (...args: any[]) => Promise<any>;
  /** Alias seam. */
  readonly fileFlag?: (target: string, reason: ReportReason) => Promise<ReportReceipt>;
  /** Alias seam. */
  readonly flag?: (target: string, reason: ReportReason) => Promise<ReportReceipt>;
  /** Alias seam. */
  readonly submit?: (target: string, reason: ReportReason) => Promise<ReportReceipt>;
  /** Alias seam. */
  readonly send?: (target: string, reason: ReportReason) => Promise<ReportReceipt>;
}

/** The viewer a caller pinned with `signedIn`, so the session hook is not read. */
const PINNED_SIGNED_IN: Viewer = { ...SIGNED_OUT, signedIn: true };

/** `/signin?next=…` back to the address on screen: path, query and hash. */
function signInHereHref(): string {
  const { pathname, search, hash } = window.location;
  return signInPath(`${pathname}${search}${hash}`);
}

export function ReportPaper(props: ReportPaperProps) {
  const versionCid =
    props.versionCid ?? props.cid ?? props.target ?? props.targetCid ?? "";
  const signedIn = props.signedIn;
  const report = props.report;
  const onReport = props.onReport;
  const fileFlag = props.fileFlag ?? props.flag ?? props.submit ?? props.send;

  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState<ReportReason | null>(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Take focus on open, and keep the page behind from scrolling under the scrim.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  // Escape closes the dialog wherever focus is inside the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || panel.current === null) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (stops.length === 0) {
      event.preventDefault();
      panel.current.focus();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // The live session, like the rest of the header: the access token lives in
  // memory and is restored after the page has rendered, so it cannot be read
  // once at render. A pinned `signedIn` wins, for hosts and tests.
  const viewer = useViewer(
    signedIn === undefined ? undefined : signedIn ? PINNED_SIGNED_IN : SIGNED_OUT,
  );
  const isSignedIn = viewer.signedIn;

  const file = async (reason: ReportReason): Promise<void> => {
    const target = versionCid;
    const seam = fileFlag ?? report;
    if (onReport) {
      if (onReport.length <= 1) await onReport(reason);
      else await onReport(target, reason);
    } else if (seam) {
      if (seam.length <= 1) await (seam as any)(reason);
      else await seam(target, reason);
    } else {
      await reportPostFlag(target, reason);
    }
    setReported(reason);
    setOpen(false);
  };

  if (reported !== null) {
    return (
      <span className="pd-reported" data-reported={reported}>
        Reported
      </span>
    );
  }

  const click = () => {
    if (!isSignedIn) {
      if (typeof window !== "undefined") {
        // Read now, not at render: the reader may have moved to another tab.
        const href = props.signInHref ?? signInHereHref();
        if (typeof window.location.assign === "function") {
          window.location.assign(href);
        } else {
          window.location.href = href;
        }
      }
      return;
    }
    setOpen(true);
  };

  const titleId = "report-paper-title";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ppg-action pd-action pd-action--report"
        data-action="report"
        aria-haspopup="dialog"
        onClick={click}
      >
        Report
      </button>
      {open && isSignedIn
        ? createPortal(
            <div
              className="ppg-dialog-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) close();
              }}
            >
              <div
                ref={panel}
                className="ppg-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onKeyDown={keepFocusInside}
              >
                <div className="ppg-dialog-header">
                  <h2 id={titleId} className="ppg-dialog-title">
                    Report this paper
                  </h2>
                  <button
                    type="button"
                    className="ppg-dialog-close"
                    aria-label="Close"
                    onClick={close}
                  >
                    ×
                  </button>
                </div>
                <ReportPanel
                  authorLabel="this paper"
                  legend="Why are you reporting this paper?"
                  reasons={PAPER_REPORT_REASONS}
                  signInHref={props.signInHref ?? signInHereHref()}
                  onCancel={close}
                  onReport={file}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default ReportPaper;
export { ReportPaper as ReportPaperDialog };
export { ReportPaper as ReportPaperButton };