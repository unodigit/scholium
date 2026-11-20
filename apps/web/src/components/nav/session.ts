"use client";

/**
 * Sign-in state for chrome that lives outside the web-auth feature.
 *
 * The nav is mounted on every page, signed in or not, so it derives its state
 * from the shared token store (`src/lib/api`) instead of reaching into
 * IndexedDB device keys. Consumers that already know the state can pin it.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, resetSessionBootstrap, tokenStore } from "../../lib/api";
import {
  forgetSignedInHint,
  hasSignedInHint,
  SIGNED_IN_HINT_EVENT,
} from "../../lib/api/session-provider";

/**
 * True when the session is known to the browser.
 *
 * `override` wins whenever it is provided (`true`, `false` or `undefined` —
 * only `undefined` falls through to detection), so shells and tests can pin
 * the state deterministically.
 *
 * Detection runs after mount: the first render matches the server's
 * signed-out HTML, then the store's answer is applied — no hydration
 * mismatch, and a sign-in or sign-out anywhere in the app updates the nav
 * live through the store's listeners. When the in-memory store is empty (a
 * full page load with no refresh yet), the signed-in hint is consulted so a
 * page that makes no API call (the homepage) still shows the right actions.
 */
export function useSignedIn(override?: boolean): boolean {
  const [storeSignedIn, setStoreSignedIn] = useState(false);

  useEffect(() => {
    if (override !== undefined) {
      return;
    }
    const update = (): void =>
      setStoreSignedIn(tokenStore.isAuthenticated || hasSignedInHint());
    update();
    const unsubscribe = tokenStore.subscribe(() => update());
    window.addEventListener(SIGNED_IN_HINT_EVENT, update);
    return () => {
      unsubscribe();
      window.removeEventListener(SIGNED_IN_HINT_EVENT, update);
    };
  }, [override]);

  return override ?? storeSignedIn;
}

/** What {@link useSignOut} exposes to the nav. */
export interface SignOutState {
  /** A sign-out is in flight (the button is disabled meanwhile). */
  signingOut: boolean;
  /** Revoke the session, clear the in-memory token and go home. */
  signOut(): Promise<void>;
}

/**
 * Sign out from the global nav.
 *
 * `POST /v1/auth/logout` retires the refresh token and clears its HttpOnly
 * cookie; the access token is cleared from memory by the client even if the
 * call fails.  The signed-in hint goes with it, and navigation is client-side
 * to the public homepage, scrolled to the top: the homepage is where a
 * signed-out visitor belongs, and a soft navigation would otherwise keep the
 * previous page's scroll offset.
 */
export function useSignOut(): SignOutState {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const inFlight = useRef(false);

  const signOut = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      // A document that signs out and later checks again must not reuse the
      // "signed in" answer this page load bootstrapped.
      resetSessionBootstrap();
      forgetSignedInHint();
      router.replace("/");
      // The homepage is long; land at its top instead of at the offset the
      // page we are leaving happened to have.  Scroll only after the
      // navigation has been requested, and bypass the homepage's
      // `scroll-behavior: smooth` so the move is instant rather than a
      // 700 ms glide to "Why Scholium".
      window.scrollTo(0, 0);
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }, [router]);

  return { signingOut, signOut };
}
