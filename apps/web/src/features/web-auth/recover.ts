/**
 * The `/recover` flow (feature 144).
 *
 * A person who has lost their device cannot sign in — that is the point — so
 * they identify the account by the one thing they still have, their ORCID iD.
 * This module holds everything that flow needs, as plain functions over an
 * injectable API client and device key:
 *
 * ```text
 * identify by ORCID iD
 *   → POST /v1/recovery/requests { orcid, new_public_key }   201 + request_id
 *   → guardians approve one by one            progress "2 of 3 approvals"
 *   → 3 of 3 approvals opens the 72-hour safety window
 *   → the old key (or the passkey still on a trusted device) cancels, or
 *     the window closes and the new key takes over
 * ```
 *
 * The API fixes the two constants that shape the page:
 * ``APPROVAL_THRESHOLD`` (3 of the account's 5 guardians) and
 * ``CONTEST_WINDOW`` (72 hours). They are mirrored here so the progress line
 * and the safety-window copy can be rendered before the first status reply.
 *
 * **Progress needs a status read.** Opening a request answers with the new
 * request id and nothing else, and feature 39 records approvals but exposes no
 * read route yet. {@link fetchRecoveryStatus} therefore asks
 * ``GET /v1/recovery/requests/{id}`` and treats a missing route (404 without
 * the recovery problem type, 405, 501) as "not available yet" rather than an
 * error: the page keeps showing the last state it knows (see
 * {@link isRecoveryStatusUnavailable}) and picks the real counts up as soon as
 * the route exists. The parser already accepts the shapes the API uses for
 * approvals on the write side, so no UI change is needed when it lands.
 *
 * Progress is remembered per browser under {@link RECOVERY_STORAGE_KEY}, so a
 * reload — or opening the cancel link sent to a known contact — keeps the
 * request on screen. The React wiring lives in `use-recover.ts`.
 */

import { ApiError, apiClient, browserTokenStorage } from "../../lib/api";
import type { ApiClient, TokenStorage } from "../../lib/api";

import { toBase64Url, utf8Encode } from "./encoding";
import { isEd25519DidKey } from "./did-key";

/** How many guardian approvals a recovery needs (the API's `APPROVAL_THRESHOLD`). */
export const RECOVERY_APPROVAL_THRESHOLD = 3;

/** How many guardians an account names (the API's `GUARDIAN_COUNT`). */
export const RECOVERY_GUARDIAN_COUNT = 5;

/** Length of the contest window opened by the third approval, in hours. */
export const SAFETY_WINDOW_HOURS = 72;

/** Where the in-flight recovery is remembered in browser storage. */
export const RECOVERY_STORAGE_KEY = "scholium.web-auth.recovery";

/** Page path of this flow. */
export const RECOVER_PATH = "/recover";

/** API collection the recovery requests live under. */
export const RECOVERY_REQUESTS_PATH = "/recovery/requests";

/** Passkey prompt reason shown when cancelling a recovery. */
export const RECOVERY_CANCEL_REASON = "Cancel this recovery";

/** Where a request is in its life (mirrors `recovery_requests.status`). */
export type RecoveryStatus = "pending" | "contest" | "finalized" | "cancelled";

/** Every status the API may report, in the order the flow reaches them. */
export const RECOVERY_STATUSES: readonly RecoveryStatus[] = [
  "pending",
  "contest",
  "finalized",
  "cancelled",
];

/** The problem type the API uses for a GET of a request that does not exist. */
export const RECOVERY_REQUEST_NOT_FOUND_TYPE =
  "urn:scholium:problem:recovery-request-not-found";

/** The problem type the API uses while an account has no guardians. */
export const RECOVERY_GUARDIANS_NOT_SET_TYPE =
  "urn:scholium:problem:recovery-guardians-not-set";

/** The problem type the API uses when the ORCID iD names no account. */
export const RECOVERY_ACCOUNT_NOT_FOUND_TYPE =
  "urn:scholium:problem:recovery-account-not-found";

/** Stable failure codes for {@link RecoveryError}. */
export type RecoveryErrorCode =
  | "invalid-orcid"
  | "invalid-public-key"
  | "invalid-response";

