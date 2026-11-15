/**
 * Auth token storage for the frontend API client.
 *
 * The API issues a 15-minute access token plus a rotating refresh token
 * (see the auth features).  The client keeps both here, persists them in
 * `localStorage` in the browser, and falls back to an in-memory store during
 * server rendering and in tests.
 *
 * This module deliberately stores tokens only — it performs no crypto and no
 * network I/O, so the API client can stay testable.
 */

/** Storage key used for the persisted token pair. */
export const TOKEN_STORAGE_KEY = "scholium.auth.tokens";

/** The token pair returned by the API's auth endpoints. */
export interface AuthTokens {
  /** Bearer token sent with authenticated requests. */
  accessToken: string;
  /** Rotating refresh token used to obtain a new access token. */
  refreshToken?: string;
  /** Authorization scheme; defaults to `Bearer`. */
  tokenType?: string;
  /** Access token expiry as an epoch timestamp in milliseconds. */
  expiresAt?: number;
}

/** Partial token patch accepted by {@link TokenStore.set}. */
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
 * Holds the current token pair and notifies subscribers of changes.
 *
 * ```ts
 * tokenStore.set({ accessToken, refreshToken });
 * tokenStore.get()?.refreshToken; // => refreshToken
 * ```
 */
export class TokenStore {
  private readonly storage: TokenStorage;
  private readonly listeners = new Set<TokenListener>();

  constructor(storage: TokenStorage = browserTokenStorage) {
    this.storage = storage;
  }

  /** The current token pair, or `null` when signed out. */
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
      const refreshToken = readString(raw.refreshToken);
      if (refreshToken) {
        tokens.refreshToken = refreshToken;
      }
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
   * Merge a patch into the stored tokens and persist the result.
   *
   * Passing an empty access token (or `null`/`undefined` to {@link clear})
   * removes the token pair.  Unspecified fields keep their current value, so
   * a refresh response that only carries `access_token` preserves the
   * existing refresh token.
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
    const refreshToken = readString(patch.refreshToken) ?? current?.refreshToken;
    if (refreshToken) {
      tokens.refreshToken = refreshToken;
    }
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

  /** The current refresh token, or `undefined`. */
  get refreshToken(): string | undefined {
    return this.get()?.refreshToken;
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

/** Create a token store backed by `storage` (defaults to browser storage). */
export function createTokenStore(storage?: TokenStorage): TokenStore {
  return new TokenStore(storage);
}

/** Application-wide token store used by the default API client. */
export const tokenStore = createTokenStore();

/** Read the current token pair from the default store. */
export function getTokens(): AuthTokens | null {
  return tokenStore.get();
}

/** Merge tokens into the default store. */
export function setTokens(tokens: AuthTokensInput | null | undefined): AuthTokens | null {
  return tokenStore.set(tokens);
}

/** Convenience helper for setting just the access token. */
export function setAccessToken(accessToken: string, refreshToken?: string): AuthTokens | null {
  return tokenStore.set({ accessToken, ...(refreshToken ? { refreshToken } : {}) });
}

/** Remove tokens from the default store. */
export function clearTokens(): void {
  tokenStore.clear();
}

/** Read the default store's access token. */
export function getAccessToken(): string | undefined {
  return tokenStore.accessToken;
}

/** Read the default store's refresh token. */
export function getRefreshToken(): string | undefined {
  return tokenStore.refreshToken;
}

/** True when the default store holds an access token. */
export function isAuthenticated(): boolean {
  return tokenStore.isAuthenticated;
}
