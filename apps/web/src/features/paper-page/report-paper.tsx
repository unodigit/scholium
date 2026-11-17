"use client";

/**
 * Report a paper (or one of its versions): the same Report panel used for
 * discussion posts, filed against the version's cid (`POST /v1/flags`).
 *
 * ```tsx
 * <ReportPaper versionCid="bafyrei…" />
 * ```
 */

import { useState } from "react";

import { tokenStore } from "../../lib/api";
import { ReportPanel } from "../paper-discussion";
import {
  reportPostFlag,
  type ReportReason,
  type ReportReceipt,
} from "../paper-discussion";

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
  /** Where "Sign in" goes when a session has ended. */
  readonly signInHref?: string;
  /** Pin the sign-in state instead of reading the token store. */
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

const DEFAULT_SIGN_IN_HREF = "/signin";

export function ReportPaper(props: ReportPaperProps) {
  const versionCid =
    props.versionCid ?? props.cid ?? props.target ?? props.targetCid ?? "";
  const signInHref = props.signInHref ?? DEFAULT_SIGN_IN_HREF;
  const signedIn = props.signedIn;
  const report = props.report;
  const onReport = props.onReport;
  const fileFlag = props.fileFlag ?? props.flag ?? props.submit ?? props.send;

  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState<ReportReason | null>(null);

  const isSignedIn =
    signedIn !== undefined ? signedIn : tokenStore.isAuthenticated;

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
        if (typeof window.location.assign === "function") {
          window.location.assign(signInHref);
        } else {
          window.location.href = signInHref;
        }
      }
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="ppg-action pd-action pd-action--report"
        data-action="report"
        onClick={click}
      >
        Report
      </button>
      {open ? (
        <div className="pd-panel">
          <ReportPanel
            authorLabel="this paper"
            signInHref={signInHref}
            onCancel={() => setOpen(false)}
            onReport={file}
          />
        </div>
      ) : null}
    </>
  );
}

export default ReportPaper;
export { ReportPaper as ReportPaperDialog };
export { ReportPaper as ReportPaperButton };