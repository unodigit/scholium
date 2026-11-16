/**
 * The Scholium frontend API client.
 *
 * One place that knows how to talk to the API:
 *
 * - target `NEXT_PUBLIC_API_URL` (override with `baseUrl`),
 * - attach the bearer access token,
 * - refresh once on a 401 and replay the request,
 * - turn `application/problem+json` bodies into typed {@link ApiError}s.
 *
 * ```ts
 * import { api } from "@/lib/api";
 *
 * const paper = await api.get<Paper>("/papers/" + id);
 * const record = await api.post<Envelope>("/records", envelope);
 * ```
 *
 * Paths are relative to `/v1` by default; pass a path that already includes
 * `/v1` (it is not doubled), an absolute URL, or `{ prefix: false }`.
 */

import {
  ApiError,
  problemFromResponse,
  toProblemDetails,
  type ProblemDetails,
} from "./problem";
import {
  authorizationHeader,
  tokenStore as defaultTokenStore,
  tokensFromResponse,
  type AuthTokens,
  type TokenStore,
} from "./tokens";

/** Fallback API origin when `NEXT_PUBLIC_API_URL` is not set. */
export const DEFAULT_API_BASE_URL = "http://localhost:8000";

/** Path used to rotate an expired access token. */
export const DEFAULT_REFRESH_PATH = "/v1/auth/refresh";

/** Anything shaped like `fetch`. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Query parameter values accepted by the client. */
export type QueryValue = string | number | boolean | Date | null | undefined;

/** Query parameters appended to the request URL. */
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

/** How the successful response body should be decoded. */
export type ResponseParseMode = "auto" | "json" | "text" | "blob" | "arrayBuffer" | "response";

/** Per-request options. */
export interface ApiRequestOptions<TBody = unknown>
  extends Omit<RequestInit, "body" | "headers"> {
  /** Request body; plain objects are JSON-encoded automatically. */
  body?: TBody;
  /** Additional request headers (merged over the client defaults). */
  headers?: HeadersInit;
  /** Query parameters appended to the URL. */
  query?: QueryParams;
  /** Attach the access token. Defaults to `true`. */
  auth?: boolean;
  /** Refresh on 401 and replay once. Defaults to the client setting (`true`). */
  retryOnUnauthorized?: boolean;
  /** Prepend the client's API prefix (`/v1` by default). Defaults to `true`. */
  prefix?: boolean;
  /** Override the base URL for this request only. */
  baseUrl?: string;
  /** Force a response decoding mode. Defaults to content-type sniffing. */
  parse?: ResponseParseMode;
}

/** Constructor options for {@link ApiClient}. */
export interface ApiClientOptions {
  /** API origin; defaults to `NEXT_PUBLIC_API_URL` (or `http://localhost:8000`). */
  baseUrl?: string;
  /** Prefix for relative paths. Defaults to `/v1`; pass `""` to disable. */
  apiPrefix?: string;
  /** Fetch implementation, primarily for tests. */
  fetch?: FetchLike;
  /** Token store used for reads and refreshes. Defaults to the shared store. */
  tokenStore?: TokenStore;
  /** Refresh endpoint path (relative to the base URL). */
  refreshPath?: string;
  /** Headers sent with every request. */
  headers?: HeadersInit;
  /** Forwarded to `fetch`; omitted from the request when undefined. */
  credentials?: RequestCredentials;
  /** Refresh on 401 for requests that opted into auth. Defaults to `true`. */
  retryOnUnauthorized?: boolean;
  /** Called after a successful token refresh. */
  onTokensRefreshed?: (tokens: AuthTokens) => void;
  /** Called when a 401 cannot be recovered; tokens have been cleared by then. */
  onUnauthorized?: (error: ApiError) => void;
}

/** A transport-level failure (offline, DNS, abort) rather than an API response. */
export class NetworkError extends Error {
  /** The URL that could not be reached. */
  readonly url: string;

