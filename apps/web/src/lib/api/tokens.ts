/**
 * Auth token storage for the frontend API client.
 *
 * The API issues a 15-minute access token and a rotating refresh token.  The
 * refresh token is a 30-day bearer secret, so this client never stores or
 * reads it: the API sets it as an HttpOnly, SameSite=Strict cookie scoped to
 * the refresh endpoint, and the browser sends it by itself when the client
 * calls `POST /v1/auth/refresh` (see `ApiClient.refresh`).
 *
 * What lives here is therefore only the short-lived access token, and only in
 * memory: it is gone on reload (the client gets a new one from the cookie) and
 * is never written to `localStorage`/`sessionStorage`, where any injected
 * script could read it.  A `refreshToken` handed to {@link TokenStore.set} is
 * ignored rather than retained.
 *
 * This module deliberately stores tokens only — it performs no crypto and no
 * network I/O, so the API client can stay testable.
 */

/**
 * The `localStorage` key older builds persisted the token pair under.
 *
 * Nothing is written there any more; the key survives only so
 * {@link purgeLegacyPersistedTokens} can delete the long-lived refresh token
 * those builds left behind in users' browsers.
 */
export const TOKEN_STORAGE_KEY = "scholium.auth.tokens";

/** The tokens the API's auth endpoints return. */
export interface AuthTokens {
  /** Bearer token sent with authenticated requests. */
  accessToken: string;
  /**
   * The refresh token as parsed from an auth response body.
   *
   * Never stored: {@link TokenStore} drops it, and the refresh flow uses the
   * HttpOnly cookie instead.  Present on parsed responses only so callers can
   * see what the API returned.
   */
  refreshToken?: string;
  /** Authorization scheme; defaults to `Bearer`. */
  tokenType?: string;
  /** Access token expiry as an epoch timestamp in milliseconds. */
  expiresAt?: number;
}

/** Partial token patch accepted by {@link TokenStore.set} (`refreshToken` is ignored). */
export type AuthTokensInput = Partial<AuthTokens>;

/** The small subset of the Web Storage API the token store needs. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Called whenever the stored tokens change. */
export type TokenListener = (tokens: AuthTokens | null) => void;

/** A simple in-memory {@link TokenStorage}, safe on the server and in tests. */
export class MemoryTokenStorage implements TokenStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? (this.values.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/**
 * Storage that resolves `localStorage` lazily.
 *
 * Next.js evaluates modules on the server first, where `window` does not
 * exist; deferring the lookup means the same store works in both environments.
 *
 * This is persistent, script-readable storage for *non-secret* client state
 * (e.g. the new-account marker).  It must never hold credentials: the default
 * {@link tokenStore} deliberately does not use it.
 */
export const browserTokenStorage: TokenStorage = {
  getItem(key) {
    return getLocalStorage()?.getItem(key) ?? getServerMemoryStorage().getItem(key);
  },
  setItem(key, value) {
    const local = getLocalStorage();
    if (local) {
      local.setItem(key, value);
    } else {
      getServerMemoryStorage().setItem(key, value);
    }
  },
  removeItem(key) {
    const local = getLocalStorage();
    if (local) {
      local.removeItem(key);
    } else {
      getServerMemoryStorage().removeItem(key);
    }
  },
};

let serverMemoryStorage: MemoryTokenStorage | undefined;

function getServerMemoryStorage(): MemoryTokenStorage {
  if (!serverMemoryStorage) {
    serverMemoryStorage = new MemoryTokenStorage();
  }
  return serverMemoryStorage;
}

function getLocalStorage(): Storage | undefined {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access can throw in private-mode browsers or sandboxed iframes.
  }
  return undefined;
}

/**
 * Delete the token pair older builds persisted in `localStorage`.
 *
 * Those builds stored the refresh token there, readable by any injected
 * script.  Removing it on load means upgrading users do not keep a long-lived
 * secret in the very place this module stopped using.  A no-op on the server
 * and wherever storage is unavailable.
 */
export function purgeLegacyPersistedTokens(): void {
  try {
    getLocalStorage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be blocked; there is nothing further to do.
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Convert an auth endpoint response body into {@link AuthTokens}.
 *
 * Accepts the API's snake_case fields (`access_token`, `refresh_token`,
 * `token_type`, `expires_in`) and camelCase equivalents so slightly different
 * modules can share this helper.  Returns `null` when no access token is
 * present.
 */
export function tokensFromResponse(payload: unknown): AuthTokens | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const accessToken = readString(raw.access_token) ?? readString(raw.accessToken) ?? readString(raw.token);
  if (!accessToken) {
    return null;
  }

  const tokens: AuthTokens = {
    accessToken,
    tokenType: readString(raw.token_type) ?? readString(raw.tokenType) ?? "Bearer",
  };

  const refreshToken = readString(raw.refresh_token) ?? readString(raw.refreshToken);
  if (refreshToken) {
    tokens.refreshToken = refreshToken;
  }

  const expiresIn = readNumber(raw.expires_in) ?? readNumber(raw.expiresIn);
  if (expiresIn !== undefined) {
    tokens.expiresAt = Date.now() + expiresIn * 1000;
  } else {
    const expiresAt = readNumber(raw.expires_at) ?? readNumber(raw.expiresAt);
    if (expiresAt !== undefined) {
      // Epoch seconds and epoch milliseconds are both plausible.
      tokens.expiresAt = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
    }
  }

  return tokens;
}

