/**
 * Plain-language failures for the two actions on a revealed review: an
 * author's point-by-point reply and a tier-3 member's quality rating.
 *
 * Both are writes to the same plugin, so they fail in the same ways — a
 * cancelled passkey, an ended session, a refusal for who the caller is, an
 * unknown review, an unreachable API — and both say so in the same words,
 * ending with whether anything was sent. Only the nouns and the refusal
 * sentences differ, so they are passed in.
 *
 * Pure functions, no React.
 */

import { ApiError, NetworkError } from "../../lib/api";
import {
  isDeviceKeyError,
  isPasskeyCancellation,
  isRecordSigningError,
} from "../web-auth/errors";

/** What the card shows when an action fails: a sentence and an optional sign-in. */
export interface ActionFailure {
  readonly message: string;
  /** Offer a "Sign in" link beside the message (the session has ended). */
  readonly signIn: boolean;
}

/** The words that differ between one action and another. */
export interface ActionWords {
  /** What was being sent, e.g. `reply` or `rating`. */
  readonly noun: string;
  /** Said when the API refuses the caller (`403`) without a reason of its own. */
  readonly forbidden: string;
  /** Said when the API refuses a repeat (`409`) without a reason of its own. */
  readonly conflict: string;
  /** Said when the API fails (`5xx`); defaults to "try again in a moment". */
  readonly serverError?: string;
}

/** Said at the end of every failure, so no one wonders whether it went through. */
export const NOT_SENT = "Nothing was sent.";

function failure(message: string, signIn = false): ActionFailure {
  return { message, signIn };
}

/** A sentence from the API's own words, ending in a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * One plain-language failure for whatever an action threw.
 *
 * The API decides who may reply or rate (a paper author may reply; a tier-3
 * member who is neither the reviewer nor an author may rate), so a refusal is
 * shown in the API's own words when it gave any.
 */
export function describeActionError(
  error: unknown,
  words: ActionWords,
): ActionFailure {
  const cancelled = `Signing was cancelled, so your ${words.noun} was not sent. ${NOT_SENT} Sign again when you are ready.`;

  if (isPasskeyCancellation(error)) {
    return failure(cancelled);
  }
  if (isDeviceKeyError(error)) {
    if (error.code === "passkey-cancelled") {
      return failure(cancelled);
    }
    return failure(
      error.code === "not-found"
        ? `This device has no signing key, so it cannot sign your ${words.noun}. ${NOT_SENT}`
        : error.code === "passkey-failed"
          ? `The passkey could not be confirmed. ${NOT_SENT} Try again.`
          : `Could not sign with this device’s key. ${NOT_SENT}`,
    );
  }
  if (isRecordSigningError(error)) {
    return failure(`Could not prepare the ${words.noun} record. ${NOT_SENT}`);
  }

  if (error instanceof ApiError) {
    // What the server actually said. `error.detail` is never empty: it falls
    // back to the status title ("Forbidden"), which is no reason at all, so
    // the problem document is read directly.
    const said = error.problem.detail;
    const detail = typeof said === "string" ? said.trim() : "";
    switch (error.status) {
      case 401:
        return failure(`Your session has ended. ${NOT_SENT}`, true);
      case 403:
        return failure(`${sentence(detail || words.forbidden)} ${NOT_SENT}`);
      case 404:
        return failure(
          `This review could not be found on this node. ${NOT_SENT} Reload the page and try again.`,
        );
      case 409:
        return failure(`${sentence(detail || words.conflict)} ${NOT_SENT}`);
      default: {
        // A 5xx has no sentence worth reading; say the API failed and that
        // nothing is known to have been saved.
        if (error.status >= 500) {
          return failure(
            words.serverError ??
              `Scholium could not save the ${words.noun} just now. ${NOT_SENT} Try again in a moment.`,
          );
        }
        const reason = detail || error.title;
        return failure(
          reason
            ? `${sentence(reason)} ${NOT_SENT}`
            : `The API refused the ${words.noun}. ${NOT_SENT}`,
        );
      }
    }
  }

  if (error instanceof NetworkError) {
    return failure(
      `Scholium could not reach the API. ${NOT_SENT} Check your connection and try again.`,
    );
  }

  return failure(
    error instanceof Error && error.message
      ? `${sentence(error.message)} ${NOT_SENT}`
      : `The ${words.noun} could not be sent. ${NOT_SENT}`,
  );
}
