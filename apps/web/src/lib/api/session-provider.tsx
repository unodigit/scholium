"use client";

/**
 * The app-shell session gate.
 *
 * The access token lives in memory only, so a full page load starts signed
 * out until `POST /v1/auth/refresh` restores it from the HttpOnly cookie.
 * Mounting this once in the root layout makes that restore happen once, and
 * holds back pages that need a session until it has settled — otherwise a
 * reload of `/me` (or `/mod`, `/submit`, an ORCID return, …) would flash a
 * "Sign in to continue" notice before the refresh answer arrived.
 *
 * When the refresh answers that there is no session, a protected page is not
 * rendered at all: the browser is sent to `/signin?next=…` so the page's own
 * actions can never post unsigned and fail with a 401.  The same redirect
 * follows an unrecoverable 401 discovered mid-session (the client dispatches
 * `scholium:unauthorized`).
 *
 * Public pages render immediately: the bootstrap still runs (so the nav can
 * show the signed-in state), but nothing waits on it.
 *
 * The homepage (`/`) is the one page that does not restore the session. It is
 * a static, self-contained page that makes no API call and no request to
 * another origin (docs/design.md section 5.9), so loading it asks the API for
 * nothing. Its navigation bar shows the signed-in actions when a session is
 * already in memory (after signing in, or after a move from another page) or
 * when the non-secret signed-in hint says this browser held one (`useSignedIn`
 * reads it): the hint is set when a sign-in or refresh establishes a session
 * and cleared on sign-out or when a refresh is refused. On a browser that has
 * never held a session it shows the signed-out ones. The restore runs as soon
 * as the visitor moves to any other page.
 */

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { bootstrapSession, isProtectedPath, resetSessionBootstrap } from "./session";
import { browserTokenStorage, tokenStore } from "./tokens";
import type { TokenStorage } from "./tokens";

/**
 * Browser-storage key for the non-secret "this browser held a session" hint.
 *
 * The access token is memory-only, so a full page load starts signed out until
 * the refresh cookie restores it. The homepage deliberately makes no API call,
 * so it cannot run that restore; this marker is the one thing it reads to show
 * the signed-in actions. It is not a credential: it grants nothing and is
 * cleared whenever a refresh is refused or the user signs out.
 */
export const SIGNED_IN_HINT_STORAGE_KEY = "scholium.session.signed-in";

/** Fired on `window` whenever the hint is set or cleared. */
export const SIGNED_IN_HINT_EVENT = "scholium:signed-in-hint";

/** True when the browser remembers holding a session. */
export function hasSignedInHint(storage: TokenStorage = browserTokenStorage): boolean {
  try {
    return storage.getItem(SIGNED_IN_HINT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Record that a session was established (sign-in) or restored (refresh). */
export function rememberSignedInHint(storage: TokenStorage = browserTokenStorage): void {
  try {
    storage.setItem(SIGNED_IN_HINT_STORAGE_KEY, "1");
  } catch {
    // Storage can be blocked; the nav keeps the in-memory answer meanwhile.
  }
  announceSignedInHint();
}

/** Forget the hint after a sign-out or a refused refresh. */
export function forgetSignedInHint(storage: TokenStorage = browserTokenStorage): void {
  try {
    storage.removeItem(SIGNED_IN_HINT_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
  announceSignedInHint();
}

function announceSignedInHint(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SIGNED_IN_HINT_EVENT));
  }
}

/** What a protected page shows while the cookie is being exchanged. */
function RestoringSession() {
  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "60vh",
        padding: "24px",
        color: "var(--ink-2)",
        fontFamily: "var(--family-sans)",
        fontSize: "var(--type-ui)",
      }}
    >
      <p role="status">Restoring your session…</p>
    </main>
  );
}

/** The homepage: static, and it makes no API call, the session restore included. */
const HOMEPAGE_PATH = "/";

/** The current address, as a `?next=` target for sign-in. */
function currentTarget(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** Props for {@link SessionProvider}. */
export interface SessionProviderProps {
  children: ReactNode;
}

/** Restore the session on load and gate pages that need one. */
export function SessionProvider({ children }: SessionProviderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const protectedRoute = isProtectedPath(pathname);
  const onHomepage = pathname === HOMEPAGE_PATH;
  // False on the server and on the first client render, so the fallback
  // hydrates exactly as it was rendered.
  const [settled, setSettled] = useState(false);

  /**
   * Restore the session from the refresh cookie once.
   *
   * The bootstrap caches its answer for the life of the document, so a check
   * that runs before the session exists (the visitor landed on `/signin`, or
   * the browser restored an earlier document) would otherwise keep saying
   * "signed out". Callers that have reason to ask again call
   * {@link resetSessionBootstrap} first.
   */
  const restore = useCallback((): (() => void) => {
    let active = true;
    setSettled(false);
    // Runs on every page load, public or private.  `bootstrapSession` shares
    // one refresh between every caller in the document.
    void bootstrapSession()
      .then((tokens) => {
        // A restored session is worth remembering for pages that never ask
        // the API; a refused refresh means the hint is stale. A sign-in that
        // raced this refresh keeps its own answer.
        if (tokens || tokenStore.isAuthenticated) {
          rememberSignedInHint();
        } else {
          forgetSignedInHint();
        }
      })
      .finally(() => {
        if (active) {
          setSettled(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => (onHomepage ? undefined : restore()), [onHomepage, restore]);

  // Keep the non-secret hint in step with the in-memory session: a sign-in, a
  // refreshed token or an explicit sign-out anywhere in the app updates it.
  useEffect(
    () =>
      tokenStore.subscribe((tokens) => {
        if (tokens) {
          rememberSignedInHint();
        } else {
          forgetSignedInHint();
        }
      }),
    [],
  );

  // Leaving the site and coming back (the ORCID detour is the common one) can
  // restore this document from the back-forward cache, or bring a tab that was
  // in the background forward again, without mounting the provider anew.  If
  // the access token is no longer in memory, ask the refresh cookie again
  // instead of deciding the visitor is signed out.
  useEffect(() => {
    if (onHomepage) {
      return;
    }
    const recheck = (): void => {
      if (tokenStore.isAuthenticated) {
        return;
      }
      resetSessionBootstrap();
      restore();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        recheck();
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        recheck();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onHomepage, restore]);

  // A protected page without a session is not shown; sign-in brings the
  // visitor back to exactly this address.
  useEffect(() => {
    if (!protectedRoute || !settled || tokenStore.isAuthenticated) {
      return;
    }
    router.replace(`/signin?next=${encodeURIComponent(currentTarget())}`);
  }, [protectedRoute, router, settled]);

  // A session that dies while the page is open (a 401 the client could not
  // refresh) gets the same treatment as a missing one.
  useEffect(() => {
    const onUnauthorized = (): void => {
      if (isProtectedPath(window.location.pathname)) {
        router.replace(`/signin?next=${encodeURIComponent(currentTarget())}`);
      }
    };
    window.addEventListener("scholium:unauthorized", onUnauthorized);
    return () => {
      window.removeEventListener("scholium:unauthorized", onUnauthorized);
    };
  }, [router]);

  if (protectedRoute && (!settled || !tokenStore.isAuthenticated)) {
    return <RestoringSession />;
  }

  return <>{children}</>;
}

export default SessionProvider;
