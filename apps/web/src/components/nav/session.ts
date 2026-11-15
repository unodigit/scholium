"use client";

/**
 * Sign-in state for chrome that lives outside the web-auth feature.
 *
 * The nav is mounted on every page, signed in or not, so it derives its state
 * from the shared token store (`src/lib/api`) instead of reaching into
 * IndexedDB device keys. Consumers that already know the state can pin it.
 */

import { useEffect, useState } from "react";

import { tokenStore } from "../../lib/api";

/**
 * True when the shared token store holds an access token.
 *
 * `override` wins whenever it is provided (`true`, `false` or `undefined` —
 * only `undefined` falls through to detection), so shells and tests can pin
 * the state deterministically.
 *
 * Detection runs after mount: the first render matches the server's
 * signed-out HTML, then the store's answer is applied — no hydration
 * mismatch, and a sign-in or sign-out anywhere in the app updates the nav
 * live through the store's listeners.
 */
export function useSignedIn(override?: boolean): boolean {
  const [storeSignedIn, setStoreSignedIn] = useState(false);

  useEffect(() => {
    if (override !== undefined) {
      return;
    }
    const update = (): void => setStoreSignedIn(tokenStore.isAuthenticated);
    update();
    return tokenStore.subscribe(() => update());
  }, [override]);

  return override ?? storeSignedIn;
}
