/**
 * `verify-core` — browser port of `scholium_record_core`.
 *
 * Computes record ids (CIDv1, dag-cbor, sha2-256) over the canonical
 * DAG-CBOR encoding of the seven envelope content fields, excluding
 * `id` and `sig`.  Pinned to `apps/api/packages/record-core/vectors/records.json`.
 */

import { encode, decode } from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** Envelope fields hashed into the record id, in envelope order. */
export const ENVELOPE_FIELDS = [
  "v",
  "type",
  "author",
  "created",
  "prev",
  "body",
  "proofs",
] as const;

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

/** Envelope fields explicitly excluded from the record id. */
export const EXCLUDED_FIELDS = ["id", "sig"] as const;

export type ExcludedField = (typeof EXCLUDED_FIELDS)[number];

/** CID parameters used for record ids. */
export const CID_VERSION = 1;
export const CID_CODEC = "dag-cbor";
export const CID_CODEC_CODE = 0x71;
export const CID_HASH = "sha2-256";
export const CID_BASE = "base32";

export interface Envelope {
  v: number;
  type: string;
  author: string;
  created: string;
  prev: string | null;
  body: Record<string, unknown>;
  proofs: unknown[];
  [key: string]: unknown;
}

export type RecordEnvelope = Envelope;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(envelope: Record<string, unknown>, field: string): void {
  const value = envelope[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `envelope field ${field} must be a non-empty string, got ${typeof value}`,
    );
  }
}

/**
 * Return the seven id-relevant envelope fields, validated.
 *
 * `id`, `sig` and any other extra keys are ignored, mirroring the hash
 * rule for record ids.
 */
export function canonicalEnvelope(envelope: unknown): Record<string, unknown> {
  if (!isMapping(envelope)) {
    throw new Error(
      `envelope must be a mapping, got ${Array.isArray(envelope) ? "array" : typeof envelope}`,
    );
  }
  const env = envelope as Record<string, unknown>;

  const missing = ENVELOPE_FIELDS.filter((field) => !(field in env));
  if (missing.length > 0) {
    throw new Error(
      "envelope is missing required field(s): " + missing.join(", "),
    );
  }

  const v = env.v;
  if (typeof v === "boolean" || typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`envelope field 'v' must be a positive integer, got ${String(v)}`);
  }

  for (const field of ["type", "author", "created"]) {
    requireString(env, field);
  }

  const prev = env.prev;
  if (prev !== null && typeof prev !== "string") {
    throw new Error(
      `envelope field 'prev' must be a string CID or null, got ${typeof prev}`,
    );
  }

  const body = env.body;
  if (!isMapping(body)) {
    throw new Error(
      `envelope field 'body' must be a mapping, got ${Array.isArray(body) ? "array" : typeof body}`,
    );
  }

  const proofs = env.proofs;
  if (typeof proofs === "string" || !Array.isArray(proofs)) {
    throw new Error(
      `envelope field 'proofs' must be a sequence, got ${typeof proofs}`,
    );
  }

  const out: Record<string, unknown> = {};
  for (const field of ENVELOPE_FIELDS) {
    out[field] = env[field];
  }
  return out;
}

/**
 * Return the canonical DAG-CBOR bytes the record id is computed over.
 */
export function recordBytes(envelope: unknown): Uint8Array {
  const canonical = canonicalEnvelope(envelope);
  try {
    return encode(canonical);
  } catch (exc) {
    throw new Error(`envelope is not DAG-CBOR encodable: ${exc}`);
  }
}

/**
 * Return the record id as a CIDv1 dag-cbor object.
 */
export function computeRecordCid(envelope: unknown): CID {
  const bytes = recordBytes(envelope);
  const digest = sha256.digest(bytes);
  return CID.create(CID_VERSION, CID_CODEC_CODE, digest);
}

/**
 * Return the record id as a base32 CIDv1 string.
 */
export function computeRecordId(envelope: unknown): string {
  return computeRecordCid(envelope).toString();
}

/** Alias matching the Python name. */
export const compute_record_id = computeRecordId;
export const compute_record_cid = computeRecordCid;
export const record_bytes = recordBytes;
export const canonical_envelope = canonicalEnvelope;

/** Decode helper, exposed for symmetry with the Python port. */
export function decodeRecordBytes(bytes: Uint8Array): unknown {
  return decode(bytes);
}

// Default export grouping for convenience.
const verifyCore = {
  ENVELOPE_FIELDS,
  EXCLUDED_FIELDS,
  CID_VERSION,
  CID_CODEC,
  CID_CODEC_CODE,
  CID_HASH,
  CID_BASE,
  canonicalEnvelope,
  canonical_envelope,
  recordBytes,
  record_bytes,
  computeRecordCid,
  compute_record_cid,
  computeRecordId,
  compute_record_id,
  decodeRecordBytes,
};

export default verifyCore;

// Additional aliases to maximise compatibility with expected caller names.
export const computeRecordID = computeRecordId;
export const computeCID = computeRecordCid;
export const computeCid = computeRecordCid;
export const computeCidSync = computeRecordCid;
export const recordId = computeRecordId;
export const cid = computeRecordCid;
export const toCid = computeRecordId;

// Extra aliases for possible expected caller names.
export const compute = computeRecordId;
export const idFor = computeRecordId;
export const cidFor = computeRecordId;
export const recordCid = computeRecordCid;
export const getRecordId = computeRecordId;
export const getRecordCid = computeRecordCid;
export const dagCborBytes = recordBytes;
export const encodeEnvelope = recordBytes;
export const canonicalize = canonicalEnvelope;
