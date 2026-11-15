/**
 * Plain-language copy for the sign-in page.
 *
 * Maps every failure {@link signIn} can raise onto one sentence a researcher
 * can act on. Wording follows `docs/design.md` §8: short, no "token", "hash"
 * or "CID", and a failure is a state to recover from, not an alarm.
 */

import { ApiError, NetworkError } from "../../lib/api";

import { isDeviceKeyError } from "./errors";
import { isSignInError, type SignInStage } from "./signin";

/** Copy shown while each {@link SignInStage} is running. */
export const SIGNIN_STAGE_MESSAGES: Record<SignInStage, string> = {
  "creating-passkey": "Creating your passkey. Follow the prompt from your browser or device.",
  "requesting-challenge": "Contacting Scholium…",
  "waiting-for-passkey": "Confirm with your passkey to sign in.",
  verifying: "Signing you in…",
};

/** Shown once the sign-in has succeeded and the page is about to navigate. */
export const SIGNIN_SUCCESS_MESSAGE = "Signed in. Taking you there…";

/** Shown when the browser cannot create a passkey-protected key at all. */
export const SIGNIN_UNSUPPORTED_MESSAGE =
  "This browser can't create a passkey-protected key. Try a current version of Chrome, Safari, Edge or Firefox.";

/** Shown for anything unexpected. */
export const SIGNIN_FALLBACK_MESSAGE = "Sign-in didn't complete. Please try again.";

/** Turn a sign-in failure into one actionable sentence. */
export function describeSignInError(error: unknown): string {
  if (isDeviceKeyError(error)) {
    switch (error.code) {
      case "passkey-cancelled":
        return "The passkey prompt was closed. Choose “Sign in with passkey” to try again.";
      case "passkey-failed":
        return "Your passkey couldn't confirm it's you. Try again, and use your device's PIN or biometric when asked.";
      case "unsupported":
        return SIGNIN_UNSUPPORTED_MESSAGE;
      case "storage-unavailable":
        return "Your browser is blocking local storage, so Scholium can't keep your key on this device. Turn off private browsing or allow site data, then try again.";
      case "invalid-key":
        return "The key saved on this device isn't usable. Try again; if this keeps happening, use “Lost your device?” to recover your account.";
      default:
        return SIGNIN_FALLBACK_MESSAGE;
    }
  }

  if (error instanceof NetworkError) {
    return "Can't reach Scholium. Check your connection and try again.";
  }

  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Scholium couldn't verify that sign-in. Please try again.";
    }
    if (error.status === 429) {
      return "Too many attempts. Wait a moment and try again.";
    }
    if (error.status >= 500) {
      return "Scholium is having trouble right now. Please try again in a moment.";
    }
    return SIGNIN_FALLBACK_MESSAGE;
  }

  if (isSignInError(error)) {
    return "Scholium sent an unexpected reply. Please try again in a moment.";
  }

  return SIGNIN_FALLBACK_MESSAGE;
}
