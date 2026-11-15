/**
 * Ed25519 signing and verification over the canonical envelope bytes.
 *
 * Browser port of `scholium_record_core.signing`, pinned to
 * `apps/api/packages/record-core/vectors/signatures.json`.
 *
 * A record is signed over {@link recordBytes} -- the DAG-CBOR encoding of
 * the seven content fields `v`, `type`, `author`, `created`, `prev`, `body`
 * and `proofs`, exactly the bytes the record id is hashed over.  `id` and
 * `sig` are excluded, so re-signing never changes the id, and any change to
 * a content field makes the signature fail.
 *
 * Signatures are 64 raw bytes carried as unpadded base64url text.  Authors
 * are `did:key` identifiers: base58btc multibase (`z`) over
 * `0xed 0x01 || public_key`, the `ed25519-pub` multicodec header followed by
 * the raw 32-byte key.
 *
 * Verification is a predicate: every {@link verifyEnvelope} and
 * {@link verifyRecord} failure returns `false` rather than raising.  Only
 * the derivation helpers throw on malformed input.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { base58btc } from "multiformats/bases/base58";

import { computeRecordId, recordBytes } from "./envelope";

// @noble/ed25519 v2 verifies synchronously when it is given a SHA-512
// implementation.  Wire the pure-JS hash once, so the verifier works in a
// browser, in Node and in a JSDOM test alike, with no `crypto.subtle`.
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  sha512(ed.etc.concatBytes(...messages));

/** Byte length of a raw Ed25519 public key. */
export const ED25519_PUBLIC_KEY_LENGTH = 32;

/** Byte length of an Ed25519 seed (the signing-key input). */
export const ED25519_SEED_LENGTH = 32;

/** Byte length of a raw Ed25519 signature. */
export const ED25519_SIGNATURE_LENGTH = 64;

/** `ed25519-pub` multicodec header (code 0xed, varint-encoded). */
export const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01);

/** Prefix every Ed25519 did:key starts with (`z` = base58btc multibase). */
export const DID_KEY_PREFIX = "did:key:z";

/** did:key prefix without the multibase character. */
export const DID_KEY_SCHEME_PREFIX = "did:key:";

/** Text encoding of the `sig` envelope member. */
export const SIG_ENCODING = "base64url-unpadded";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Return `value` as a `Uint8Array` in this realm, or `null`.
 *
 * `instanceof` fails across realms (a Node `Buffer` under JSDOM, say), so
 * binary input is recognised by its internal slots and copied when needed.
 */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value as ArrayBuffer);
  }
  return null;
}

