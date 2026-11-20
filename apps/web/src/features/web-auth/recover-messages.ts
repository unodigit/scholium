/**
 * Plain-language copy for the `/recover` page.
 *
 * Wording follows `docs/design.md` §6 and §8: "Lost your device?" is the way
 * in, progress is written as `"2 of 3 approvals"`, the contest window is the
 * **72-hour safety window**, and a cancellation is described by what it
 * protects ("your current key stays active") rather than by alarm. No
 * "token", "hash", "CID" or "contest" in the primary copy.
 */

import { ApiError, NetworkError } from "../../lib/api";

import { isDeviceKeyError } from "./errors";
import {
  RECOVERY_ACCOUNT_NOT_FOUND_TYPE,
  RECOVERY_GUARDIAN_COUNT,
  RECOVERY_GUARDIANS_NOT_SET_TYPE,
  approvalProgressText,
  approvalsRemaining,
  isRecoveryError,
  type RecoverySnapshot,
  type RecoveryStatus,
} from "./recover";

/** Page title. */
export const RECOVER_TITLE = "Recover your account";

/** Lede under the title, on the identify step. */
export const RECOVER_LEDE =
  "Lost your device? Identify yourself with the ORCID iD on your account and your guardians can restore it.";

/** Label of the ORCID input. */
export const RECOVER_ORCID_LABEL = "ORCID iD";

/** Placeholder showing the iD's shape. */
export const RECOVER_ORCID_PLACEHOLDER = "0000-0000-0000-0000";

/** Hint under the ORCID input. */
export const RECOVER_ORCID_HINT =
  "The iD linked to your account, like 0000-0002-1825-0097. A profile link works too.";

/** Shown when the typed-in value cannot be an ORCID iD. */
export const RECOVER_ORCID_INVALID_MESSAGE =
  "That doesn't look like an ORCID iD. Use four groups of four digits, like 0000-0002-1825-0097.";

/** Primary action on the identify step. */
export const RECOVER_START_ACTION = "Start recovery";

/** Progress line while the new passkey is being created. */
export const RECOVER_STARTING_PASSKEY =
  "Creating a new passkey on this device. Follow the prompt from your browser.";

/** Progress line while the request is being opened. */
export const RECOVER_STARTING = "Contacting your guardians…";

/** What the flow does, shown before it starts (design.md §6's own example). */
export const RECOVER_HOW_IT_WORKS_TITLE = "What happens next";

/** The whole flow in one paragraph, using the design's "2 of 3 approvals". */
export const RECOVER_HOW_IT_WORKS =
  "You and your guardians are notified straight away. This page shows their progress — 2 of 3 approvals, for example — then the 72-hour safety window with a cancel link before your new passkey takes over.";

/** Link back to sign-in when recovery is not needed after all. */
export const RECOVER_BACK_TO_SIGNIN = "Back to sign in";

/** Heading over the approval meter. */
export const RECOVER_APPROVALS_HEADING = "Guardian approvals";

/** Heading of the safety-window panel (the design's exact phrase). */
export const RECOVER_SAFETY_WINDOW_HEADING = "72-hour safety window";

/** Shown on a pending request, before the window opens. */
export const RECOVER_SAFETY_WINDOW_PENDING_NOTE =
  "When 3 of your 5 guardians approve, a 72-hour safety window opens before the new key takes over, and you and your guardians are notified. Only the account holder can use the cancel link, from Security; your guardians are told how it ends.";

/** Shown once the window is open but without a readable deadline. */
export const RECOVER_SAFETY_WINDOW_OPEN_NOTE =
  "Enough guardians have approved, so the 72-hour safety window is open. The new key takes over when it closes.";

/** Shown while a cancelled request is on screen. */
export const RECOVER_SAFETY_WINDOW_CANCELLED_NOTE =
  "This recovery was cancelled, so no safety window is running. Your current key stays active.";

/** Shown once the recovery has completed. */
export const RECOVER_SAFETY_WINDOW_FINALIZED_NOTE =
  "The safety window has closed and the recovery is complete. Your new passkey is now the key for this account.";

/** Action that checks for new approvals. */
export const RECOVER_REFRESH_ACTION = "Check for approvals";

/** Progress line while checking. */
export const RECOVER_REFRESHING = "Checking…";

