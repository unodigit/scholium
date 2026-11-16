/**
 * Sign-in with the device key.
 *
 * Sign-in is challenge-response against the Scholium API:
 *
 * ```text
 * did   = device key's did:key
 * POST /v1/auth/challenge {did}                    -> {nonce, did, expires_at}
 * sig   = Ed25519(device key, UTF-8 bytes of nonce)   (behind a passkey prompt)
 * POST /v1/auth/verify    {did, nonce, signature}  -> {access_token, expires_in}
 * ```
 *
 * The refresh token is not in that body: the API delivers it as an HttpOnly,
 * SameSite cookie (`Set-Cookie: scholium_refresh=…`), which the browser keeps
 * because the API client sends every auth call with `credentials: "include"`.
 * The access token it does return is kept in memory only (see `lib/api`).
 *
 * `signature` is unpadded base64url, the same encoding record signatures use.
 *
 * ## New accounts
 *
 * The API creates the account on the first successful verify and does not say
 * whether it did (the challenge endpoint deliberately never reveals whether a
 * did has an account). The browser can tell on its own: a did is derived from
 * the device key, so **a device key created by this sign-in is always a new
 * account**. In that case the key and its passkey are created first, and the
 * result sends the user to `/onboarding`.
 *
 * The key is persisted before the network calls, so a sign-in that fails
 * after the key exists would otherwise look like a returning user on retry.
 * A small marker in browser storage bridges that gap: it is written when the
 * key is created and consumed by the first sign-in that completes.
 */

import { apiClient, browserTokenStorage, tokenStore, tokensFromResponse } from "../../lib/api";
import type { ApiClient, AuthTokens, TokenStorage, TokenStore } from "../../lib/api";

import { deviceKey, type DeviceKeyManager } from "./device-key";
import { toBase64Url, utf8Encode } from "./encoding";

/** Where the sign-in page lives. */
export const SIGNIN_PATH = "/signin";

/** Where a brand-new account goes after its first sign-in. */
export const ONBOARDING_PATH = "/onboarding";

/** Where a returning user goes when no (valid) `next` target was given. */
export const DEFAULT_SIGNIN_REDIRECT = "/";

/** Browser-storage key for the "device key created, first sign-in pending" marker. */
export const NEW_ACCOUNT_STORAGE_KEY = "scholium.web-auth.new-account";

/** Account name the browser shows in its passkey picker on first sign-in. */
export const DEFAULT_PASSKEY_USER_NAME = "Scholium account";

/** Display name the browser shows in its passkey picker on first sign-in. */
export const DEFAULT_PASSKEY_DISPLAY_NAME = "Scholium";

/** Response of `POST /v1/auth/challenge`. */
export interface ChallengeResponse {
  /** Single-use value to sign (256 random bits, URL-safe). */
  nonce: string;
  /** The did the challenge was issued to. */
  did: string;
  /** UTC instant after which the nonce is refused. */
  expires_at?: string;
}

/** Where a sign-in is, for UI copy. Stages are reported in order. */
export type SignInStage =
  /** First run: creating the device key and registering its passkey. */
  | "creating-passkey"
  /** Asking the API for a nonce. */
  | "requesting-challenge"
  /** Waiting for the passkey prompt that authorises the signature. */
  | "waiting-for-passkey"
  /** Sending the signed nonce to the API. */
  | "verifying";

/**
 * Stable failure codes for {@link SignInError}.
 *
 * `invalid-response`: the API answered, but not with the shape the sign-in
 * contract promises.
 */
export type SignInErrorCode = "invalid-response";

/**
 * The API answered a sign-in request with something unusable.
 *
 * Device and passkey failures stay {@link DeviceKeyError}s, and API failures
 * stay `ApiError` / `NetworkError`; this covers a *successful* response whose
 * body is not a challenge or token pair.
 */
export class SignInError extends Error {
  /** Stable code callers can branch on. */
  readonly code: SignInErrorCode;