/** A recovery action could not proceed (never a transport failure). */
export class RecoveryError extends Error {
  /** Stable code callers can branch on. */
  readonly code: RecoveryErrorCode;

  constructor(
    code: RecoveryErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Type guard for {@link RecoveryError}. */
export function isRecoveryError(error: unknown): error is RecoveryError {
  return error instanceof RecoveryError;
}

/** The slice of {@link ApiClient} the recovery actions use. */
export type RecoveryClient = Pick<ApiClient, "get" | "post">;

/** The slice of the device key that cancelling a recovery needs. */
export interface RecoverySigner {
  /** Prompt for the passkey, then sign `data` with the device key. */
  signWithPasskey(
    data: Uint8Array,
    options?: { reason?: string; timeoutMs?: number },
  ): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// ORCID iD
// ---------------------------------------------------------------------------

/**
 * A bare ORCID iD: four groups of four digits, the last character a MOD 11-2
 * checksum digit that may be ``X``. Mirrors the API's `normalize_orcid`.
 */
const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** `https://orcid.org/<id>` is how ORCID writes an iD; accept and reduce it. */
const ORCID_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.|sandbox\.)?orcid\.org\//i;

/**
 * Return `value` as a bare ORCID iD (`0000-0002-1825-0097`), or `null` when it
 * is not one.
 *
 * Surrounding whitespace, an `https://orcid.org/` prefix and a lowercase check
 * `x` are accepted, exactly as the API accepts them, so a pasted profile URL
 * never fails the browser's validation and then succeeds on the server.
 */
export function normalizeOrcid(value: string): string | null {
  const text = value
    .trim()
    .replace(ORCID_URL_PREFIX, "")
    .trim()
    .toUpperCase();
  return ORCID_PATTERN.test(text) ? text : null;
}

/** True when `value` is an ORCID iD in the form the API accepts. */
export function isOrcid(value: string): boolean {
  return normalizeOrcid(value) !== null;
}

// ---------------------------------------------------------------------------
// Reading API payloads
// ---------------------------------------------------------------------------

/** Anything shaped like a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** First member of `record` present under any of `names`. */
function readField(
  record: Record<string, unknown>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** First non-empty string among the named members, or `null`. */
function readString(
  record: Record<string, unknown>,
  names: readonly string[],
): string | null {
  const value = readField(record, names);
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A whole, non-negative count, or `null`. Arrays count by their length. */
function readCount(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

/** First count among the named members, or `null`. */
function readCountField(
  record: Record<string, unknown>,
  names: readonly string[],
): number | null {
  for (const name of names) {
    const value = readCount(record[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** Parse any of the API's status spellings, or `null`. */
export function parseRecoveryStatus(value: unknown): RecoveryStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (normalized) {
    case "pending":
    case "waiting":
      return "pending";
    case "contest":
    case "contesting":
    case "safety-window":
    case "window":
      return "contest";
    case "finalized":
    case "finalised":
    case "complete":
    case "completed":
    case "done":
      return "finalized";
    case "cancelled":
    case "canceled":
    case "canceling":
    case "cancelling":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Parse a timestamp into an ISO 8601 UTC string, or `null`.
 *
 * The API writes naive UTC (`2026-11-18T09:00:00`) in some responses and
 * ISO with a zone in others; a value without a zone is read as UTC so the
 * deadline never drifts by the browser's offset.
 */
export function parseRecoveryInstant(value: unknown): string | null {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds are ~1e9, milliseconds ~1e12.
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const naive = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(trimmed);
    date = new Date(naive ? `${trimmed}Z` : trimmed);
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A recovery request as `POST /v1/recovery/requests` describes it. */
export interface OpenedRecovery {
  /** `request_id` from the API. */
  requestId: string;
  /** Where the request is now. */
  status: RecoveryStatus;
  /** Guardian approvals recorded so far. */
  approvals: number;
  /** How many approvals the request needs. */
  threshold: number;
  /** How many guardians were notified when it opened. */
  guardiansNotified: number;
  /** End of the safety window, ISO 8601 UTC; `null` until it opens. */
  contestUntil: string | null;
}

/**
 * Validate the `201` body of `POST /v1/recovery/requests`.
 *
 * Only `request_id` is essential; the rest has defaults that match a freshly
 * opened request, so a node that answers with just the id still works.
 */
export function parseOpenedRecovery(payload: unknown): OpenedRecovery {
  if (!isRecord(payload)) {
    throw new RecoveryError(
      "invalid-response",
      "The recovery request reply was not an object",
    );
  }
  const requestId = readString(payload, ["request_id", "requestId", "id"]);
  if (!requestId) {
    throw new RecoveryError(
      "invalid-response",
      "The recovery request reply did not name the request",
    );
  }

  const approvals =
    readCountField(payload, [
      "approval_count",
      "approvals_count",
      "approvalCount",
      "approvals",
      "count",
      "approved",
    ]) ?? 0;
  const threshold = clampThreshold(
    readCountField(payload, [
      "threshold",
      "approvals_required",
      "approvalsRequired",
      "required_approvals",
      "requiredApprovals",
      "needed",
      "required",
    ]),
  );

  return {
    requestId,
    status: parseRecoveryStatus(readField(payload, ["status", "state"])) ?? "pending",
    approvals,
    threshold,
    guardiansNotified:
      readCountField(payload, [
        "guardians_notified",
        "guardiansNotified",
        "guardian_count",
        "guardianCount",
        "guardians",
      ]) ?? 0,
    contestUntil: parseRecoveryInstant(
      readField(payload, [
        "contest_until",
        "contestUntil",
        "safety_window_ends_at",
        "safetyWindowEndsAt",
      ]),
    ),
  };
}

function clampThreshold(value: number | null): number {
  if (value === null || value < 1) {
    return RECOVERY_APPROVAL_THRESHOLD;
  }
  return value;
}

/** A status read, with `undefined` meaning "the reply did not say". */
export interface RecoveryStatusUpdate {
  status?: RecoveryStatus | null;
  approvals?: number | null;
  threshold?: number | null;
  guardiansNotified?: number | null;
  contestUntil?: string | null;
  newPublicKey?: string | null;
  /** `did:key` of the account being recovered, when the reply names it. */
  accountDid?: string | null;
}

/**
 * Read a `GET /v1/recovery/requests/{id}` body.
 *
 * Members are optional: a reply only needs to be an object, and anything it
 * leaves out keeps the value already on screen. That makes the page work
 * against partial implementations of the status route.
 */
export function parseRecoveryStatusUpdate(payload: unknown): RecoveryStatusUpdate {
  if (!isRecord(payload)) {
    throw new RecoveryError(
      "invalid-response",
      "The recovery status reply was not an object",
    );
  }
  const update: RecoveryStatusUpdate = {};
  const status = parseRecoveryStatus(readField(payload, ["status", "state"]));
  if (status) {
    update.status = status;
  }
  const approvals = readCountField(payload, [
    "approval_count",
    "approvals_count",
    "approvalCount",
    "approvals",
    "count",
    "approved",
  ]);
  if (approvals !== null) {
    update.approvals = approvals;
  }
  const threshold = readCountField(payload, [
    "threshold",
    "approvals_required",
    "approvalsRequired",
    "required_approvals",
    "requiredApprovals",
    "needed",
    "required",
  ]);
  if (threshold !== null) {
    update.threshold = clampThreshold(threshold);
  }
  const guardians = readCountField(payload, [
    "guardians_notified",
    "guardiansNotified",
    "guardian_count",
    "guardianCount",
    "guardians",
  ]);
  if (guardians !== null) {
    update.guardiansNotified = guardians;
  }
  if (
    "contest_until" in payload ||
    "contestUntil" in payload ||
    "safety_window_ends_at" in payload ||
    "safetyWindowEndsAt" in payload
  ) {
    update.contestUntil = parseRecoveryInstant(
      readField(payload, [
        "contest_until",
        "contestUntil",
        "safety_window_ends_at",
        "safetyWindowEndsAt",
      ]),
    );
  }
  const newPublicKey = readString(payload, [
    "new_public_key",
    "newPublicKey",
    "new_key",
    "newKey",
  ]);
  if (newPublicKey) {
    update.newPublicKey = newPublicKey;
  }
  // The account's DID is public here: it names what is being recovered and is
  // how the page reads the profile name the person recognises.
  const accountDid = readString(payload, ["did", "account_did", "accountDid"]);
  if (accountDid !== null) {
    update.accountDid = accountDid;
  }
  return update;
}

// ---------------------------------------------------------------------------
// The open request, as the page remembers it
// ---------------------------------------------------------------------------

/** Everything the `/recover` page shows about one recovery request. */
export interface RecoverySnapshot extends OpenedRecovery {
  /** ORCID iD the recovery was opened under. */
  orcid: string;
  /** `did:key` the account should move to (created on this device). */
  newPublicKey: string;
  /** When the request was opened from this browser, ISO 8601 UTC. */
  openedAt: string;
  /**
   * `did:key` of the account being recovered, once a status read names it.
   * The page reads the public profile name with it; the ORCID iD alone does
   * not identify a profile.
   */
  accountDid?: string;
}

/** Options for {@link openRecoveryRequest}. */
export interface OpenRecoveryRequestOptions {
  /** The ORCID iD identifying the account. */
  orcid: string;
  /** The `did:key` the recovered account should move to. */
  newPublicKey: string;
  /** API client; defaults to the app-wide one. */
  client?: RecoveryClient;
  /** Clock in epoch milliseconds, injectable for tests. */
  now?: () => number;
}

/** Describes the path of one recovery request. */
export function recoveryRequestPath(requestId: string): string {
  return `${RECOVERY_REQUESTS_PATH}/${encodeURIComponent(requestId)}`;
}

/**
 * Open a recovery request and return it as the page tracks it.
 *
 * Validates the ORCID iD and the new key before anything leaves the browser,
 * so the common mistakes get one sentence instead of a round trip. The call is
 * unauthenticated on purpose: the account holder has no access token any more.
 *
 * @throws {RecoveryError} `invalid-orcid`, `invalid-public-key` or
 *   `invalid-response`; an API or transport failure is rethrown unchanged.
 */
export async function openRecoveryRequest({
  orcid,
  newPublicKey,
  client = apiClient,
  now = Date.now,
}: OpenRecoveryRequestOptions): Promise<RecoverySnapshot> {
  const normalized = normalizeOrcid(orcid);
  if (!normalized) {
    throw new RecoveryError(
      "invalid-orcid",
      "'orcid' is not an ORCID iD such as 0000-0002-1825-0097",
    );
  }
  if (!isEd25519DidKey(newPublicKey)) {
    throw new RecoveryError(
      "invalid-public-key",
      "The new key is not a canonical Ed25519 did:key",
    );
  }

  const payload = await client.post<unknown>(
    RECOVERY_REQUESTS_PATH,
    { orcid: normalized, new_public_key: newPublicKey },
    { auth: false },
  );
  return {
    ...parseOpenedRecovery(payload),
    orcid: normalized,
    newPublicKey,
    openedAt: new Date(now()).toISOString(),
  };
}

/**
 * Read the current state of `requestId`.
 *
 * The API may answer this route with a 404 (not implemented yet) or not at
 * all; callers should treat those as "no news" via
 * {@link isRecoveryStatusUnavailable} and keep what they already show.
 */
export async function fetchRecoveryStatus(
  requestId: string,
  client: RecoveryClient = apiClient,
): Promise<RecoveryStatusUpdate> {
  const payload = await client.get<unknown>(recoveryRequestPath(requestId), {
    auth: false,
  });
  return parseRecoveryStatusUpdate(payload);
}

/** The slice of the API client a public profile read uses. */
export type RecoveryProfileClient = Pick<ApiClient, "get">;

/**
 * The public profile name of the account being recovered, or `null`.
 *
 * The progress page knows the account's DID (the status route names it) but a
 * person recognises their own account by the name they chose, not by an ORCID
 * iD. The profile read is public and best-effort: a profile that cannot be
 * read, or one with no name, leaves the page showing the ORCID iD.
 */
export async function loadRecoveryAccountName(
  accountDid: string,
  client: RecoveryProfileClient = apiClient,
): Promise<string | null> {
  const did = accountDid.trim();
  if (did === "") {
    return null;
  }
  let payload: unknown;
  try {
    payload = await client.get<unknown>(`/profiles/${encodeURIComponent(did)}`, {
      auth: false,
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.erased === true) {
    return null;
  }
  for (const key of ["name", "display_name", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/** Merge a status read into the snapshot, keeping anything it did not mention. */
export function mergeRecoveryStatus(
  current: RecoverySnapshot,
  update: RecoveryStatusUpdate,
): RecoverySnapshot {
  const threshold = update.threshold ?? current.threshold;
  const approvals = update.approvals ?? current.approvals;
  const contestUntil =
    update.contestUntil !== undefined ? update.contestUntil : current.contestUntil;
  // A reply with the count but no explicit status still moves the page to the
  // safety window, so a minimal status route is enough.
  const status =
    update.status ??
    (approvals >= threshold && contestUntil ? "contest" : current.status);

  return {
    ...current,
    status,
    approvals,
    threshold,
    guardiansNotified: update.guardiansNotified ?? current.guardiansNotified,
    contestUntil,
    newPublicKey: update.newPublicKey ?? current.newPublicKey,
    accountDid: update.accountDid ?? current.accountDid,
  };
}

/**
 * True when a status read failed because the route is not there, not because
 * the request is bad. Such a failure is not shown as an error: the page keeps
 * its last known progress and offers "Check again".
 */
export function isRecoveryStatusUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  if (error.status === 405 || error.status === 501) {
    return true;
  }
  if (error.status === 404) {
    // The route-missing 404 is not the API's "no such request" problem type.
    return error.type !== RECOVERY_REQUEST_NOT_FOUND_TYPE;
  }
  return false;
}

/** The slice of the device key that adopting a recovered account needs. */
export interface RecoveredAccountKey {
  /** `did:key` of this device's key. */
  didKey(): Promise<string>;
  /** Record which account this device's key signs for. */
  setAccountDid(accountDid: string): Promise<void>;
}

/**
 * Once a recovery has completed, remember on this device which account it
 * recovered, so signing in reaches that account.
 *
 * The recovered account keeps its DID; only its key moved, to the one this
 * device made when the recovery was opened. That key's own did:key is not the
 * account's DID, so without this the device would sign in as the key's own
 * did:key and land in a new, empty account.
 *
 * Only a **finalized** recovery whose new key is **this device's** key counts:
 * another device (the old one opening the cancel link) holds a different key,
 * and a recovery still in its safety window has not moved the account yet.
 *
 * @returns true when the device now records the recovered account.
 * @throws whatever the device key throws while reading or storing.
 */
export async function adoptRecoveredAccount(
  snapshot: RecoverySnapshot,
  key: RecoveredAccountKey,
): Promise<boolean> {
  const { accountDid, newPublicKey } = snapshot;
  if (snapshot.status !== "finalized" || !newPublicKey || !isEd25519DidKey(accountDid)) {
    return false;
  }
  if ((await key.didKey()) !== newPublicKey) {
    return false;
  }
  await key.setAccountDid(accountDid);
  return true;
}

/**
 * Cancel an open recovery, signed by the key that is still on the account.
 *
 * The API accepts a detached Ed25519 signature over the request id, which is
 * precisely the message guardians sign to approve. Cancelling therefore needs
 * a device that still holds the old passkey — the link sent to known contacts
 * opens this page with `?request=` so they can click it there.
 *
 * @throws whatever the signer throws (`DeviceKeyError` for a dismissed
 *   prompt) or the API's `ApiError` (401 when this device is not the old key).
 */
export async function cancelRecoveryRequest(options: {
  requestId: string;
  signer: RecoverySigner;
  client?: RecoveryClient;
  reason?: string;
  timeoutMs?: number;
}): Promise<void> {
  const {
    requestId,
    signer,
    client = apiClient,
    reason = RECOVERY_CANCEL_REASON,
    timeoutMs,
  } = options;
  const signature = await signer.signWithPasskey(utf8Encode(requestId), {
    reason,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  await client.post(
    `${recoveryRequestPath(requestId)}/cancel`,
    { signature: toBase64Url(signature) },
    { auth: false },
  );
}

// ---------------------------------------------------------------------------
// Progress and the safety window
// ---------------------------------------------------------------------------

/**
 * The progress line: `"2 of 3 approvals"`.
 *
 * Never shows more than the threshold, so a stale count read after an approval
 * cannot put the bar past its end.
 */
export function approvalProgressText(
  approvals: number,
  threshold: number = RECOVERY_APPROVAL_THRESHOLD,
): string {
  const total = Math.max(1, Math.trunc(threshold));
  const done = Math.max(0, Math.min(Math.trunc(approvals), total));
  return `${done} of ${total} approvals`;
}

/** How many more approvals are needed before the safety window opens. */
export function approvalsRemaining(snapshot: RecoverySnapshot): number {
  return Math.max(0, snapshot.threshold - snapshot.approvals);
}

/** The deadline as `18 Nov 2026, 09:00 UTC`, or `null` when unparseable. */
export function formatRecoveryDeadline(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = date.getUTCDate();
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`;
}

/**
 * Milliseconds left in the safety window, `0` once it has closed, or `null`
 * when there is no window or its deadline cannot be read.
 */
export function safetyWindowRemainingMs(
  contestUntil: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!contestUntil) {
    return null;
  }
  const end = new Date(contestUntil).getTime();
  if (Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, end - nowMs);
}

/**
 * The remaining time in words, for embedding in a sentence:
 * `"about 68 hours"`, `"about 2 days 20 hours"`, `"less than an hour"`.
 */
export function formatSafetyWindowRemaining(remainingMs: number): string {
  if (remainingMs <= 0) {
    return "the safety window has closed";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (rest === 0) {
    return `about ${days} days`;
  }
  return `about ${days} days ${rest} hours`;
}

/** True while the recovery can still be cancelled. */
export function isCancellable(snapshot: RecoverySnapshot): boolean {
  return snapshot.status === "pending" || snapshot.status === "contest";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read the recovery remembered in this browser.
 *
 * Junk (or nothing) reads as no recovery: a corrupt entry must never keep the
 * identify form off the screen. Storage that throws is treated the same way.
 */
export function loadPersistedRecovery(
  storage: TokenStorage = browserTokenStorage,
): RecoverySnapshot | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const requestId = readString(parsed, ["requestId"]);
  if (!requestId) {
    return null;
  }
  const orcid = readString(parsed, ["orcid"]);
  const newPublicKey = readString(parsed, ["newPublicKey"]);
  return {
    requestId,
    orcid: orcid ?? "",
    newPublicKey: newPublicKey ?? "",
    status: parseRecoveryStatus(parsed.status) ?? "pending",
    approvals: readCount(parsed.approvals) ?? 0,
    threshold: clampThreshold(readCount(parsed.threshold)),
    guardiansNotified: readCount(parsed.guardiansNotified) ?? 0,
    contestUntil: parseRecoveryInstant(parsed.contestUntil),
    openedAt:
      parseRecoveryInstant(parsed.openedAt) ?? new Date(0).toISOString(),
    accountDid:
      readString(parsed, ["accountDid", "account_did", "did"]) ?? undefined,
  };
}

/** Persist the request; storage that throws is ignored (the page still works). */
export function savePersistedRecovery(
  storage: TokenStorage,
  snapshot: RecoverySnapshot,
): void {
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Blocked storage only costs the page its memory across visits.
  }
}

/** Forget the remembered request. */
export function clearPersistedRecovery(storage: TokenStorage): void {
  try {
    storage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * A snapshot for a request this browser did not open (for example the cancel
 * link sent to a known contact, `/recover?request=rec_…`).
 *
 * The status fields start from the defaults the page uses before any read;
 * `fetchRecoveryStatus` fills them in.
 */
export function placeholderRecovery(
  requestId: string,
  orcid = "",
  now: () => number = Date.now,
): RecoverySnapshot {
  return {
    requestId,
    orcid,
    newPublicKey: "",
    status: "pending",
    approvals: 0,
    threshold: RECOVERY_APPROVAL_THRESHOLD,
    guardiansNotified: 0,
    contestUntil: null,
    openedAt: new Date(now()).toISOString(),
  };
}
