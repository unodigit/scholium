/**
 * Scholium frontend API client — public entry point.
 *
 * ```ts
 * import { api, ApiError, tokenStore } from "@/lib/api";
 *
 * tokenStore.set({ accessToken }); // memory only; the refresh token is an HttpOnly cookie
 *
 * try {
 *   const paper = await api.get<Paper>(`/papers/${id}`);
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     // error.status, error.detail, error.fieldErrors, error.problem
 *   }
 * }
 * ```
 *
 * Requests go to `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`) and
 * relative paths are prefixed with `/v1`.
 */

export {
  ApiClient,
  NetworkError,
  DEFAULT_API_BASE_URL,
  DEFAULT_REFRESH_PATH,
  api,
  apiClient,
  apiDelete,
  apiFetch,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  buildQueryString,
  createApiClient,
  resolveApiBaseUrl,
  toProblemDetails,
} from "./client";

export type {
  ApiClientOptions,
  ApiRequestOptions,
  FetchLike,
  QueryParams,
  QueryValue,
  ResponseParseMode,
} from "./client";

export {
  ApiError,
  PROBLEM_CONTENT_TYPE,
  apiErrorFrom,
  isProblemDetails,
  problemFromResponse,
  statusTitle,
} from "./problem";

export type {
  ApiErrorOptions,
  ProblemDetails,
  ProblemFieldError,
} from "./problem";

export {
  MemoryTokenStorage,
  TOKEN_STORAGE_KEY,
  TokenStore,
  authorizationHeader,
  browserTokenStorage,
  clearTokens,
  createTokenStore,
  getAccessToken,
  getTokens,
  isAuthenticated,
  isTokenExpired,
  purgeLegacyPersistedTokens,
  setAccessToken,
  setTokens,
  tokenStore,
  tokensFromResponse,
} from "./tokens";

export type {
  AuthTokens,
  AuthTokensInput,
  TokenListener,
  TokenStorage,
} from "./tokens";

export { apiClient as default } from "./client";
