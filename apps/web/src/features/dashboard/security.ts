/**
 * The member's security screen (`/me/security`).
 *
 * The page answers four questions: which key signs for me, when did it last
 * change, who can help me recover, and which device holds it. No single API
 * document answers all four, so this module reads what exists and says where
 * each answer came from:
 *
 * - **Who and which key** — `GET /v1/me/dashboard` names the caller, then
 *   `GET /v1/did/{did}` gives the active key, the tier and the key history
 *   (one entry per `key.rotation` record).
 * - **Guardians** — `GET /v1/me/guardians` when the server offers it. The API
 *   only has `PUT /v1/me/guardians` today, so a missing read route falls back
 *   to the list this browser saved during onboarding and the page labels it
 *   as such rather than claiming the server confirmed it.
 * - **Devices** — the key held by this browser. The API keeps no device list.
 *
 * Pure data and functions, no React, so the route and the client component
 * share them and vitest can test them without a JSX transform.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { formatDate } from "../ui-kit/format-date";
import {
  RECOVERY_APPROVAL_THRESHOLD,
  RECOVERY_GUARDIAN_COUNT,
  deviceKey,
  loadPersistedOnboarding,
  type DeviceKeySummary,
} from "../web-auth";

import { DashboardError, SECURITY_PATH, loadDashboard, loadNotifications } from "./dashboard";

export { SECURITY_PATH };

/** Human-facing label for the page and its links. */
export const SECURITY_TITLE = "Security";

/** Sign-in, returning to this page afterwards. */
export const SECURITY_SIGNIN_HREF = `/signin?next=${encodeURIComponent(SECURITY_PATH)}`;

/** Where guardians are set (the onboarding checklist owns that form). */
export const GUARDIANS_SETUP_HREF = "/onboarding";

/** Guardian list endpoint, relative to `/v1`. Only `PUT` exists server-side today. */
export const GUARDIANS_ENDPOINT = "/me/guardians";

/** Pending recovery requests for the signed-in guardian. */
export const RECOVERY_REQUESTS_ENDPOINT = "/recovery/requests";

/** A member's public profile, relative to `/v1` (`GET /v1/profiles/{did}`). */
export const PROFILES_ENDPOINT = "/profiles";

/** Approvals a recovery needs: the "3" in "3 of 5" (the API's threshold). */
export const GUARDIAN_THRESHOLD = RECOVERY_APPROVAL_THRESHOLD;

/** Guardians an account names: the "5" in "3 of 5" (the API's count). */
export const GUARDIAN_TOTAL = RECOVERY_GUARDIAN_COUNT;

/** `3 of 5`, the scheme as the design names it. */
export const GUARDIAN_SCHEME = `${GUARDIAN_THRESHOLD} of ${GUARDIAN_TOTAL}`;

/** DID document path for `did`, relative to `/v1`. */
export function didEndpoint(did: string): string {
  return `/did/${encodeURIComponent(did)}`;
}

/** Anything that can fetch the security documents; tests pass a narrow `get`. */
export type SecurityClient = Pick<ApiClient, "get">;

/** The slice of the device key manager this screen reads. Never prompts. */
export interface SecurityDevice {
  load(): Promise<DeviceKeySummary | null>;
  didKey(): Promise<string>;
}

/** Raised when the API answers with something that is not what the page needs. */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** One `key.rotation` record in the account's history. */
export interface KeyRotation {
  /** The rotation record's id; open it with the record link. */
  readonly recordCid: string;
  /** Position in the server's log, when it said. */
  readonly seq: number | null;
  readonly oldKey: string | null;
  readonly newKey: string | null;
  /** When it took effect, as recorded. Null when the record carried none. */
  readonly effectiveAt: string | null;
  readonly reason: string | null;
}

/** The account's signing key and its history, from `GET /v1/did/{did}`. */
export interface KeyState {
  readonly did: string;
  /** The key allowed to sign for the account right now. */
  readonly activeKey: string;
  readonly tier: number | null;
  /** Every rotation, oldest first. */
  readonly rotations: readonly KeyRotation[];
}

