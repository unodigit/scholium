/**
 * The "Rotate key" action on `/me/security`.
 *
 * A rotation hands the account to a new signing key with one signed record:
 *
 * ```text
 * 1. create a replacement key + passkey, kept in memory   (passkey prompt)
 * 2. sign key.rotation {oldKey, newKey, effectiveAt, reason}
 *    with the CURRENT key                                  (passkey prompt)
 * 3. POST /v1/records                       -> the old key is retired server-side
 * 4. only now, save the replacement as this device's key
 *    (with the account DID it signs for)
 * ```
 *
 * The account's DID does not change, but the key does, so the replacement's own
 * did:key is not the account's DID. Step 4 therefore saves the account DID
 * beside the key: sign-in sends it, and the server checks the replacement's
 * signature against the account's new active key, so the member signs back
 * into the account they rotated instead of a new, empty one.
 *
 * The order is the safety property. Until step 3 succeeds the stored key is
 * untouched, so every failure before it leaves the account exactly as it was.
 * Step 3 is the point of no return: the server will refuse the old key from
 * then on, so the replacement is saved to this device straight afterwards, and
 * a failure there is reported as the serious thing it is (the account rotated,
 * this device lost the key) with the recovery flow as the way back.
 *
 * A network failure at step 3 is ambiguous: the record may have landed with
 * only the reply lost. Rather than guess, the account's active key is read
 * back; if it is the replacement the rotation went through and step 4 runs.
 *
 * Every side effect is a seam so the flow is tested without a browser, a
 * passkey or a server; {@link defaultRotationSeams} wires the real ones.
 */

import { ApiError, api } from "../../lib/api";
import {
  DEFAULT_PASSKEY_DISPLAY_NAME,
  DEFAULT_PASSKEY_USER_NAME,
  DeviceKeyManager,
  MemoryDeviceKeyStorage,
  createDeviceKeyStorage,
  isPasskeyCancellation,
  signRecord,
  type DeviceKeyManagerOptions,
  type DeviceKeyStorage,
  type SignedRecord,
} from "../web-auth";

import { didEndpoint, parseKeyState } from "./security";

/** Record type a rotation is submitted as. */
export const KEY_ROTATION_RECORD_TYPE = "key.rotation";

/** Longest reason the form accepts. */
export const ROTATION_REASON_MAX_LENGTH = 200;

/** Why a rotation did not complete. */
export type RotationErrorCode =
  /** This device's key is not the account's active key, so it cannot sign the hand-over. */
  | "not-active-key"
  /** This browser cannot make and keep a new key (no Ed25519, passkeys or IndexedDB). */
  | "unsupported"
  /** The member dismissed a passkey prompt. Nothing changed. */
  | "cancelled"
  /** The replacement key could not be created. Nothing changed. */
  | "replacement-failed"
  /** The rotation record could not be signed. Nothing changed. */
  | "signing-failed"
  /** The server answered and refused the rotation. Nothing changed. */
  | "rejected"
  /** The server could not be reached and did not record the rotation. Nothing changed. */
  | "unreachable"
  /** The server could not be reached and it is not known whether the rotation went through. */
  | "unknown-outcome"
  /** The rotation went through but the new key could not be saved on this device. */
  | "install-failed";

/** Codes after which the account may already have rotated: do not offer a retry. */
export const TERMINAL_ROTATION_CODES: readonly RotationErrorCode[] = [
  "unknown-outcome",
  "install-failed",
];

/** A rotation that did not complete; {@link code} says how far it got. */
export class RotationError extends Error {
  readonly code: RotationErrorCode;

  constructor(code: RotationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RotationError";
    this.code = code;
  }
}

/** Type guard for {@link RotationError}. */
export function isRotationError(error: unknown): error is RotationError {
  return error instanceof RotationError;
}

/** A replacement key that exists in memory and is not yet this device's key. */
export interface ReplacementKey {
  /** `did:key` of the replacement. */
  readonly did: string;
  /**
   * Save it as this device's key, signing for `accountDid`. Call only after
   * the server accepted the rotation.
   */
  install(accountDid: string): Promise<void>;
}

