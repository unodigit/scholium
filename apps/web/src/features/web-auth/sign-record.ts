/**
 * `signRecord(type, body, prev)` — build a record envelope, identify it with
 * verify-core and sign it with the device key behind a passkey prompt.
 *
 * ```ts
 * const record = await signRecord("paper.version", { title: "…" }, previousId);
 * // {
 * //   v: 1, type: "paper.version", id: "bafyrei…", author: "did:key:z6Mk…",
 * //   created: "2026-11-14T05:33:00Z", prev: previousId, body: { … },
 * //   proofs: [], sig: "<base64url Ed25519 signature>"
 * // }
 * ```
 *
 * What is signed
 * --------------
 * The envelope's seven content fields (`v`, `type`, `author`, `created`,
 * `prev`, `body`, `proofs`) are hashed by verify-core into the record id, a
 * CIDv1 (dag-cbor, sha2-256). The signature is Ed25519 over the **binary CID
 * bytes** (`CID.bytes`, not the base32 string). The CID commits to every
 * content field, so the signature does too. `id` and `sig` are excluded from
 * the hash, so signing never changes the id. `sig` is unpadded base64url.
 *
 * Order of operations
 * -------------------
 * 1. Read the author's `did:key` (no prompt; fails fast with `not-found`).
 * 2. Build the envelope and compute its id. A malformed record fails here with
 *    a {@link RecordSigningError}, **before** the user is asked for anything.
 * 3. Show the "Sign and submit" passkey prompt and sign. Every call prompts,
 *    even when the key is still unlocked from an earlier prompt: one
 *    submission, one human approval.
 */

import { toBase64Url } from "./encoding";
import { toDeviceKeyError, RecordSigningError } from "./errors";
import {
  deviceKey,
  type UnlockDeviceKeyOptions,
} from "./device-key";

/** Envelope version written into every record this module signs. */
export const RECORD_ENVELOPE_VERSION = 1;

/** Prompt reason passed to the device key for every signature. */
export const SIGN_AND_SUBMIT_REASON = "Sign and submit";

/** The part of a CID that signing needs; satisfied by `multiformats`' `CID`. */
export interface RecordCid {
  /** Binary CID: version, codec and multihash. This is what gets signed. */
  readonly bytes: Uint8Array;
  /** The record id string (base32 CIDv1). */
  toString(): string;
}

/** Computes a record's CID from its envelope; verify-core's `computeRecordCid`. */
export type ComputeRecordCid = (envelope: unknown) => RecordCid | Promise<RecordCid>;

/** The slice of {@link DeviceKeyManager} that `signRecord` relies on. */
export interface RecordSigner {
  /** The `did:key` of the signing key. Must not prompt. */
  didKey(): Promise<string>;
  /** Prompt for the passkey, then sign `data` with the device key. */
  signWithPasskey(
    data: Uint8Array,
    options?: UnlockDeviceKeyOptions,
  ): Promise<Uint8Array>;
}

/** A complete, signed record envelope ready to submit. */
export interface SignedRecord<
  TBody extends Record<string, unknown> = Record<string, unknown>,
> {
  v: number;
  type: string;
  /** CIDv1 (dag-cbor, sha2-256, base32) over the seven content fields. */
  id: string;
  /** `did:key` of the device key that signed. */
  author: string;
  /** UTC timestamp, second precision, e.g. `2026-11-14T05:33:00Z`. */
  created: string;
  /** Id of the previous record in the chain, or `null` for a genesis record. */
  prev: string | null;
  body: TBody;
  proofs: unknown[];
  /** Unpadded base64url Ed25519 signature over the binary CID. */
  sig: string;
}

/** Options for {@link signRecord}. */
export interface SignRecordOptions {
  /** Signing key; defaults to the app-wide {@link deviceKey}. */
  signer?: RecordSigner;
  /** Credentials or verifiable presentations to attach (hashed and signed). */
  proofs?: unknown[];
  /** Clock in epoch milliseconds, injectable for tests. */
  now?: () => number;
  /** Record id function; defaults to verify-core's `computeRecordCid`. */
  computeRecordCid?: ComputeRecordCid;
  /** Passkey prompt reason; defaults to {@link SIGN_AND_SUBMIT_REASON}. */
  reason?: string;
  /** Passkey prompt timeout. */
  timeoutMs?: number;
}

/** Load verify-core on first use so `dag-cbor` stays out of the sign-in bundle. */
async function loadComputeRecordCid(): Promise<ComputeRecordCid> {
  try {
    const core = await import("../verify-core");
    return core.computeRecordCid;
  } catch (cause) {
    throw new RecordSigningError(
      "record-id-failed",
      "verify-core could not be loaded, so the record id cannot be computed",
      { cause },
    );
  }
}

/** `2026-11-14T05:33:00Z`: ISO 8601 UTC at second precision, as in the record vectors. */
function formatCreated(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy `value` so the signed envelope cannot drift from its id and signature
 * if the caller keeps mutating the objects it passed in.
 */
function snapshot<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new RecordSigningError(
      "invalid-record",
      `The record ${label} cannot be copied: ${describeError(cause)}`,
      { cause },
    );
  }
}

/**
 * Build, identify and sign a record.
 *
 * @param type  Record type, e.g. `paper.version`.
 * @param body  Type-specific payload; must be DAG-CBOR encodable.
 * @param prev  Id of the previous record in the chain, or `null` to start one.
 *              Required: omitting it would silently fork a chain.
 * @throws {RecordSigningError} the record is invalid or has no id (no prompt shown).
 * @throws {DeviceKeyError} no device key (`not-found`), the prompt was dismissed
 *   (`passkey-cancelled`), the passkey did not verify (`passkey-failed`) or
 *   signing failed (`signing-failed`).
 */
export async function signRecord<
  TBody extends Record<string, unknown> = Record<string, unknown>,
>(
  type: string,
  body: TBody,
  prev: string | null,
  options: SignRecordOptions = {},
): Promise<SignedRecord<TBody>> {
  if (prev === "") {
    throw new RecordSigningError(
      "invalid-record",
      "prev must be the id of the previous record, or null to start a chain",
    );
  }

  const signer = options.signer ?? deviceKey;
  const now = options.now ?? (() => Date.now());

  // No prompt yet: a missing device key fails here, cheaply.
  const author = await signer.didKey();

  const envelope = {
    v: RECORD_ENVELOPE_VERSION,
    type,
    author,
    created: formatCreated(now()),
    prev,
    body: snapshot(body, "body"),
    proofs: snapshot(options.proofs ?? [], "proofs"),
  };

  const computeRecordCid =
    options.computeRecordCid ?? (await loadComputeRecordCid());
  let cid: RecordCid;
  try {
    cid = await computeRecordCid(envelope);
  } catch (cause) {
    throw new RecordSigningError(
      "invalid-record",
      `The record is not valid: ${describeError(cause)}`,
      { cause },
    );
  }

  let signature: Uint8Array;
  try {
    signature = await signer.signWithPasskey(cid.bytes, {
      reason: options.reason ?? SIGN_AND_SUBMIT_REASON,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw toDeviceKeyError(
      error,
      "signing-failed",
      "Could not sign the record with the device key",
    );
  }

  return {
    v: envelope.v,
    type: envelope.type,
    id: cid.toString(),
    author: envelope.author,
    created: envelope.created,
    prev: envelope.prev,
    body: envelope.body,
    proofs: envelope.proofs,
    sig: toBase64Url(signature),
  };
}