  constructor(url: string, options: { cause?: unknown } = {}) {
    super(`Network request to ${url} failed`, options);
    this.name = "NetworkError";
    this.url = url;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Resolve the API origin from an explicit value, the environment, or the default. */
export function resolveApiBaseUrl(explicit?: string): string {
  // `process.env.NEXT_PUBLIC_API_URL` is inlined by Next.js at build time; the
  // literal member access must stay static for that substitution to happen.
  const configured = explicit || process.env.NEXT_PUBLIC_API_URL || "";
  return (configured || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

/** Serialise query parameters into a `?...` suffix (empty string when none). */
export function buildQueryString(query?: QueryParams): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === null || raw === undefined) {
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }
      params.append(key, value instanceof Date ? value.toISOString() : String(value));
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function isAbsoluteUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

function joinUrl(baseUrl: string, path: string): string {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Append a serialised query to a URL that may already have one. */
function appendQuery(url: string, query?: QueryParams): string {
  const serialized = buildQueryString(query);
  if (!serialized) {
    return url;
  }
  return url.includes("?") ? `${url}&${serialized.slice(1)}` : `${url}${serialized}`;
}

function isBodyInit(body: unknown): body is BodyInit {
  if (typeof body === "string") {
    return true;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return true;
  }
  return false;
}

/** Encode a caller-supplied body and report whether it became JSON. */
function encodeBody(body: unknown): { body: BodyInit | null | undefined; isJson: boolean } {
  if (body === undefined) {
    return { body: undefined, isJson: false };
  }
  if (body === null) {
    return { body: null, isJson: false };
  }
  if (isBodyInit(body)) {
    return { body, isJson: false };
  }
  return { body: JSON.stringify(body), isJson: true };
}

async function readResponseBody(
  response: Response,
  mode: ResponseParseMode = "auto",
): Promise<unknown> {
  if (mode === "response") {
    return response;
  }
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }
  if (mode === "text") {
    return response.text();
  }
  if (mode === "blob") {
    return response.blob();
  }
  if (mode === "arrayBuffer") {
    return response.arrayBuffer();
  }

  const contentType = response.headers.get("content-type") ?? "";
  const looksJson = contentType.includes("json") || contentType.includes("problem+json");

  if (mode === "json" || (mode === "auto" && looksJson)) {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text);
  }

  const text = await response.text();
  if (mode === "auto") {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
  }
  return text;
}

/** Read a response body as JSON without throwing on an empty or invalid body. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A configured client for the Scholium API.
 *
 * The exported {@link apiClient} singleton is what most application code
 * should use; construct your own for tests or alternate origins.
 */
export class ApiClient {
  private readonly optionsBaseUrl?: string;
  private readonly apiPrefix: string;
  private readonly fetchImpl?: FetchLike;
  private readonly tokenStore: TokenStore;
  private readonly refreshPath: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly credentials?: RequestCredentials;
  private readonly retryOnUnauthorized: boolean;
  private readonly onTokensRefreshed?: (tokens: AuthTokens) => void;
  private readonly onUnauthorized?: (error: ApiError) => void;

  /** In-flight refresh, shared by concurrent 401s. */
  private refreshPromise: Promise<AuthTokens | null> | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.optionsBaseUrl = options.baseUrl;
    this.apiPrefix = normalizePrefix(options.apiPrefix ?? "/v1");
    this.fetchImpl = options.fetch;
    this.tokenStore = options.tokenStore ?? defaultTokenStore;
    this.refreshPath = options.refreshPath ?? DEFAULT_REFRESH_PATH;
    this.defaultHeaders = options.headers;
    this.credentials = options.credentials;
    this.retryOnUnauthorized = options.retryOnUnauthorized ?? true;
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.onUnauthorized = options.onUnauthorized;
  }

  /** The resolved API origin for this client. */
  get baseUrl(): string {
    return resolveApiBaseUrl(this.optionsBaseUrl);
  }

  /**
   * Send a request and decode its body.
   *
   * Non-2xx responses are thrown as {@link ApiError} (never returned); a 401
   * on an authenticated request triggers one token refresh (via the HttpOnly
   * refresh cookie) and, if that succeeds, a single replay.
   */
  async request<T = unknown>(
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const {
      body,
      headers: requestHeaders,
      query,
      auth = true,
      retryOnUnauthorized = this.retryOnUnauthorized,
      prefix = true,
      baseUrl,
      parse = "auto",
      method = "GET",
      ...init
    } = options;

    const base = resolveApiBaseUrl(baseUrl ?? this.optionsBaseUrl);
    const url = this.buildUrl(base, path, query, prefix);

    const { body: encodedBody, isJson } = encodeBody(body);
    const headers = new Headers(this.defaultHeaders);
    new Headers(requestHeaders).forEach((value, key) => headers.set(key, value));

    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json, application/problem+json");
    }
    if (isJson && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const tokens = this.tokenStore.get();
    const authorization = auth ? authorizationHeader(tokens) : undefined;
    if (authorization && !headers.has("Authorization")) {
      headers.set("Authorization", authorization);
    }

    const requestInit: RequestInit = {
      ...init,
      method,
      headers,
      body: encodedBody,
    };
    if (this.credentials && !requestInit.credentials) {
      requestInit.credentials = this.credentials;
    }

    const response = await this.send(url, requestInit);

    if (response.ok) {
      return (await readResponseBody(response, parse)) as T;
    }

    const problem = await problemFromResponse(response);
    const error = new ApiError(response.status, problem, { response, url });

    if (response.status === 401 && authorization && retryOnUnauthorized) {
      // The refresh token is an HttpOnly cookie this code cannot see, so there
      // is nothing to check first: ask the API, which answers 401/422 when the
      // browser holds no valid cookie.
      const refreshed = await this.refreshTokens();
      if (refreshed) {
        const retryHeaders = new Headers(headers);
        const retryAuthorization = authorizationHeader(refreshed);
        if (retryAuthorization) {
          retryHeaders.set("Authorization", retryAuthorization);
        }
        const retryResponse = await this.send(url, { ...requestInit, headers: retryHeaders });
        if (retryResponse.ok) {
          return (await readResponseBody(retryResponse, parse)) as T;
        }
        const retryProblem = await problemFromResponse(retryResponse);
        const retryError = new ApiError(retryResponse.status, retryProblem, {
          response: retryResponse,
          url,
        });
        if (retryResponse.status === 401) {
          // A fresh token was rejected too; the session is no longer usable.
          this.tokenStore.clear();
          this.notifyUnauthorized(retryError);
        }
        throw retryError;
      }
      this.notifyUnauthorized(error);
    }

    throw error;
  }

  /** GET request. */
  get<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  /** POST request; `body` is JSON-encoded unless it is already a `BodyInit`. */
  post<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  /** PUT request; `body` is JSON-encoded unless it is already a `BodyInit`. */
  put<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  /** PATCH request; `body` is JSON-encoded unless it is already a `BodyInit`. */
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  /** DELETE request. */
  delete<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  /** Alias for {@link delete}. */
  del<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.delete<T>(path, options);
  }