/** Every side effect the rotation performs. */
export interface RotationSeams {
  /** Create the replacement key and its passkey without touching the stored key. */
  createReplacement(): Promise<ReplacementKey>;
  /** Sign a record with the current key behind a passkey prompt. */
  sign(
    type: string,
    body: Record<string, unknown>,
    prev: string | null,
  ): Promise<SignedRecord>;
  /** Send the signed record to the server. */
  submit(record: SignedRecord): Promise<unknown>;
  /** The account's active key according to the server (for ambiguous failures). */
  readActiveKey(accountDid: string): Promise<string>;
  /** Epoch milliseconds. */
  now(): number;
}

/** What a rotation needs to know. */
export interface RotateKeyInput {
  /** The account's DID. */
  accountDid: string;
  /** The key the server says signs for the account. */
  activeKey: string;
  /** `did:key` of this device's key. Must equal {@link activeKey}. */
  deviceDid: string;
  /** Id of the account's latest `key.rotation` record, or `null` for the first. */
  prev: string | null;
  /** Why, in the member's words. Optional. */
  reason?: string;
  /** Replace any seam, for tests. */
  seams?: Partial<RotationSeams>;
}

/** A completed rotation. */
export interface RotationResult {
  /** Id of the accepted `key.rotation` record. */
  recordId: string;
  /** `did:key` of the key now active for the account. */
  newKey: string;
}

/** The function the page calls; {@link rotateKey} by default, replaceable in tests. */
export type RotateKey = (input: RotateKeyInput) => Promise<RotationResult>;

/** What {@link createReplacementKey} builds on; the defaults are the browser's own. */
export interface ReplacementKeyDeps {
  /** Where the replacement is saved on install; defaults to the device key store. */
  target?: DeviceKeyStorage;
  /** Passkeys, crypto and relying party for the new key (tests inject fakes). */
  managerOptions?: Omit<DeviceKeyManagerOptions, "storage">;
}

/** Create a replacement key in memory; refuse up front if it could not be kept. */
export async function createReplacementKey(
  deps: ReplacementKeyDeps = {},
): Promise<ReplacementKey> {
  const target = deps.target ?? createDeviceKeyStorage();
  if (target.kind !== "indexeddb") {
    // Without IndexedDB the new key could not outlive this tab, and the old
    // one is about to be retired. Refuse before anything irreversible happens.
    throw new RotationError(
      "unsupported",
      "This browser cannot keep a new key (storage is unavailable), so the key was not rotated.",
    );
  }

  const staging = new MemoryDeviceKeyStorage();
  const manager = new DeviceKeyManager({ ...deps.managerOptions, storage: staging });
  if (!manager.isSupported()) {
    throw new RotationError(
      "unsupported",
      "This browser cannot create a new passkey-protected key, so the key was not rotated.",
    );
  }
  await manager.create({
    userName: DEFAULT_PASSKEY_USER_NAME,
    userDisplayName: DEFAULT_PASSKEY_DISPLAY_NAME,
    skipUnlock: true,
  });
  const record = await staging.get();
  if (record === null) {
    throw new RotationError("replacement-failed", "The new key was not created.");
  }
  const did = await manager.didKey();
  return {
    did,
    // The staged record names the replacement's own did:key as its account; the
    // account it replaces the key of is the one the device must sign in as.
    install: (accountDid) => target.put({ ...record, accountDid }),
  };
}