/** Shown when the status route cannot be read yet; never as an error. */
export const RECOVER_STATUS_UNAVAILABLE_NOTE =
  "Approval progress will appear here as your guardians respond. Check again in a moment.";

/** The cancel control. */
export const RECOVER_CANCEL_ACTION = "Cancel this recovery";

/** Progress line while cancelling. */
export const RECOVER_CANCELLING = "Cancelling…";

/** Explanation next to the cancel link. */
export const RECOVER_CANCEL_NOTE =
  "Cancelling needs the passkey of the key still on your account. Only the account holder can cancel; your guardians are told how it ends.";

/** Shown after a request is opened. */
export const RECOVER_STARTED_NOTICE =
  "Recovery started. You and your guardians have been notified.";

/** Shown after a cancellation succeeds. */
export const RECOVER_CANCELLED_NOTICE =
  "Recovery cancelled. Your current key stays active.";

/** Label of the request id shown as a fact. */
export const RECOVER_REQUEST_ID_LABEL = "Recovery request";

/** Label of the ORCID iD shown as a fact. */
export const RECOVER_ACCOUNT_LABEL = "Account";

/**
 * How the progress page names the account being recovered.
 *
 * A person recognises their own account by the profile name they chose; the
 * ORCID iD is how the API identified it, so it follows the name rather than
 * standing in for it. When no public profile name can be read (an erased
 * profile, or a status reply that named no DID), the iD is all there is, and
 * without either the page says what the visitor did instead of inventing one.
 */
export function recoveryAccountLabel(
  accountName: string | null | undefined,
  orcid: string | null | undefined,
): string {
  const name = (accountName ?? "").trim();
  const id = (orcid ?? "").trim();
  if (name !== "") {
    return id !== "" ? `${name} (${id})` : name;
  }
  return id !== "" ? id : "the account you identified";
}

/** Action that forgets this browser's request and shows the form again. */
export const RECOVER_RESET_ACTION = "Recover a different account";

/** Shown for anything unexpected. */
export const RECOVER_FALLBACK_MESSAGE = "That didn't work. Please try again.";

/** The passkey prompt was dismissed. */
export const RECOVER_PASSKEY_CANCELLED_MESSAGE =
  "The passkey prompt was closed. Choose “Start recovery” to try again.";

/** The browser cannot create a passkey-protected key. */
export const RECOVER_UNSUPPORTED_MESSAGE =
  "This browser can't create the passkey a recovery needs. Try a current version of Chrome, Safari, Edge or Firefox.";

/** This device cannot sign for the account's old key. */
export const RECOVER_WRONG_DEVICE_MESSAGE =
  "This device doesn't hold the key that opened the account, so it can't cancel the recovery. Open the cancel link on a device that still has your old passkey.";

/** Someone other than the account holder tried to cancel the recovery. */
export const RECOVER_CANCEL_FORBIDDEN_MESSAGE =
  "Only the account holder can cancel this recovery.";

/** The ORCID iD names no account. */
export const RECOVER_ACCOUNT_NOT_FOUND_MESSAGE =
  "We couldn't find an account linked to that ORCID iD. Check the iD and try again.";

/** The account has no guardians, so nobody can approve. */
export const RECOVER_GUARDIANS_NOT_SET_MESSAGE =
  "That account hasn't set recovery guardians yet, so nobody can approve a recovery. Sign in and set them from /me/security first.";

/** One-word status shown beside the progress meter. */
export function recoveryStatusLabel(status: RecoveryStatus): string {
  switch (status) {
    case "pending":
      return "Waiting for guardians";
    case "contest":
      return "Safety window open";
    case "finalized":
      return "Recovery complete";
    case "cancelled":
      return "Cancelled";
  }
}

/** The paragraph under the progress meter. */
export function recoveryProgressNote(snapshot: RecoverySnapshot): string {
  switch (snapshot.status) {
    case "cancelled":
      return "This recovery was cancelled. Your current key stays active.";
    case "finalized":
      return "All approvals are in and the recovery is complete. Your new passkey now signs for this account.";
    case "contest":
      return "Enough guardians have approved. The 72-hour safety window is open.";
    case "pending": {
      const remaining = approvalsRemaining(snapshot);
      if (remaining === 0) {
        return "All approvals are in. The safety window opens as soon as the request updates.";
      }
      if (remaining === 1) {
        return "1 more guardian approval is needed before the safety window opens.";
      }
      return `${remaining} more guardian approvals are needed before the safety window opens.`;
    }
  }
}

