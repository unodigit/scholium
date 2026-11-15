/**
 * RFC 9457 (formerly RFC 7807) problem details.
 *
 * The Scholium API answers every error with `application/problem+json`, so the
 * client turns those bodies into a typed {@link ApiError} instead of leaking a
 * bare `Response` into UI code.  See feature 131 and the API kernel (feature 2).
 */

/** Media type the API uses for error responses. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * One field-level error entry.  The API kernel emits these inside `errors` on
 * a 422 validation failure.  FastAPI's own casing (`msg`, `loc`) is accepted too
 * so the parser works against partially-built modules.
 */
export interface ProblemFieldError {
  /** Dotted field path, e.g. `body.title`. */
  field?: string;
  /** JSON pointer or dotted path when the server exposes one. */
  path?: string;
  /** FastAPI/Pydantic location array, e.g. `["body", "title"]`. */
  loc?: Array<string | number>;
  /** Human-readable message (`message` preferred, `msg` is the Pydantic spelling). */
  message?: string;
  /** Pydantic spelling of {@link message}. */
  msg?: string;
  /** Machine-readable error code, when supplied. */
  code?: string;
  /** Allow extra extension members. */
  [key: string]: unknown;
}

/**
 * An RFC 9457 problem details object.
 *
 * `type`, `title`, `status`, `detail` and `instance` are the registered
 * members; everything else is an extension (the API uses `errors` for field
 * errors and may add more).
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. Defaults to `about:blank`. */
  type?: string;
  /** Short, human-readable summary of the problem type. */
  title?: string;
  /** HTTP status code generated for this occurrence. */
  status?: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying this specific occurrence. */
  instance?: string;
  /** Field-level validation errors (`422` responses). */
  errors?: ProblemFieldError[];
  /** Extension members defined by the API. */
  [extension: string]: unknown;
}

/** Options accepted by {@link ApiError}. */
export interface ApiErrorOptions {
  /** The response that produced the error, when available. */
  response?: Response;
  /** URL that was requested. */
  url?: string;
  /** Underlying failure (e.g. a JSON parse error), if any. */
  cause?: unknown;
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  418: "I'm a Teapot",
  422: "Unprocessable Content",
  425: "Too Early",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** Return the canonical reason phrase for an HTTP status code. */
export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? "Server Error" : "Request Failed");
}

/** True when `value` looks like a problem details object. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" ||
    typeof candidate.title === "string" ||
    typeof candidate.detail === "string" ||
    typeof candidate.status === "number"
  );
}

function asNumber(value: unknown): number | undefined {
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

function normalizeFieldError(value: unknown): ProblemFieldError | null {
  if (typeof value === "string") {
    return { message: value };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const error: ProblemFieldError = { ...raw };
  const location = raw.loc;
  if (Array.isArray(location)) {
    error.loc = location as Array<string | number>;
    if (!error.field) {
      error.field = location
        .filter((part) => typeof part === "string" || typeof part === "number")
        .join(".");
    }
  }
  if (typeof raw.message !== "string" && typeof raw.msg === "string") {
    error.message = raw.msg;
  }
  if (!error.field && typeof raw.path === "string") {
    error.field = raw.path;
  }
  return error;
}

function normalizeFieldErrors(value: unknown): ProblemFieldError[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const errors: ProblemFieldError[] = [];
  for (const entry of value) {
    const normalized = normalizeFieldError(entry);
    if (normalized) {
      errors.push(normalized);
    }
  }
  return errors;
}

/**
 * Normalise an arbitrary error body into a {@link ProblemDetails} object.
 *
 * Handles a real problem body, a plain JSON error (`{"message": ...}`), a raw
 * text body, and a body-less response.  Never throws.
 */