  constructor(code: SignInErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "SignInError";
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Type guard for {@link SignInError}. */
export function isSignInError(error: unknown): error is SignInError {
  return error instanceof SignInError;
}

/** The slice of {@link DeviceKeyManager} that sign-in uses. */
export type SignInDeviceKey = Pick<
  DeviceKeyManager,
  "load" | "create" | "didKey" | "sign" | "signWithPasskey" | "isSupported"
>;

/** The slice of {@link ApiClient} that sign-in uses. */
export type SignInClient = Pick<ApiClient, "post">;

/** Options for {@link signIn}. Every dependency defaults to the app-wide one. */
export interface SignInOptions {
  /** Where to send a returning user (a same-site path); sanitised. */
  next?: string | null;
  /** Device key manager; defaults to the app-wide `deviceKey`. */
  deviceKey?: SignInDeviceKey;
  /** API client; defaults to the app-wide `apiClient`. */
  client?: SignInClient;
  /** Where the issued tokens are kept; defaults to the app-wide `tokenStore`. */
  tokenStore?: Pick<TokenStore, "set">;
  /** Where the new-account marker lives; defaults to browser `localStorage`. */
  storage?: TokenStorage;
  /** Passkey account name for first-run registration. */
  userName?: string;
  /** Passkey display name for first-run registration. */
  userDisplayName?: string;
  /** Called as each stage starts. A throwing listener never breaks sign-in. */
  onProgress?: (stage: SignInStage) => void;
}

/** What a completed sign-in produced. */
export interface SignInResult {
  /** The signed-in account's did:key. */
  did: string;
  /** True when this is the account's first sign-in. */
  isNewAccount: boolean;
  /** Where the UI should navigate next. */
  redirectTo: string;
  /** The issued token pair (already saved to the token store). */
  tokens: AuthTokens;
}

/**
 * Reduce a `next` target to a safe same-site path, or `null`.
 *
 * Only a path on this origin survives: protocol-relative (`//host`), absolute
 * (`https://…`), backslash and control-character tricks are all refused, and
 * so is the sign-in page itself (which would loop).
 */
export function safeRedirectPath(next: string | null | undefined): string | null {
  if (typeof next !== "string" || next === "") {
    return null;
  }
  // Browsers treat `\` like `/` in URLs, so `/\evil.example` is protocol-relative.
  // eslint-disable-next-line no-control-regex
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(next, "http://scholium.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://scholium.invalid") {
    return null;
  }
  if (parsed.pathname === SIGNIN_PATH || parsed.pathname.startsWith(`${SIGNIN_PATH}/`)) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Where a sign-in should land. */
export function signInDestination(isNewAccount: boolean, next?: string | null): string {
  if (isNewAccount) {
    return ONBOARDING_PATH;
  }
  return safeRedirectPath(next) ?? DEFAULT_SIGNIN_REDIRECT;
}

/** True when this browser holds a device key whose first sign-in has not completed. */
export function hasPendingNewAccount(storage: TokenStorage = browserTokenStorage): boolean {
  try {
    return storage.getItem(NEW_ACCOUNT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function markPendingNewAccount(storage: TokenStorage): void {
  try {
    storage.setItem(NEW_ACCOUNT_STORAGE_KEY, "1");
  } catch {
    // Storage can be blocked; the only cost is a retry skipping onboarding.
  }
}

function clearPendingNewAccount(storage: TokenStorage): void {
  try {
    storage.removeItem(NEW_ACCOUNT_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate a challenge response and make sure it is for `did`. */
export function parseChallenge(payload: unknown, did: string): ChallengeResponse {
  if (!isRecord(payload) || typeof payload.nonce !== "string" || payload.nonce === "") {
    throw new SignInError("invalid-response", "The server did not return a sign-in challenge");
  }
  if (payload.did !== undefined && payload.did !== did) {
    throw new SignInError(
      "invalid-response",
      "The server issued a sign-in challenge for a different account",
    );
  }
  return {
    nonce: payload.nonce,
    did,
    ...(typeof payload.expires_at === "string" ? { expires_at: payload.expires_at } : {}),
  };
}

/** Validate a verify response and turn it into a token pair. */
function parseTokens(payload: unknown): AuthTokens {
  // The body carries the access token and its lifetime; the refresh token
  // travels only in the Set-Cookie header, so its absence here is normal.
  const tokens = tokensFromResponse(payload);
  if (!tokens) {
    throw new SignInError("invalid-response", "The server did not return sign-in tokens");
  }
  return tokens;
}

/**
 * Sign in with the device key.
 *
 * Creates the device key (and its passkey) first when this browser has none,
 * asks the API for a nonce for the key's did, signs the nonce's UTF-8 bytes,
 * posts the signature, saves the tokens and says where to go next.
 *
 * Nothing is sent to the API until the key exists, and a dismissed passkey
 * prompt (`DeviceKeyError`, code `passkey-cancelled`) stops the flow before
 * any signature leaves the device. Failures are not caught here: callers get
 * `DeviceKeyError`, `ApiError`, `NetworkError` or {@link SignInError} and
 * can turn them into copy with `describeSignInError`.
 */
export async function signIn(options: SignInOptions = {}): Promise<SignInResult> {
  const key = options.deviceKey ?? deviceKey;
  const client = options.client ?? apiClient;
  const tokens = options.tokenStore ?? tokenStore;
  const storage = options.storage ?? browserTokenStorage;
  const progress = (stage: SignInStage): void => {
    try {
      options.onProgress?.(stage);
    } catch {
      // A UI listener must not abort a sign-in.
    }
  };

  // First run on this device: the new key *is* the new account.
  let created = false;
  if (!(await key.load())) {
    progress("creating-passkey");
    await key.create({
      userName: options.userName ?? DEFAULT_PASSKEY_USER_NAME,
      userDisplayName: options.userDisplayName ?? DEFAULT_PASSKEY_DISPLAY_NAME,
    });
    created = true;
    markPendingNewAccount(storage);
  }

  const did = await key.didKey();

  progress("requesting-challenge");
  const challenge = parseChallenge(
    await client.post<unknown>("/auth/challenge", { did }, { auth: false }),
    did,
  );

  // Fresh registration already proved the user is present; every later
  // sign-in asks for the passkey.
  const message = utf8Encode(challenge.nonce);
  let signature: Uint8Array;
  if (created) {
    signature = await key.sign(message);
  } else {
    progress("waiting-for-passkey");
    signature = await key.signWithPasskey(message);
  }

  progress("verifying");
  const issued = parseTokens(
    await client.post<unknown>(
      "/auth/verify",
      { did, nonce: challenge.nonce, signature: toBase64Url(signature) },
      { auth: false },
    ),
  );
  tokens.set(issued);

  const isNewAccount = created || hasPendingNewAccount(storage);
  clearPendingNewAccount(storage);

  return {
    did,
    isNewAccount,
    redirectTo: signInDestination(isNewAccount, options.next),
    tokens: issued,
  };
}