/** The safety-window paragraph for the current state. */
export function safetyWindowNote(
  snapshot: RecoverySnapshot,
  nowMs: number = Date.now(),
  options: { locale?: string; timeZone?: string } = {},
): string {
  switch (snapshot.status) {
    case "cancelled":
      return RECOVER_SAFETY_WINDOW_CANCELLED_NOTE;
    case "finalized":
      return RECOVER_SAFETY_WINDOW_FINALIZED_NOTE;
    case "contest": {
      const deadline = formatRecoveryDeadlineLocal(snapshot.contestUntil, options);
      const approved = Math.max(
        0,
        Math.min(snapshot.approvals, RECOVERY_GUARDIAN_COUNT),
      );
      if (deadline) {
        return (
          `Approved by ${approved} of ${RECOVERY_GUARDIAN_COUNT} guardians. ` +
          `Your new passkey takes over on ${deadline}; until then your old key ` +
          "still works and only you can cancel."
        );
      }
      return RECOVER_SAFETY_WINDOW_OPEN_NOTE;
    }
    case "pending":
      return RECOVER_SAFETY_WINDOW_PENDING_NOTE;
  }
}

/**
 * A deadline as the reader's own clock and zone show it, e.g.
 * `18 Nov 2026, 09:00`. Unlike {@link formatRecoveryDeadline}, which stays in
 * UTC so audit text never shifts, the safety window is something the member
 * plans around, so it reads in their local time.
 */
export function formatRecoveryDeadlineLocal(
  value: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
    timeZoneName: "short",
  }).format(date);
}

/** The progress line for the meter and its text alternative. */
export function recoveryProgressLine(snapshot: RecoverySnapshot): string {
  return approvalProgressText(snapshot.approvals, snapshot.threshold);
}

/** Turn a recovery failure into one actionable sentence. */
export function describeRecoveryError(error: unknown): string {
  if (isDeviceKeyError(error)) {
    switch (error.code) {
      case "passkey-cancelled":
        return RECOVER_PASSKEY_CANCELLED_MESSAGE;
      case "passkey-failed":
        return "Your passkey couldn't confirm it's you. Try again, and use your device's PIN or biometric when asked.";
      case "unsupported":
        return RECOVER_UNSUPPORTED_MESSAGE;
      case "storage-unavailable":
        return "Your browser is blocking local storage, so Scholium can't keep the new key on this device. Turn off private browsing or allow site data, then try again.";
      case "not-found":
        return RECOVER_WRONG_DEVICE_MESSAGE;
      case "locked":
        return "Unlock your passkey to continue, then try again.";
      default:
        return RECOVER_FALLBACK_MESSAGE;
    }
  }

  if (error instanceof NetworkError) {
    return "Can't reach Scholium. Check your connection and try again.";
  }

  if (error instanceof ApiError) {
    if (error.type === RECOVERY_ACCOUNT_NOT_FOUND_TYPE || error.status === 404) {
      return RECOVER_ACCOUNT_NOT_FOUND_MESSAGE;
    }
    if (error.type === RECOVERY_GUARDIANS_NOT_SET_TYPE || error.status === 409) {
      return RECOVER_GUARDIANS_NOT_SET_MESSAGE;
    }
    if (error.status === 401) {
      return RECOVER_WRONG_DEVICE_MESSAGE;
    }
    if (error.status === 403) {
      return RECOVER_CANCEL_FORBIDDEN_MESSAGE;
    }
    if (error.status === 429) {
      return "Too many attempts. Wait a moment and try again.";
    }
    if (error.status >= 500) {
      return "Scholium is having trouble right now. Please try again in a moment.";
    }
    if (error.status === 422 && error.detail && error.detail !== error.title) {
      return error.detail;
    }
    return RECOVER_FALLBACK_MESSAGE;
  }

  if (isRecoveryError(error)) {
    switch (error.code) {
      case "invalid-orcid":
        return RECOVER_ORCID_INVALID_MESSAGE;
      case "invalid-public-key":
        return "This device's key couldn't be used for the recovery. Try again.";
      case "invalid-response":
        return "Scholium sent an unexpected reply. Please try again in a moment.";
    }
  }

  return RECOVER_FALLBACK_MESSAGE;
}