function parseRotation(value: unknown, index: number): KeyRotation {
  if (!isRecord(value)) {
    throw new SecurityError(`Key rotation ${index + 1} is not an object.`);
  }
  const recordCid = readText(value.record_cid) ?? readText(value.recordCid);
  if (recordCid === null) {
    throw new SecurityError(`Key rotation ${index + 1} has no record id.`);
  }
  return {
    recordCid,
    seq: readInt(value.seq),
    oldKey: readText(value.old_key) ?? readText(value.oldKey),
    newKey: readText(value.new_key) ?? readText(value.newKey),
    effectiveAt: readText(value.effective_at) ?? readText(value.effectiveAt),
    reason: readText(value.reason),
  };
}

/**
 * Validate a DID document into a {@link KeyState}.
 *
 * A document without an active key is rejected rather than shown as "never
 * rotated": a blank would read as "nothing to worry about" when the truth is
 * "we don't know which key signs for you".
 */
export function parseKeyState(payload: unknown): KeyState {
  if (!isRecord(payload)) {
    throw new SecurityError("The API did not return a key document.");
  }
  const did = readText(payload.did);
  if (did === null) {
    throw new SecurityError("The key document did not name the account.");
  }
  const activeKey = readText(payload.active_key) ?? readText(payload.activeKey);
  if (activeKey === null) {
    throw new SecurityError("The key document did not name the active key.");
  }
  const history = payload.key_history ?? payload.keyHistory;
  const rotations = (Array.isArray(history) ? history : []).map(parseRotation);
  // The API lists oldest first; sort only when every entry says where it sits.
  if (rotations.every((rotation) => rotation.seq !== null)) {
    rotations.sort((a, b) => (a.seq as number) - (b.seq as number));
  }
  return { did, activeKey, tier: readInt(payload.tier), rotations };
}

/** Where the guardian list on screen came from. */
export type GuardianSource =
  /** The server's own list. */
  | "server"
  /** What this browser saved while setting guardians up. */
  | "this-browser"
  /** Neither knows: this browser never saved a list and the server has no read route. */
  | "unknown";

/** The recovery guardians, and how sure we are of them. */
export interface GuardianState {
  /** Approvals needed to recover (3). */
  readonly required: number;
  /** Guardians an account names (5). */
  readonly total: number;
  /** The guardians' DIDs, in the order they were set. Empty when unknown. */
  readonly dids: readonly string[];
  /** Guardians this browser also has saved from setting them up. */
  readonly localDids?: readonly string[];
  readonly source: GuardianSource;
}

/**
 * Read a guardian list out of a `GET /v1/me/guardians` body.
 *
 * Accepts `{"guardians": [...]}` or `{"guardian_dids": [...]}` (the two names
 * `PUT` accepts) or a bare array. Anything else is `null`: not a list.
 */
export function parseGuardianList(payload: unknown): string[] | null {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (payload.guardians ?? payload.guardian_dids)
      : undefined;
  if (!Array.isArray(list)) {
    return null;
  }
  return list.map(readText).filter((did): did is string => did !== null);
}

function guardianState(
  dids: readonly string[],
  source: GuardianSource,
  localDids: readonly string[] = [],
): GuardianState {
  return { required: GUARDIAN_THRESHOLD, total: GUARDIAN_TOTAL, dids, localDids, source };
}


/**
 * Read a list of recovery requests out of an API body.
 */
