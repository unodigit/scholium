/**
 * One resumable upload of one file to the API's tus endpoint (`POST /v1/uploads`),
 * built on tus-js-client.
 *
 * What this adds to the library:
 *
 * - **Resume across visits.** tus-js-client remembers each upload's URL in
 *   `localStorage`, keyed by the file's name, type, size and modified time. When
 *   the author adds the same file again — after a crash, a closed tab or a
 *   dropped connection — we look that URL up and continue from the offset the
 *   server reports instead of starting over.
 * - **Retries with a visible state.** Network failures and 5xx/409/423 answers
 *   are retried with back-off; each retry is reported so the row can say
 *   "Reconnecting…". A 4xx answer stops the upload with the server's reason.
 * - **The content ID.** The API answers the final `PATCH` with `Upload-Cid`.
 *   If that response was lost (the server finished the file, the client never
 *   heard) tus-js-client resumes, sees the upload is complete and has no CID to
 *   hand over. The API's documented recovery is an empty `PATCH` at the final
 *   offset, which answers with the same CID; we send it.
 * - **Plain failures.** tus-js-client's `DetailedError`s become an
 *   {@link UploadFailure}: a sentence for the author and whether retrying can help.
 *
 * Everything outside the browser is injectable (`createUpload`, `fetchImpl`,
 * `getAuthorization`), so the whole flow is tested without a network.
 */

import type { DetailedError, HttpRequest, HttpResponse, PreviousUpload, Upload } from "tus-js-client";

import { authorizationHeader, resolveApiBaseUrl, tokenStore } from "../../lib/api";
import type { FileRole } from "./file-roles";
import { MIB } from "./limits";

/** tus-js-client's options type, which the package does not export by name. */
export type TusOptions = ConstructorParameters<typeof Upload>[1];

/** The slice of tus-js-client's `Upload` this module drives. */
export interface TusUploadLike {
  readonly url: string | null;
  start(): void;
  abort(shouldTerminate?: boolean): Promise<void>;
  findPreviousUploads(): Promise<PreviousUpload[]>;
  resumeFromPreviousUpload(previousUpload: PreviousUpload): void;
}

export type UploadFactory = (file: File, options: TusOptions) => TusUploadLike | Promise<TusUploadLike>;

/** Bytes sent per `PATCH`: small enough for frequent resume points, large enough to be cheap. */
export const UPLOAD_CHUNK_BYTES = 16 * MIB;

/** Waits (ms) before each retry; an upload gives up after the last one fails. */
export const UPLOAD_RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000];

export type UploadFailureKind =
  /** No answer from the server: offline, DNS, dropped connection. */
  | "network"
  /** 413: the server refused the size. Retrying cannot help. */
  | "too-large"
  /** 410: the bytes the server held are gone; the upload has to start over. */
  | "gone"
  /** Any other 4xx: the server understood and said no. */
  | "rejected"
  /** 5xx: the server had a problem. */
  | "server"
  /** The bytes arrived but the server's content ID could not be read. */
  | "unconfirmed";

export interface UploadFailure {
  kind: UploadFailureKind;
  /** HTTP status of the answer, or `null` when there was none. */
  status: number | null;
  /** A sentence for the author. */
  message: string;
  /** Whether the Retry button can help. */
  retryable: boolean;
}

export interface TusUploadCallbacks {
  onProgress(bytesSent: number, bytesTotal: number): void;
  /** An earlier partial upload of this very file was found and is being continued. */
  onResumed?(): void;
  /** The connection failed and the upload will try again (`attempt` counts from 0). */
  onRetrying?(attempt: number): void;
  /** The server has every byte and filed it under `cid`. */
  onSuccess(result: { cid: string; url: string | null }): void;
  onFailure(failure: UploadFailure): void;
}

export interface TusUploadConfig {
  /** The tus creation endpoint. Defaults to `<API origin>/v1/uploads`. */
  endpoint?: string;
  chunkSize?: number;
  retryDelays?: number[];
  /** The `Authorization` header value, or `undefined` to send none. Defaults to the stored session. */
  getAuthorization?: () => string | undefined;
  /** Builds the tus-js-client `Upload`. Defaults to importing the real library. */
  createUpload?: UploadFactory;
  fetchImpl?: typeof fetch;
  /** Whether the browser thinks it is online. Defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
}

export interface TusUploadInit {
  role: FileRole;
  /** Skip looking for an earlier partial upload and start a new one. */
  fresh?: boolean;
}

export interface TusUploadHandle {
  /** Stop sending. Bytes the server already has are kept, so a later upload can resume. */
  stop(): Promise<void>;
}

const TUS_VERSION = "1.0.0";
const OFFSET_CONTENT_TYPE = "application/offset+octet-stream";

/** The API's tus endpoint. */
export function defaultEndpoint(): string {
  return `${resolveApiBaseUrl()}/v1/uploads`;
}

const defaultCreateUpload: UploadFactory = async (file, options) => {
  // Loaded on demand: only /submit needs it, and the library touches
  // `window`/`localStorage` at import time in the browser build.
  const { Upload: TusUpload } = await import("tus-js-client");
  return new TusUpload(file, options);
};

function statusOf(error: Error): number {
  return (error as Partial<DetailedError>).originalResponse?.getStatus() ?? 0;
}

/**
 * Whether a failed request is worth repeating.
 *
 * Like tus-js-client's own default, except that 408 and 429 count as transient
 * too. Never while the browser is offline: the `online` event restarts those
 * uploads instead.
 */