/** True when the access token is expired (or within `leewayMs` of expiring). */
export function isTokenExpired(tokens: AuthTokens | null, leewayMs = 0): boolean {
  if (!tokens || tokens.expiresAt === undefined) {
    return false;
  }
  return tokens.expiresAt - leewayMs <= Date.now();
}

/** The authorization header value for a token pair. */
export function authorizationHeader(tokens: AuthTokens | null): string | undefined {
  if (!tokens?.accessToken) {
    return undefined;
  }
  return `${tokens.tokenType || "Bearer"} ${tokens.accessToken}`;
}

/**
 * Holds the current access token and notifies subscribers of changes.
 *
 * ```ts
 * tokenStore.set({ accessToken });
 * tokenStore.get()?.accessToken; // => accessToken
 * ```
 *
 * Each store keeps its tokens in memory unless given another storage; pass a
 * persistent one only in tests.  The refresh token is never kept (see the
 * module comment).
 */
export class TokenStore {
  private readonly storage: TokenStorage;
  private readonly listeners = new Set<TokenListener>();

  constructor(storage: TokenStorage = new MemoryTokenStorage()) {
    this.storage = storage;
  }

  /** The current tokens, or `null` when signed out. */
  get(): AuthTokens | null {
    const serialized = this.storage.getItem(TOKEN_STORAGE_KEY);
    if (!serialized) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const raw = parsed as Record<string, unknown>;
      const accessToken = readString(raw.accessToken);
      if (!accessToken) {
        return null;
      }
      const tokens: AuthTokens = { accessToken };
      const tokenType = readString(raw.tokenType);
      if (tokenType) {
        tokens.tokenType = tokenType;
      }
      const expiresAt = readNumber(raw.expiresAt);
      if (expiresAt !== undefined) {
        tokens.expiresAt = expiresAt;
      }
      return tokens;
    } catch {
      return null;
    }
  }

  /**
   * Merge a patch into the stored tokens and keep the result.
   *
   * Passing an empty access token (or `null`/`undefined` to {@link clear})
   * removes the tokens.  Unspecified fields keep their current value.  A
   * `refreshToken` in the patch is deliberately dropped: the refresh token
   * lives only in the HttpOnly cookie.
   */
  set(patch: AuthTokensInput | null | undefined): AuthTokens | null {
    if (!patch) {
      this.clear();
      return null;
    }

    const current = this.get();
    const accessToken = readString(patch.accessToken) ?? current?.accessToken;
    if (!accessToken) {
      this.clear();
      return null;
    }

    const tokens: AuthTokens = { accessToken };
    const tokenType = readString(patch.tokenType) ?? current?.tokenType;
    if (tokenType) {
      tokens.tokenType = tokenType;
    }
    const expiresAt = readNumber(patch.expiresAt) ?? current?.expiresAt;
    if (expiresAt !== undefined) {
      tokens.expiresAt = expiresAt;
    }

    this.storage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    this.emit(tokens);
    return tokens;
  }

  /** Remove all stored tokens. */
  clear(): void {
    this.storage.removeItem(TOKEN_STORAGE_KEY);
    this.emit(null);
  }

  /** The current access token, or `undefined`. */
  get accessToken(): string | undefined {
    return this.get()?.accessToken;
  }

  /** True when an access token is present. */
  get isAuthenticated(): boolean {
    return this.get() !== null;
  }

  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: TokenListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(tokens: AuthTokens | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(tokens);
      } catch {
        // A broken listener must not break token persistence.
      }
    }
  }
}

/** Create a token store backed by `storage` (defaults to a fresh in-memory store). */
export function createTokenStore(storage?: TokenStorage): TokenStore {
  return new TokenStore(storage);
}

/** Application-wide token store used by the default API client (in memory only). */
export const tokenStore = createTokenStore();

// Upgrading users still have the old build's token pair in localStorage.
purgeLegacyPersistedTokens();

/** Read the current tokens from the default store. */
export function getTokens(): AuthTokens | null {
  return tokenStore.get();
}

/** Merge tokens into the default store (a `refreshToken` is ignored). */
export function setTokens(tokens: AuthTokensInput | null | undefined): AuthTokens | null {
  return tokenStore.set(tokens);
}

/** Convenience helper for setting just the access token. */
export function setAccessToken(accessToken: string): AuthTokens | null {
  return tokenStore.set({ accessToken });
}

/** Remove tokens from the default store. */
export function clearTokens(): void {
  tokenStore.clear();
}

/** Read the default store's access token. */
export function getAccessToken(): string | undefined {
  return tokenStore.accessToken;
}

/** True when the default store holds an access token. */
export function isAuthenticated(): boolean {
  return tokenStore.isAuthenticated;
}