export function parseRecoveryRequests(payload: unknown): RecoveryRequestSummary[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (payload.requests ?? payload.items ?? payload.recovery_requests)
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: RecoveryRequestSummary[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const requestId = readText(item.request_id) ?? readText(item.requestId) ?? readText(item.id);
    if (!requestId) continue;
    const accountDid =
      readText(item.did) ?? readText(item.account_did) ?? readText(item.accountDid) ?? "";
    const newPublicKey =
      readText(item.new_public_key) ?? readText(item.newPublicKey) ?? readText(item.new_key) ?? readText(item.newKey) ?? "";
    const approvals =
      typeof item.approval_count === "number"
        ? item.approval_count
        : typeof item.approvals_count === "number"
          ? item.approvals_count
          : Array.isArray(item.approvals)
            ? item.approvals.length
            : 0;
    const threshold = typeof item.threshold === "number" ? item.threshold : GUARDIAN_THRESHOLD;
    const status = readText(item.status) ?? "pending";
    const role = readText(item.role) ?? undefined;
    const requestedAt =
      readText(item.requested_at) ?? readText(item.requestedAt) ?? null;
    const contestUntil =
      readText(item.contest_until) ?? readText(item.contestUntil) ?? null;
    out.push({
      requestId,
      accountDid,
      status,
      approvals,
      threshold,
      newPublicKey,
      role,
      requestedAt,
      contestUntil,
    });
  }
  return out;
}

export async function loadRecoveryRequests(
  client: SecurityClient = api,
): Promise<RecoveryRequestSummary[]> {
  try {
    const payload = await client.get<unknown>(RECOVERY_REQUESTS_ENDPOINT, { cache: "no-store" });
    return parseRecoveryRequests(payload);
  } catch {
    return [];
  }
}

/**
 * Add when the caller's own recovery was started.
 *
 * `GET /v1/recovery/requests` names an owner's open request but carries no
 * creation time; the owner's own `recovery.request` notice does
 * (`requested_at`), so it is read for that one fact. Best-effort: if the
 * notices cannot be read, the card simply omits the start date.
 */
async function addOwnerRecoveryStarts(
  requests: RecoveryRequestSummary[],
  client: SecurityClient,
): Promise<RecoveryRequestSummary[]> {
  const missing = requests.some(
    (request) => request.role === "owner" && request.requestedAt == null,
  );
  if (!missing) {
    return requests;
  }
  try {
    const notices = await loadNotifications(client);
    const starts = new Map<string, string>();
    for (const notice of notices) {
      if (notice.kind !== "recovery.request") {
        continue;
      }
      const requestId =
        readText(notice.payload.request_id) ?? readText(notice.payload.requestId);
      const requestedAt =
        readText(notice.payload.requested_at) ?? readText(notice.payload.requestedAt);
      if (requestId !== null && requestedAt !== null && !starts.has(requestId)) {
        starts.set(requestId, requestedAt);
      }
    }
    return requests.map((request) =>
      request.role === "owner" && request.requestedAt == null
        ? { ...request, requestedAt: starts.get(request.requestId) ?? null }
        : request,
    );
  } catch {
    return requests;
  }
}

/**
 * The guardians, from the server when it can say and from this browser's
 * onboarding record otherwise. A failed read never fails the page: the
 * guardians are one card of three, and the card says where its answer came
 * from.
 */
export async function loadGuardians(
  client: SecurityClient = api,
  storage?: Parameters<typeof loadPersistedOnboarding>[0],
): Promise<GuardianState> {
  const saved = loadPersistedOnboarding(storage);
  try {
    const list = parseGuardianList(
      await client.get<unknown>(GUARDIANS_ENDPOINT, { cache: "no-store" }),
    );
    if (list !== null) {
      return guardianState(list, "server", saved.guardians);
    }
  } catch {
    // No read route yet (404/405/501), or the read failed: use what we saved.
  }
  return saved.guardians.length > 0
    ? guardianState(saved.guardians, "this-browser", saved.guardians)
    : guardianState([], "unknown", saved.guardians);
}

/** How many guardians are named, capped at the scheme's total. */
export function guardiansSet(state: GuardianState): number {
  return Math.min(state.dids.length, state.total);
}

/** True when the account has all of its guardians. */
export function guardiansComplete(state: GuardianState): boolean {
  return guardiansSet(state) >= state.total;
}