export function shouldRetry(error: Error, online = true): boolean {
  const status = statusOf(error);
  const clientError = status >= 400 && status < 500;
  const transient = !clientError || [408, 409, 423, 429].includes(status);
  return transient && online;
}

/** The `detail` of an RFC 9457 problem body, when the response has one. */
function problemDetail(error: Error): string | null {
  try {
    const body = (error as Partial<DetailedError>).originalResponse?.getBody();
    const parsed: unknown = body ? JSON.parse(body) : null;
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && detail ? detail : null;
  } catch {
    return null;
  }
}

/** Turn what tus-js-client threw into a sentence and a verdict on retrying. */
export function describeFailure(error: Error): UploadFailure {
  const status = statusOf(error);
  if (status === 0) {
    return {
      kind: "network",
      status: null,
      message: "The connection was lost. The upload will continue from where it stopped.",
      retryable: true,
    };
  }
  if (status === 413) {
    return {
      kind: "too-large",
      status,
      message: problemDetail(error) ?? "The server says this file is too large.",
      retryable: false,
    };
  }
  if (status === 410) {
    return {
      kind: "gone",
      status,
      message: "The server no longer has the part of this file it received, so the upload has to start over.",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      kind: "server",
      status,
      message: `The server had a problem (HTTP ${status}). Try again in a moment.`,
      retryable: true,
    };
  }
  return {
    kind: "rejected",
    status,
    message: problemDetail(error) ?? `The server did not accept the upload (HTTP ${status}).`,
    retryable: true,
  };
}

/**
 * Ask the API for the CID of an upload it already holds in full.
 *
 * The API's recovery for a lost final response: repeat the `PATCH` at the
 * final offset with an empty body, and a stored upload answers `204` with
 * `Upload-Cid` again.
 */
async function recoverCid(
  url: string,
  size: number,
  authorization: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    "Tus-Resumable": TUS_VERSION,
    "Upload-Offset": String(size),
    "Content-Type": OFFSET_CONTENT_TYPE,
  };
  if (authorization) {
    headers.Authorization = authorization;
  }
  const response = await fetchImpl(url, { method: "PATCH", headers });
  return response.status === 204 ? (response.headers.get("Upload-Cid") ?? undefined) : undefined;
}

/** Of the earlier uploads of this file, the most recently created. */
function newestOf(previous: PreviousUpload[]): PreviousUpload | undefined {
  return [...previous].sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime))[0];
}

/**
 * Start uploading `file`. Returns at once; progress and the outcome arrive
 * through `callbacks`. After {@link TusUploadHandle.stop} no callback fires.
 */
export function startTusUpload(
  file: File,
  init: TusUploadInit,
  callbacks: TusUploadCallbacks,
  config: TusUploadConfig = {},
): TusUploadHandle {
  const getAuthorization = config.getAuthorization ?? (() => authorizationHeader(tokenStore.get()));
  const isOnline = config.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  let stopped = false;
  let upload: TusUploadLike | null = null;

  const metadata: Record<string, string> = { filename: file.name, role: init.role };
  if (file.type) {
    metadata.filetype = file.type;
  }

  const finish = async (lastResponse: HttpResponse | undefined): Promise<void> => {
    let cid = lastResponse?.getHeader("Upload-Cid") || undefined;
    const url = upload?.url ?? null;
    if (!cid && url) {
      try {
        cid = await recoverCid(url, file.size, getAuthorization(), config.fetchImpl ?? fetch);
      } catch {
        cid = undefined;
      }
    }
    if (stopped) {
      return;
    }
    if (cid) {
      callbacks.onSuccess({ cid, url });
    } else {
      callbacks.onFailure({
        kind: "unconfirmed",
        status: null,
        message: "The file was uploaded but the server's fingerprint for it could not be read. Try again.",
        retryable: true,
      });
    }
  };

  const options: TusOptions = {
    endpoint: config.endpoint ?? defaultEndpoint(),
    chunkSize: config.chunkSize ?? UPLOAD_CHUNK_BYTES,
    retryDelays: config.retryDelays ?? UPLOAD_RETRY_DELAYS,
    metadata,
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    onBeforeRequest(request: HttpRequest) {
      const authorization = getAuthorization();
      if (authorization) {
        request.setHeader("Authorization", authorization);
      }
    },
    onShouldRetry(error, retryAttempt) {
      const retry = shouldRetry(error, isOnline());
      if (retry && !stopped) {
        callbacks.onRetrying?.(retryAttempt);
      }
      return retry;
    },
    onProgress(sent, total) {
      if (!stopped) {
        callbacks.onProgress(sent, total);
      }
    },
    onSuccess({ lastResponse }) {
      void finish(lastResponse);
    },
    onError(error) {
      if (!stopped) {
        callbacks.onFailure(describeFailure(error));
      }
    },
  };

  void (async () => {
    try {
      upload = await (config.createUpload ?? defaultCreateUpload)(file, options);
      if (!init.fresh) {
        const earlier = newestOf(await upload.findPreviousUploads().catch(() => []));
        if (earlier && !stopped) {
          upload.resumeFromPreviousUpload(earlier);
          callbacks.onResumed?.();
        }
      }
      if (!stopped) {
        upload.start();
      }
    } catch (error) {
      if (!stopped) {
        callbacks.onFailure(describeFailure(error instanceof Error ? error : new Error(String(error))));
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await upload?.abort(false).catch(() => undefined);
    },
  };
}
