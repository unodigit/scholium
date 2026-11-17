/**
 * The web end of an emailed email-verification link.
 *
 * The API mails a link to `<web origin>/verify-email?did=…&token=…` — never to
 * the API route itself, which only accepts POST. This module parses that link,
 * redeems the token with `POST /v1/profiles/{did}/verify-email`, explains a
 * failure, and asks for a fresh link (`…/verify-email/resend`) when the old one
 * has expired. `verify-email-form.tsx` renders the states.
 */

import { ApiError, NetworkError } from "../../lib/api";
import type { ApiClient } from "../../lib/api";

/** The query parameters an emailed verification link carries. */
export interface VerifyEmailLink {
  /** The account whose address is being verified. */
  did: string;
  /** The signed token that proves control of the address. */
  token: string;
}

/** The slice of {@link ApiClient} the verification page uses. */
export type VerifyEmailClient = Pick<ApiClient, "post" | "get">;

/** The one-time values are bearer material; never leave them in history. */
export const VERIFY_EMAIL_PATH = "/verify-email";

/** Shown when the page is opened without the parameters a link carries. */
export const VERIFY_EMAIL_LINK_INCOMPLETE_MESSAGE =
  "This verification link is incomplete. Open the link from your email again, or ask for a new one.";

/** Explains why the resend option exists at all. */
export const VERIFY_EMAIL_EXPIRED_NOTE =
  "Verification links expire after 24 hours for safety.";

/** The resend action on the expired-link screen. */
export const VERIFY_EMAIL_RESEND_ACTION = "Resend verification email";

/** The resend action while the request is in flight. */
export const VERIFY_EMAIL_RESENDING = "Sending…";

/** A fresh link has been handed to the mail transport. */
export const VERIFY_EMAIL_RESENT_MESSAGE =
  "A new verification link is on its way to the address on this account.";

/** The resend request needs a signed-in owner. */
export const VERIFY_EMAIL_RESEND_SIGNIN_ACTION = "Sign in to send a new link";

/** The session ended; the visitor must sign in before a resend can work. */
export const VERIFY_EMAIL_SESSION_EXPIRED_MESSAGE =
  "Your session has ended. Sign in again to send a new link.";

/** Read `did` and `token` from a location search string; `null` when incomplete. */
export function parseVerifyEmailLink(search: string): VerifyEmailLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const did = (params.get("did") ?? "").trim();
  const token = (params.get("token") ?? "").trim();
  if (did === "" || token === "") {
    return null;
  }
  return { did, token };
}

/**
 * Redeem the link's token: `POST /v1/profiles/{did}/verify-email`.
 *
 * The token travels as a JSON body member, so it never lands in a server
 * access log the way a query string would.
 */
export async function verifyEmailAddress(
  client: VerifyEmailClient,
  link: VerifyEmailLink,
): Promise<void> {
  await client.post(`/profiles/${encodeURIComponent(link.did)}/verify-email`, {
    token: link.token,
  });
}

/**
 * Ask the API to mail a fresh link to the address already saved for `did`.
 *
 * Owner-only on the API; a 401 here means the visitor is signed out and needs
 * to sign in before the resend can happen.
 */
export async function resendVerificationEmail(
  client: VerifyEmailClient,
  did: string,
): Promise<void> {
  await client.post(`/profiles/${encodeURIComponent(did)}/verify-email/resend`);
}

/**
 * The public name of the account a verification link names, or `null`.
 *
 * The link only carries the DID, which is not how a person recognises their
 * account; the profile does have the name they chose. The read is public
 * (the email address itself is not) and best-effort: a profile that cannot be
 * read leaves the page showing the DID rather than failing the verification.
 */
export async function loadVerifyEmailAccountName(
  client: VerifyEmailClient,
  did: string,
): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await client.get<unknown>(`/profiles/${encodeURIComponent(did)}`, {
      auth: false,
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.erased === true) {
    return null;
  }
  for (const key of ["name", "display_name", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/** `did:key:z6Mk…AbCdEf`, short enough to sit beside a name. */
export function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 16)}…${did.slice(-6)}`;
}

/** What the page should say about a failed verification. */
export interface VerifyEmailFailure {
  /** One sentence the user can act on. */
  message: string;
  /** True when a fresh link is the useful next step (invalid, expired, gone). */
  expired: boolean;
  /** True when the visitor must sign in before anything else will work. */
  sessionExpired: boolean;
}

/**
 * Turn a verification failure into copy plus which recovery to offer.
 *
 * A `400`/`404` means the link itself cannot be redeemed (expired, forged,
 * already superseded, or the profile is gone), so the page offers a resend. A
 * `401` is a signed-out session; anything else is reported without pretending
 * the link has expired.
 */
export function describeVerifyEmailFailure(error: unknown): VerifyEmailFailure {
  if (error instanceof NetworkError) {
    return {
      message: "Can't reach Scholium. Check your connection and try again.",
      expired: false,
      sessionExpired: false,
    };
  }

  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        message: VERIFY_EMAIL_SESSION_EXPIRED_MESSAGE,
        expired: false,
        sessionExpired: true,
      };
    }
    if (error.status === 400 || error.status === 404) {
      return {
        message:
          error.detail && error.detail !== error.title
            ? error.detail
            : "The email verification link is invalid or has expired.",
        expired: true,
        sessionExpired: false,
      };
    }
    if (error.isRateLimited) {
      return {
        message: "Too many attempts. Wait a moment and try again.",
        expired: false,
        sessionExpired: false,
      };
    }
    if (error.isServerError) {
      return {
        message: "Scholium is having trouble right now. Please try again in a moment.",
        expired: false,
        sessionExpired: false,
      };
    }
    if (error.detail && error.detail !== error.title) {
      return { message: error.detail, expired: false, sessionExpired: false };
    }
  }

  return {
    message: "That didn't work. Please try again.",
    expired: false,
    sessionExpired: false,
  };
}
