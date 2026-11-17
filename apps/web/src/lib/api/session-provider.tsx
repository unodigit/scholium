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
 */

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { bootstrapSession, isProtectedPath, resetSessionBootstrap } from "./session";
import { tokenStore } from "./tokens";

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
    void bootstrapSession().finally(() => {
      if (active) {
        setSettled(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => restore(), [restore]);

  // Leaving the site and coming back (the ORCID detour is the common one) can
  // restore this document from the back-forward cache, or bring a tab that was
  // in the background forward again, without mounting the provider anew.  If
  // the access token is no longer in memory, ask the refresh cookie again
  // instead of deciding the visitor is signed out.
  useEffect(() => {
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
  }, [restore]);

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