function show(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Return the raw 32-byte Ed25519 public key encoded by a did:key identifier.
 *
 * Only base58btc (`did:key:z...`) Ed25519 identifiers are accepted.
 *
 * @throws {Error} if `did` is not a valid Ed25519 did:key.
 */
export function publicKeyFromDidKey(did: unknown): Uint8Array {
  if (typeof did !== "string") {
    throw new Error(
      `a did:key identifier must be a string, got ${typeof did}`,
    );
  }
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new Error(
      `not an Ed25519 did:key identifier (expected ${JSON.stringify(
        DID_KEY_PREFIX,
      )} prefix): ${show(did)}`,
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = base58btc.decode(did.slice(DID_KEY_SCHEME_PREFIX.length));
  } catch (cause) {
    throw new Error(
      `did:key identifier is not valid base58btc: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    decoded.length !==
      ED25519_MULTICODEC.length + ED25519_PUBLIC_KEY_LENGTH ||
    decoded[0] !== ED25519_MULTICODEC[0] ||
    decoded[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new Error(
      "did:key identifier does not encode an Ed25519 public key " +
        "(expected the ed25519-pub multicodec header and " +
        `${ED25519_PUBLIC_KEY_LENGTH} key bytes)`,
    );
  }
  return decoded.slice(ED25519_MULTICODEC.length);
}

/** Return True when `did` is a valid Ed25519 did:key identifier. */
export function isEd25519DidKey(did: unknown): did is string {
  if (typeof did !== "string") {
    return false;
  }
  try {
    publicKeyFromDidKey(did);
  } catch {
    return false;
  }
  return true;
}

/** Return the did:key identifier of a raw Ed25519 public key. */
export function didKeyFromPublicKey(publicKey: unknown): string {
  if (
    !(publicKey instanceof Uint8Array) ||
    publicKey.length !== ED25519_PUBLIC_KEY_LENGTH
  ) {
    const got =
      publicKey instanceof Uint8Array
        ? `${publicKey.length} bytes`
        : typeof publicKey;
    throw new Error(
      `an Ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${got}`,
    );
  }
  const multikey = new Uint8Array(
    ED25519_MULTICODEC.length + publicKey.length,
  );
  multikey.set(ED25519_MULTICODEC, 0);
  multikey.set(publicKey, ED25519_MULTICODEC.length);
  return DID_KEY_SCHEME_PREFIX + base58btc.encode(multikey);
}

/** Return the did:key identifier of an Ed25519 seed (32 raw bytes). */
export function didKeyFromSeed(seed: unknown): string {
  if (!(seed instanceof Uint8Array) || seed.length !== ED25519_SEED_LENGTH) {
    const got =
      seed instanceof Uint8Array ? `${seed.length} bytes` : typeof seed;
    throw new Error(
      `an Ed25519 seed must be ${ED25519_SEED_LENGTH} bytes, got ${got}`,
    );
  }
  return didKeyFromPublicKey(ed.getPublicKey(seed));
}

/**
 * Decode the raw 64 signature bytes carried by a `sig` member.
 *
 * Accepts unpadded base64url text (a trailing `=` padding is tolerated) or
 * 64 raw bytes.
 *
 * @throws {Error} if `signature` is neither form or is not 64 bytes.
 */
export function decodeSignature(signature: unknown): Uint8Array {
  const rawBytes = asBytes(signature);
  if (rawBytes !== null) {
    if (rawBytes.length !== ED25519_SIGNATURE_LENGTH) {
      throw new Error(
        `an Ed25519 signature must be ${ED25519_SIGNATURE_LENGTH} bytes, got ${rawBytes.length}`,
      );
    }
    return rawBytes;
  }
  if (typeof signature === "string") {
    const text = signature.trim();
    const stripped = text.replace(/=+$/, "");
    if (text.length - stripped.length > 2 || stripped.length === 0) {
      throw new Error(
        `signature must be unpadded base64url text, got ${show(signature)}`,
      );
    }
    const bytes: number[] = [];
    let accumulator = 0;
    let bits = 0;
    for (const character of stripped) {
      const value = BASE64URL_LOOKUP.get(character);
      if (value === undefined) {
        throw new Error(
          `signature must be unpadded base64url text, got ${show(signature)}`,
        );
      }
      accumulator = (accumulator << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((accumulator >> bits) & 0xff);
      }
    }
    if (bytes.length !== ED25519_SIGNATURE_LENGTH) {
      throw new Error(
        `an Ed25519 signature must be ${ED25519_SIGNATURE_LENGTH} bytes, got ${bytes.length}`,
      );
    }
    return Uint8Array.from(bytes);
  }
  throw new Error(
    `signature must be base64url text or raw bytes, got ${
      signature === null ? "None" : typeof signature
    }`,
  );
}

/** Encode a raw 64-byte Ed25519 signature as unpadded base64url text. */
export function encodeSignature(signature: unknown): string {
  if (
    !(signature instanceof Uint8Array) ||
    signature.length !== ED25519_SIGNATURE_LENGTH
  ) {
    const got =
      signature instanceof Uint8Array
        ? `${signature.length} bytes`
        : typeof signature;
    throw new Error(
      `an Ed25519 signature must be ${ED25519_SIGNATURE_LENGTH} bytes, got ${got}`,
    );
  }
  let out = "";
  for (let i = 0; i < signature.length; i += 3) {
    const b0 = signature[i];
    const b1 = signature[i + 1];
    const b2 = signature[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Sign the canonical bytes of `envelope` with an Ed25519 seed.
 *
 * Returns the signature as unpadded base64url, ready for the envelope's
 * `sig` member.  The signed bytes are exactly {@link recordBytes}, so `id`
 * and `sig` members on `envelope` are ignored.
 */
export function signEnvelope(envelope: unknown, seed: unknown): string {
  const seedBytes = asBytes(seed);
  if (
    seedBytes === null ||
    seedBytes.length !== ED25519_SEED_LENGTH
  ) {
    const got =
      seedBytes !== null ? `${seedBytes.length} bytes` : typeof seed;
    throw new Error(
      `an Ed25519 seed must be ${ED25519_SEED_LENGTH} bytes, got ${got}`,
    );
  }
  return encodeSignature(ed.sign(recordBytes(envelope), seedBytes));
}

/**
 * Return True when `signature` authenticates `envelope`.
 *
 * The signature is checked over {@link recordBytes}.  `didKey` is the
 * signer: a did:key identifier, a raw 32-byte public key, or `null` to use
 * the envelope's own `author`.
 *
 * Every failure mode -- invalid envelope, unparseable signature or did,
 * wrong key, bad signature -- returns `false`; nothing raises.
 */
export function verifyEnvelope(
  envelope: unknown,
  signature: unknown,
  didKey?: unknown,
): boolean {
  try {
    const data = recordBytes(envelope);
    const rawSignature = decodeSignature(signature);
    let publicKey: Uint8Array;
    const signer = didKey ?? (isMapping(envelope) ? envelope.author : undefined);
    if (typeof signer === "string") {
      publicKey = publicKeyFromDidKey(signer);
    } else {
      const signerBytes = asBytes(signer);
      if (
        signerBytes === null ||
        signerBytes.length !== ED25519_PUBLIC_KEY_LENGTH
      ) {
        return false;
      }
      publicKey = signerBytes;
    }
    return ed.verify(rawSignature, data, publicKey);
  } catch {
    return false;
  }
}

/**
 * Return True when `record` is a complete, intact signed record.
 *
 * Checks that `id` matches the recomputed record id and that `sig` verifies
 * over the canonical bytes against the record's `author` did:key.
 */
export function verifyRecord(record: unknown): boolean {
  if (!isMapping(record)) {
    return false;
  }
  try {
    if (computeRecordId(record) !== record.id) {
      return false;
    }
  } catch {
    return false;
  }
  return verifyEnvelope(record, record.sig);
}

// Aliases matching the Python names.
export const public_key_from_did_key = publicKeyFromDidKey;
export const is_ed25519_did_key = isEd25519DidKey;
export const did_key_from_public_key = didKeyFromPublicKey;
export const did_key_from_seed = didKeyFromSeed;
export const decode_signature = decodeSignature;
export const encode_signature = encodeSignature;
export const sign_envelope = signEnvelope;
export const verify_envelope = verifyEnvelope;
export const verify_record = verifyRecord;