export function toProblemDetails(
  body: unknown,
  status: number,
  instance?: string,
): ProblemDetails {
  let problem: ProblemDetails;

  if (typeof body === "string") {
    const detail = body.trim();
    problem = {
      type: "about:blank",
      title: statusTitle(status),
      status,
      ...(detail ? { detail } : {}),
    };
  } else if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>;
    problem = { ...raw } as ProblemDetails;

    const problemStatus = asNumber(raw.status);
    problem.status = problemStatus ?? status;
    problem.type = typeof raw.type === "string" && raw.type ? raw.type : "about:blank";
    problem.title = typeof raw.title === "string" && raw.title ? raw.title : statusTitle(problem.status);

    if (typeof raw.detail !== "string") {
      if (typeof raw.message === "string") {
        problem.detail = raw.message;
      } else {
        delete problem.detail;
      }
    }

    const errors = normalizeFieldErrors(raw.errors) ?? normalizeFieldErrors(raw.violations);
    if (errors && errors.length > 0) {
      problem.errors = errors;
    } else {
      delete problem.errors;
    }
  } else {
    problem = {
      type: "about:blank",
      title: statusTitle(status),
      status,
    };
  }

  if (!problem.instance && instance) {
    problem.instance = instance;
  }

  return problem;
}

/** Read a response body and convert it to problem details. Never throws. */
export async function problemFromResponse(response: Response): Promise<ProblemDetails> {
  let body: unknown;
  try {
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  } catch {
    // A body that cannot be read still yields a usable error.
    return toProblemDetails(undefined, response.status, response.url || undefined);
  }
  return toProblemDetails(body, response.status, response.url || undefined);
}

/**
 * A typed API failure carrying the RFC 9457 problem details returned by the
 * Scholium API.
 *
 * ```ts
 * try {
 *   await api.post("/records", envelope);
 * } catch (error) {
 *   if (error instanceof ApiError && error.isConflict) {
 *     showProblem(error.detail, error.fieldErrors);
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** The HTTP status code of the failing response. */
  readonly status: number;
  /** The full RFC 9457 problem details object. */
  readonly problem: ProblemDetails;
  /** Problem type URI (`about:blank` when the server did not supply one). */
  readonly type: string;
  /** Short summary of the problem. */
  readonly title: string;
  /** Occurrence-specific explanation, when supplied. */
  readonly detail: string;
  /** URI reference for this occurrence, when supplied. */
  readonly instance?: string;
  /** Field-level validation errors (empty unless the API sent them). */
  readonly fieldErrors: ProblemFieldError[];
  /** The response that produced this error, when available. */
  readonly response?: Response;
  /** The requested URL, when available. */
  readonly url?: string;
  /** Parsed `Retry-After` header value in seconds, when numeric. */
  readonly retryAfter?: number;

  constructor(status: number, problem: ProblemDetails, options: ApiErrorOptions = {}) {
    const normalizedStatus = problem.status ?? status;
    const detail = problem.detail ?? problem.title ?? statusTitle(normalizedStatus);
    super(detail);
    this.name = "ApiError";
    this.status = normalizedStatus;
    this.problem = problem;
    this.type = problem.type ?? "about:blank";
    this.title = problem.title ?? statusTitle(normalizedStatus);
    this.detail = detail;
    this.instance = problem.instance;
    this.fieldErrors = problem.errors ?? [];
    this.response = options.response;
    this.url = options.url ?? options.response?.url;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    const retryAfter = options.response?.headers?.get?.("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        this.retryAfter = seconds;
      }
    }
  }

  /** Alias for {@link fieldErrors} matching the problem member name. */
  get errors(): ProblemFieldError[] {
    return this.fieldErrors;
  }

  /** True for 4xx responses. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** True for 5xx responses. */
  get isServerError(): boolean {
    return this.status >= 500;
  }

  get isBadRequest(): boolean {
    return this.status === 400;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isValidationError(): boolean {
    return this.status === 422;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Build an {@link ApiError} from a `Response`, consuming its body. */
  static async fromResponse(response: Response, url?: string): Promise<ApiError> {
    const problem = await problemFromResponse(response);
    return new ApiError(response.status, problem, { response, url });
  }
}

/** Build an {@link ApiError} from a status and an already-parsed body. */
export function apiErrorFrom(
  status: number,
  body?: unknown,
  options: ApiErrorOptions = {},
): ApiError {
  return new ApiError(status, toProblemDetails(body, status, options.url), options);
}