/** One recovery request a guardian is asked to approve. */
export interface RecoveryRequestSummary {
  readonly requestId: string;
  readonly accountDid: string;
  readonly status: string;
  readonly approvals: number;
  readonly threshold: number;
  readonly newPublicKey: string;
  /** The caller's relationship to the request: `"owner"` or `"guardian"`. */
  readonly role?: string;
  /** When the recovery was started, when the API records it. */
  readonly requestedAt?: string | null;
  /** When the new passkey can take over (the safety window's end), when open. */
  readonly contestUntil?: string | null;
}

/** A key held by one of the member's devices. */
export interface DeviceInfo {
  /** The passkey's credential id: stable and unique per device key. */
  readonly id: string;
  /** `did:key` the device's key signs as. */
  readonly did: string;
  /** Epoch milliseconds the key was created, when known. */
  readonly createdAt: number | null;
  readonly rpId: string;
  /** True when this device's key is the one the account currently signs with. */
  readonly holdsActiveKey: boolean;
}

/**
 * The key held by this browser. A browser with no key has no devices to show;
 * a browser whose storage cannot be read says so instead of looking empty.
 */
export async function loadDevices(
  device: SecurityDevice,
  activeKey: string,
): Promise<{ devices: DeviceInfo[]; readable: boolean }> {
  try {
    const summary = await device.load();
    if (summary === null) {
      return { devices: [], readable: true };
    }
    const did = await device.didKey();
    return {
      devices: [
        {
          id: summary.credentialId,
          did,
          createdAt: Number.isFinite(summary.createdAt) ? summary.createdAt : null,
          rpId: summary.rpId,
          holdsActiveKey: did === activeKey,
        },
      ],
      readable: true,
    };
  } catch {
    return { devices: [], readable: false };
  }
}

/** One DID's public profile name, or `null` when there is none to read. */
async function readProfileName(
  did: string,
  client: SecurityClient,
): Promise<string | null> {
  try {
    const payload = await client.get<unknown>(
      `${PROFILES_ENDPOINT}/${encodeURIComponent(did)}`,
      { auth: false, cache: "no-store" },
    );
    if (!isRecord(payload) || payload.erased === true) {
      return null;
    }
    return (
      readText(payload.name) ??
      readText(payload.display_name) ??
      readText(payload.displayName)
    );
  } catch {
    // A profile that cannot be read must not fail the security screen; the
    // DID is still shown.
    return null;
  }
}

/**
 * The public names of `dids`, keyed by DID.
 *
 * Guardians and recovery requesters are stored as DIDs (there is no profile
 * join on either API), so the screen reads each one's public profile to show
 * a name first and the DID second. Reads are best-effort and de-duplicated;
 * a DID with no readable name is simply absent from the map.
 */
export async function loadProfileNames(
  dids: readonly string[],
  client: SecurityClient = api,
): Promise<Record<string, string>> {
  const unique = [
    ...new Set(
      dids.filter(
        (did): did is string => typeof did === "string" && did.startsWith("did:"),
      ),
    ),
  ];
  const entries = await Promise.all(
    unique.map(async (did) => [did, await readProfileName(did, client)] as const),
  );
  const names: Record<string, string> = {};
  for (const [did, name] of entries) {
    if (name !== null) {
      names[did] = name;
    }
  }
  return names;
}

/** Everything the security screen shows. */
export interface SecurityData {
  /** The account's DID: who the API says you are. */
  readonly did: string;
  readonly tier: number | null;
  /** The key that currently signs for the account. */
  readonly activeKey: string;
  /** Every key rotation, oldest first. */
  readonly rotations: readonly KeyRotation[];
  /** The most recent rotation, or `null` when the key has never changed. */
  readonly lastRotation: KeyRotation | null;
  readonly guardians: GuardianState;
  /**
   * Every open recovery request this caller can act on: a guardian's to
   * approve (`role: "guardian"`) or the caller's own (`role: "owner"`).
   */
  readonly recoveryRequests?: readonly RecoveryRequestSummary[];
  /**
   * Public profile names for the DIDs this screen lists (guardians and
   * recovery requesters), keyed by DID. Absent when none could be read; the
   * DID is then shown on its own.
   */
  readonly profileNames?: Readonly<Record<string, string>>;
  /** Keys held by devices Scholium can see: this browser's, when it has one. */
  readonly devices: readonly DeviceInfo[];
  /** False when this browser's key store could not be read. */
  readonly devicesReadable: boolean;
}