/** The real seams: web-auth's key and signer, and the shared API client. */
export function defaultRotationSeams(): RotationSeams {
  return {
    createReplacement: createReplacementKey,
    sign: (type, body, prev) => signRecord(type, body, prev),
    submit: (record) => api.post<unknown>("/records", record),
    readActiveKey: async (accountDid) =>
      parseKeyState(await api.get<unknown>(didEndpoint(accountDid), { cache: "no-store" }))
        .activeKey,
    now: () => Date.now(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "an unknown error";
}

/** `text` as a sentence: one closing full stop, whatever the source did. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** `2026-11-14T05:33:00Z`: second precision, as the API's records use. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Rotate the account's signing key.
 *
 * @throws {RotationError} with a {@link RotationErrorCode}; for every code
 *   except `unknown-outcome` and `install-failed` the account is unchanged.
 */
export async function rotateKey(input: RotateKeyInput): Promise<RotationResult> {
  const seams: RotationSeams = { ...defaultRotationSeams(), ...input.seams };

  // Only the key being retired may sign the record that retires it.
  if (input.deviceDid !== input.activeKey) {
    throw new RotationError(
      "not-active-key",
      "This device does not hold your current signing key, so it cannot rotate it.",
    );
  }

  let replacement: ReplacementKey;
  try {
    replacement = await seams.createReplacement();
  } catch (error) {
    if (isRotationError(error)) {
      throw error;
    }
    if (isPasskeyCancellation(error)) {
      throw new RotationError("cancelled", "The passkey prompt was dismissed.", { cause: error });
    }
    throw new RotationError(
      "replacement-failed",
      `The new key could not be created: ${sentence(messageOf(error))}`,
      { cause: error },
    );
  }

  const reason = input.reason?.trim().slice(0, ROTATION_REASON_MAX_LENGTH) ?? "";
  const body: Record<string, unknown> = {
    oldKey: input.deviceDid,
    newKey: replacement.did,
    effectiveAt: isoSeconds(seams.now()),
    ...(reason ? { reason } : {}),
  };

  let record: SignedRecord;
  try {
    record = await seams.sign(KEY_ROTATION_RECORD_TYPE, body, input.prev);
  } catch (error) {
    if (isPasskeyCancellation(error)) {
      throw new RotationError("cancelled", "The passkey prompt was dismissed.", { cause: error });
    }
    throw new RotationError(
      "signing-failed",
      `The rotation could not be signed: ${sentence(messageOf(error))}`,
      { cause: error },
    );
  }

  try {
    await seams.submit(record);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new RotationError("rejected", error.detail || error.title, { cause: error });
    }
    // No answer: the record may still have landed. Ask the server which key is active.
    let activeKey: string | null = null;
    try {
      activeKey = await seams.readActiveKey(input.accountDid);
    } catch {
      activeKey = null;
    }
    if (activeKey === null) {
      throw new RotationError(
        "unknown-outcome",
        "The server could not be reached, so it is not known whether the rotation went through.",
        { cause: error },
      );
    }
    if (activeKey !== replacement.did) {
      throw new RotationError(
        "unreachable",
        "The server could not be reached and did not record the rotation.",
        { cause: error },
      );
    }
    // The reply was lost but the rotation landed: carry on and save the key.
  }

  try {
    await replacement.install(input.accountDid);
  } catch (error) {
    throw new RotationError(
      "install-failed",
      "Your key was rotated, but the new key could not be saved on this device.",
      { cause: error },
    );
  }

  return { recordId: record.id, newKey: replacement.did };
}

/**
 * The page's words for a failed rotation. Every message starts with what
 * happened to the account, because that is the question the reader has.
 */
export function describeRotationError(error: unknown): string {
  if (!isRotationError(error)) {
    return `The key was not rotated: ${sentence(messageOf(error))}`;
  }
  switch (error.code) {
    case "cancelled":
      return "Rotation cancelled. Nothing changed: your current key still works.";
    case "not-active-key":
      return "This device does not hold your current signing key, so it cannot rotate it. Rotate from the device you signed in on, or recover your account.";
    case "unsupported":
    case "replacement-failed":
    case "signing-failed":
      return `${sentence(error.message)} Nothing changed: your current key still works.`;
    case "rejected":
      return `The server did not accept the rotation: ${sentence(error.message)} Nothing changed: your current key still works.`;
    case "unreachable":
      return "Scholium could not reach the server and the rotation was not recorded. Nothing changed: your current key still works. Check your connection and try again.";
    case "unknown-outcome":
      return "Scholium could not reach the server, so it cannot tell whether the rotation went through. Reload this page: if it shows a new rotation, your key changed on the server and this device may no longer hold the right key. If it does not, nothing changed. If you are locked out, recover your account.";
    case "install-failed":
      return "Your key was rotated, but the new key could not be saved on this device, so this device can no longer sign for your account. Use “Lost your device?” to recover your account with your guardians.";
  }
}
