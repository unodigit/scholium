/**
 * Plain-language copy for the `/onboarding` page.
 *
 * Wording follows `docs/design.md` §8: short sentences, no "token", "hash"
 * or "CID", and guardians are stated as the strong recommendation they are
 * ("without guardians you cannot recover your account"), not as a rule nothing
 * enforces. Step titles and summaries live with the step model in
 * `onboarding.ts`.
 */

import { ApiError, NetworkError } from "../../lib/api";

import { GuardianSaveError, OnboardingError } from "./onboarding";

/** Lede under the page title. */
export const ONBOARDING_LEDE = "A few quick steps and you're ready to read and publish.";

/** Passkey step, done. */
export const ONBOARDING_PASSKEY_DONE =
  "Passkey created on this device. Your key never leaves it.";

/** Passkey step, not done (the visitor has not signed in here). */
export const ONBOARDING_PASSKEY_MISSING =
  "No passkey on this device yet. Sign in — your first sign-in creates one.";

/** Passkey step, while the device is being checked. */
export const ONBOARDING_PASSKEY_CHECKING = "Checking this device…";

/** Shown while the passkey step links to `/signin`. */
export const ONBOARDING_PASSKEY_SIGNIN_ACTION = "Sign in to create your passkey";

/** Profile step: label of the display-name input. */
export const PROFILE_NAME_LABEL = "Display name";

/** Profile step: label of the (optional) affiliation input. */
export const PROFILE_AFFILIATION_LABEL = "Affiliation (optional)";

/** Profile step: label of the email input. */
export const PROFILE_EMAIL_LABEL = "Email";

/** Profile step: why the email is needed, under the field. */
export const PROFILE_EMAIL_HINT =
  "Used to verify your account. It is never shown on your public profile.";

/** Profile step: why the name matters, under the fields. */
export const PROFILE_NAME_HINT =
  "This is the name readers see on your papers, reviews and profile.";

/** Profile step: save the profile. */
export const PROFILE_SAVE_ACTION = "Save profile";

/** Profile step, while saving. */
export const PROFILE_SAVING = "Saving…";

/** Profile step, done. */
export function profileSavedMessage(name: string): string {
  return `Saved as ${name}. Readers will see this name instead of your account ID.`;
}

/** Link ORCID step, before it starts. */
export const ORCID_START_ACTION = "Link your ORCID iD";

/** Link ORCID step, started already: send the browser to ORCID again. */
export const ORCID_CONTINUE_ACTION = "Continue at ORCID";

/** Link ORCID step, while the authorize URL is fetched. */
export const ORCID_STARTING = "Opening ORCID…";

/** Link ORCID step, started but not confirmed finished. */
export const ORCID_STARTED_NOTE =
  "You've started linking. Finish signing in at ORCID, then come back here.";

/** Link ORCID step after a failed attempt: start over with a fresh authorize URL. */
export const ORCID_RETRY_ACTION = "Try again";

/** Link ORCID step, done. */
export const ORCID_LINKED_NOTE = "Your ORCID iD is linked to this account.";

/** `/onboarding/orcid`: heading while the link is being confirmed. */
export const ORCID_RETURN_WORKING_TITLE = "Linking your ORCID iD…";

/** `/onboarding/orcid`: shown while the link is being confirmed. */
export const ORCID_RETURN_WORKING_NOTE = "Confirming with ORCID. This only takes a moment.";

/** `/onboarding/orcid`: heading once the iD is linked. */
export const ORCID_RETURN_LINKED_TITLE = "ORCID iD linked";

/** `/onboarding/orcid`: heading when the link did not happen. */
export const ORCID_RETURN_FAILED_TITLE = "We couldn't link your ORCID iD";

/** `/onboarding/orcid`: what the success looks like, naming the iD when known. */
export function orcidReturnLinkedMessage(orcid: string | null): string {
  return orcid ? `Your ORCID iD ${orcid} is now linked to this account.` : ORCID_LINKED_NOTE;
}

/** `/onboarding/orcid`: the user chose not to share their iD at ORCID. */
export const ORCID_RETURN_DENIED_MESSAGE =
  "You didn't allow Scholium to confirm your ORCID iD, so nothing was linked. You can try again whenever you're ready.";