/** Injection points for {@link loadSecurity}. */
export interface LoadSecurityOptions {
  client?: SecurityClient;
  device?: SecurityDevice;
  storage?: Parameters<typeof loadPersistedOnboarding>[0];
}

/**
 * Load the security screen.
 *
 * The account's DID comes from the API (`/me/dashboard`), not from the device
 * key: after a rotation the device holds a different key than the one the
 * account was created with, and asking about the device's own DID would show
 * a brand-new identity with no history.
 */
export async function loadSecurity(options: LoadSecurityOptions = {}): Promise<SecurityData> {
  const client = options.client ?? api;
  const { did } = await loadDashboard(client);

  const [key, guardians, listedRecoveryRequests] = await Promise.all([
    client.get<unknown>(didEndpoint(did), { cache: "no-store" }).then(parseKeyState),
    loadGuardians(client, options.storage),
    loadRecoveryRequests(client),
  ]);
  const recoveryRequests = await addOwnerRecoveryStarts(listedRecoveryRequests, client);
  const { devices, readable } = await loadDevices(options.device ?? deviceKey, key.activeKey);
  const profileNames = await loadProfileNames(
    [
      ...guardians.dids,
      ...recoveryRequests.map((request) => request.accountDid),
    ],
    client,
  );

  return {
    did: key.did,
    tier: key.tier,
    activeKey: key.activeKey,
    rotations: key.rotations,
    lastRotation: key.rotations.length > 0 ? key.rotations[key.rotations.length - 1]! : null,
    guardians,
    recoveryRequests,
    profileNames,
    devices,
    devicesReadable: readable,
  };
}

/** Sort a failed load into a plain message. */
export function describeSecurityError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail || error.title || "The API could not return your security details.";
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the server. Check your connection and try again.";
  }
  if (error instanceof SecurityError || error instanceof DashboardError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The API could not return your security details.";
}

const MONTHS = [
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
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `12 Nov 2026, 09:00 UTC` for an ISO string or epoch milliseconds.
 *
 * Built by hand from UTC fields so the text is the same in every browser and
 * time zone (an audit trail should not shift with the reader's locale).
 * Returns `null` for anything that is not a date.
 */
export function formatInstant(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** `12 Nov 2026` (date only), in the reader's own time zone.
 *
 * A day shown without a zone label must be the reader's calendar day, as on
 * every other page: 18 Nov 19:20 UTC is 19 Nov for a reader in Sydney, and the
 * passkey card must not date the key a day early. The shared `formatDate` is
 * that one rule. Where the moment itself matters, {@link formatInstant} keeps
 * the time and its "UTC" label.
 */
export function formatDay(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return formatDate(typeof value === "number" ? new Date(value) : value);
}

/** The status line under the guardian count. */
export function describeGuardians(state: GuardianState): string {
  const set = guardiansSet(state);
  if (state.source === "unknown") {
    return "No guardians are recorded on this device. If you set them somewhere else, they are not shown here.";
  }
  if (set === 0) {
    return "You have not set any recovery guardians yet.";
  }
  if (set < state.total) {
    return `${set} of ${state.total} guardians set. Name ${state.total - set} more so any ${state.required} can recover your account.`;
  }
  return `All ${state.total} guardians set.`;
}

/** Where a guardian list came from, in words. Empty when the server confirmed it. */
export function describeGuardianSource(state: GuardianState): string | null {
  return state.source === "this-browser" ? "Saved from this browser." : null;
}
