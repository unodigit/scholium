/**
 * Restoring the session on page load.
 *
 * The access token is deliberately kept in memory only (see `tokens.ts`), so
 * a full page load — a reload, a typed URL, or any plain `<a href>` — starts
 * with an empty token store while the HttpOnly refresh cookie survives.  The
 * app therefore asks the API for a fresh access token exactly once on load,
 * before any protected page decides the visitor is signed out.
 *
 * ```ts
 * await bootstrapSession(); // shared: concurrent callers await one refresh
 * ```
 *
 * The in-flight request is shared by every caller, so a page with several
 * components that need the session still causes a single
 * `POST /v1/auth/refresh`.  The result (including "no session") is remembered
 * for the life of the document; call {@link resetSessionBootstrap} after an
 * explicit sign-in or sign-out if a later caller must check again.
 */

import { apiClient } from "./client";
import type { ApiClient } from "./client";
import { tokenStore as defaultTokenStore } from "./tokens";
import type { AuthTokens, TokenStore } from "./tokens";

/**
 * Path prefixes whose pages need a signed-in user.
 *
 * A page below one of these is not rendered until the session bootstrap has
 * settled, so it never paints a "Sign in to continue" notice for a visitor
 * whose refresh cookie is still valid.  Public reads (the feed, papers,
 * search, profiles) render immediately.
 */
export const PROTECTED_PATH_PREFIXES: readonly string[] = [
  "/me",
  "/mod",
  "/submit",
  "/consent",
  "/onboarding",
  "/review",
];

/** True when `pathname` is a page that requires a signed-in user. */
export function isProtectedPath(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }
  return PROTECTED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** What the bootstrap needs from the API client. */
export type SessionRefreshClient = Pick<ApiClient, "refresh">;

/** Options for {@link createSessionBootstrap}. */
export interface SessionBootstrapOptions {
  /** Client used for the refresh; defaults to the app-wide `apiClient`. */
  client?: SessionRefreshClient;
  /** Store checked first and populated by the refresh; defaults to the app-wide one. */
  tokenStore?: Pick<TokenStore, "get">;
}

/** A shared, once-per-load session bootstrap. */
export interface SessionBootstrap {
  /**
   * Restore the access token from the refresh cookie.
   *
   * Resolves with the current tokens (or `null` when the browser holds no
   * valid refresh cookie).  Concurrent callers share one in-flight refresh.
   */
  bootstrap(): Promise<AuthTokens | null>;
  /** Forget the remembered result, so the next call checks again. */
  reset(): void;
  /** True while a bootstrap refresh is in flight. */
  readonly pending: boolean;
}

/**
 * Create a bootstrap around a client and store (both default to the app-wide
 * singletons).  A factory exists so tests can isolate their own instance.
 */
export function createSessionBootstrap(
  options: SessionBootstrapOptions = {},
): SessionBootstrap {
  const store = options.tokenStore ?? defaultTokenStore;
  const client = options.client ?? apiClient;
  let inFlight: Promise<AuthTokens | null> | null = null;

  return {
    bootstrap(): Promise<AuthTokens | null> {
      // Already signed in (a client-side navigation, or a second caller):
      // there is nothing to restore.
      const current = store.get();
      if (current) {
        return Promise.resolve(current);
      }
      if (!inFlight) {
        // `refresh` already shares its own in-flight promise, and this keeps
        // the settled answer (including `null`) for the document's lifetime.
        inFlight = client.refresh().catch(() => null);
      }
      return inFlight;
    },
    reset(): void {
      inFlight = null;
    },
    get pending(): boolean {
      return inFlight !== null;
    },
  };
}

const shared = createSessionBootstrap();

/** Restore the session once per page load (shared by every caller). */
export const bootstrapSession: SessionBootstrap["bootstrap"] = shared.bootstrap;

/** Forget the bootstrapped result (after an explicit sign-in or sign-out). */
export const resetSessionBootstrap: SessionBootstrap["reset"] = shared.reset;