/** `/onboarding/orcid`: opened without coming back from ORCID. */
export const ORCID_RETURN_MISSING_MESSAGE =
  "This page finishes linking your ORCID iD after you sign in at ORCID. Start from the setup checklist.";

/** `/onboarding/orcid`: carry on with the checklist after a success. */
export const ORCID_RETURN_CONTINUE_ACTION = "Continue setting up";

/** `/onboarding/orcid`: go back to the checklist after a failure. */
export const ORCID_RETURN_BACK_ACTION = "Back to setup";

/** `/onboarding/orcid`: the session ended, so sign in again first. */
export const ORCID_RETURN_SIGNIN_ACTION = "Sign in again";

/** Categories step: save the picks. */
export const CATEGORIES_SAVE_ACTION = "Save categories";

/** Categories step, while saving. */
export const CATEGORIES_SAVING = "Saving…";

/** Categories step: add a typed-in category. */
export const CATEGORIES_ADD_ACTION = "Add";

/** Accessible label of the add-a-category input. */
export const CATEGORIES_ADD_LABEL = "Add another category, like math.CO";

/** Categories step: the typed-in value cannot be a category. */
export const CATEGORY_INVALID_MESSAGE =
  "That doesn't look like a category. Try something like cs.AI or stat.ML.";

/** What the step shows once the picks are saved. */
export function categoriesSavedMessage(categories: readonly string[]): string {
  return `Following ${categories.join(", ")}.`;
}

/** Appended when the picks could only be kept on this device. */
export const CATEGORIES_SAVED_LOCALLY_SUFFIX =
  " Kept on this device — they'll follow your account once category following is available here.";

/** Guardians step: save the list. */
export const GUARDIANS_SAVE_ACTION = "Save guardians";

/** Guardians step, while saving. */
export const GUARDIANS_SAVING = "Saving…";

/** Guardians step, done. */
export const GUARDIANS_SAVED_NOTE =
  "Five guardians set. You can change them at any time from Security on your dashboard (/me/security).";

/**
 * What guardians are for, stated where the step is.
 *
 * They are recommended, not required — no submission is refused without them.
 */
export const GUARDIANS_REQUIRED_NOTE =
  "Strongly recommended: without guardians you cannot recover your account if you lose this device.";

/** The gentle nag next to the finish gate (design.md §6). */
export const GUARDIANS_SKIP_NOTE =
  "You can skip this now and add guardians later from Security on your dashboard (/me/security) — without them, you cannot recover your account if you lose this device.";

/** Primary action once the steps are done. */
export const ONBOARDING_FINISH_ACTION = "Start reading Scholium";

/** The gentle way out while the guardians step is unfinished. */
export const ONBOARDING_SKIP_ACTION = "Skip for now";

/** Shown for anything unexpected. */
export const ONBOARDING_FALLBACK_MESSAGE = "That didn't work. Please try again.";

/** The session ended mid-onboarding. */
export const ONBOARDING_SESSION_EXPIRED_MESSAGE =
  "Your session has ended. Sign in again to continue.";

/** `n of total steps complete`, for the checklist header. */
export function onboardingProgressMessage(completed: number, total: number): string {
  return `${completed} of ${total} steps complete`;
}

/** Turn an onboarding action failure into one actionable sentence. */
export function describeOnboardingError(error: unknown): string {
  if (error instanceof NetworkError) {
    return "Can't reach Scholium. Check your connection and try again.";
  }

  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return ONBOARDING_SESSION_EXPIRED_MESSAGE;
    }
    if (error.isRateLimited) {
      return "Too many attempts. Wait a moment and try again.";
    }
    if (error.isServerError) {
      return "Scholium is having trouble right now. Please try again in a moment.";
    }
    if (error.detail && error.detail !== error.title) {
      return error.detail;
    }
    return ONBOARDING_FALLBACK_MESSAGE;
  }

  if (error instanceof GuardianSaveError) {
    return error.message;
  }

  if (error instanceof OnboardingError) {
    if (error.code === "invalid-response") {
      return "Scholium sent an unexpected reply. Please try again in a moment.";
    }
    return error.message;
  }

  return ONBOARDING_FALLBACK_MESSAGE;
}