  /**
   * Exchange the HttpOnly refresh cookie for a new access token.
   *
   * Call this on page load to restore a session: the access token lives in
   * memory only, so a reload starts without one while the cookie survives.
   * Returns the new tokens, or `null` when the browser holds no valid refresh
   * cookie or the refresh was rejected (in which case the token store is
   * cleared).
   */
  refresh(): Promise<AuthTokens | null> {
    return this.refreshTokens();
  }

  private buildUrl(
    base: string,
    path: string,
    query: QueryParams | undefined,
    prefix: boolean,
  ): string {
    if (isAbsoluteUrl(path)) {
      return appendQuery(path, query);
    }
    let normalized = path.replace(/^\/+/, "");
    const prefixValue = this.apiPrefix.replace(/^\/+/, "");
    if (prefix && prefixValue) {
      if (normalized !== prefixValue && !normalized.startsWith(`${prefixValue}/`)) {
        normalized = `${prefixValue}/${normalized}`;
      }
    }
    return appendQuery(`${base}/${normalized}`, query);
  }

  private get fetcher(): FetchLike {
    const impl = this.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new Error("No fetch implementation is available in this environment");
    }
    return this.fetchImpl ?? impl.bind(globalThis);
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, init);
    } catch (cause) {
      // Preserve abort semantics so callers can detect cancelled requests.
      if (cause instanceof Error && cause.name === "AbortError") {
        throw cause;
      }
      throw new NetworkError(url, { cause });
    }
  }

  private refreshTokens(): Promise<AuthTokens | null> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<AuthTokens | null> {
    const url = joinUrl(
      resolveApiBaseUrl(this.optionsBaseUrl),
      this.refreshPath,
    );

    let response: Response;
    try {
      response = await this.send(url, {
        method: "POST",
        headers: {
          Accept: "application/json, application/problem+json",
        },
        // No body: the refresh token travels only in the HttpOnly cookie,
        // which the browser attaches to this one path.  `include` is what
        // lets it do so when the API is on another origin.
        credentials: "include",
      });
    } catch {
      // Transport failure: keep the tokens so a later attempt can succeed.
      return null;
    }

    if (!response.ok) {
      this.tokenStore.clear();
      return null;
    }

    const tokens = tokensFromResponse(await readJson(response));
    if (!tokens) {
      this.tokenStore.clear();
      return null;
    }

    // The rotated refresh token is already in the Set-Cookie header; the copy
    // in the body is deliberately not kept.
    const stored = this.tokenStore.set({
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
    });

    if (stored) {
      this.onTokensRefreshed?.(stored);
    }
    return stored;
  }

  private notifyUnauthorized(error: ApiError): void {
    try {
      this.onUnauthorized?.(error);
    } catch {
      // A listener must not mask the original API error.
    }
    try {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(
          new CustomEvent("scholium:unauthorized", { detail: error }),
        );
      }
    } catch {
      // CustomEvent may be unavailable in a minimal environment.
    }
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Create an API client. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return new ApiClient(options);
}

/** Application-wide API client, configured from `NEXT_PUBLIC_API_URL`. */
export const apiClient = new ApiClient();

/** Shorthand alias for {@link apiClient}. */
export const api = apiClient;

/** Send a request through the shared client. */
export function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.request<T>(path, options);
}

/** GET through the shared client. */
export function apiGet<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.get<T>(path, options);
}

/** POST through the shared client. */
export function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.post<T>(path, body, options);
}

/** PUT through the shared client. */
export function apiPut<T = unknown>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.put<T>(path, body, options);
}

/** PATCH through the shared client. */
export function apiPatch<T = unknown>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.patch<T>(path, body, options);
}

/** DELETE through the shared client. */
export function apiDelete<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiClient.delete<T>(path, options);
}

export type { ProblemDetails };
export { toProblemDetails };
