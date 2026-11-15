/**
 * Base58btc and `did:key` encoding for Ed25519 public keys.
 *
 * Scholium identifies accounts as `did:key:z6Mk…`; the `z` is the multibase
 * prefix for base58btc and `6Mk` comes from the `0xed 0x01` Ed25519 public-key
 * multicodec header. The device keeps only the private half, so this module is
 * what lets the public half become an account identifier.
 */

import { DeviceKeyError } from "./errors";
import { concatBytes, toUint8Array, type BinaryData } from "./encoding";
import { ED25519_PUBLIC_KEY_LENGTH } from "./webcrypto-ed25519";

/** Multicodec header (`ed25519-pub`, code 0xed, varint-encoded). */
export const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01);

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
);

/** Encode bytes as base58btc (Bitcoin alphabet, preserving leading zero bytes). */
export function encodeBase58(value: BinaryData | Uint8Array): string {
  const bytes = toUint8Array(value);
  if (bytes.length === 0) {
    return "";
  }

  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  // Little-endian base58 digits of the big-endian input value.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let end = digits.length;
  while (end > 0 && digits[end - 1] === 0) {
    end -= 1;
  }

  let out = "1".repeat(leadingZeros);
  for (let i = end - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

/** Decode a base58btc string. */
export function decodeBase58(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.trim();
  if (clean.length === 0) {
    return new Uint8Array(0);
  }

  let leadingZeros = 0;
  while (leadingZeros < clean.length && clean[leadingZeros] === "1") {
    leadingZeros += 1;
  }

  // Little-endian bytes of the decoded value.
  const bytes: number[] = [];
  for (const character of clean) {
    const value = BASE58_LOOKUP.get(character);
    if (value === undefined) {
      throw new DeviceKeyError("invalid-encoding", "Invalid base58 character");
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }

  const result = new Uint8Array(leadingZeros + end);
  for (let i = 0; i < end; i += 1) {
    result[leadingZeros + end - 1 - i] = bytes[i];
  }
  return result;
}

/**
 * Build a `did:key` identifier from a raw 32-byte Ed25519 public key.
 *
 * ```ts
 * didKeyFromEd25519PublicKey(raw); // "did:key:z6Mk…"
 * ```
 */
export function didKeyFromEd25519PublicKey(
  publicKey: BinaryData | Uint8Array,
): string {
  const raw = toUint8Array(publicKey);
  if (raw.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new DeviceKeyError(
      "invalid-key",
      `An Ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes`,
    );
  }
  const multikey = concatBytes(ED25519_MULTICODEC, raw);
  return `did:key:z${encodeBase58(multikey)}`;
}

/** Extract the raw Ed25519 public key from a `did:key` identifier. */
export function ed25519PublicKeyFromDidKey(did: string): Uint8Array {
  const prefix = "did:key:";
  if (!did.startsWith(prefix)) {
    throw new DeviceKeyError("invalid-encoding", "Not a did:key identifier");
  }
  const multibase = did.slice(prefix.length);
  if (!multibase.startsWith("z")) {
    throw new DeviceKeyError(
      "invalid-encoding",
      "Only base58btc (did:key:z…) identifiers are supported",
    );
  }
  const decoded = decodeBase58(multibase.slice(1));
  if (
    decoded.length !== ED25519_PUBLIC_KEY_LENGTH + ED25519_MULTICODEC.length ||
    decoded[0] !== ED25519_MULTICODEC[0] ||
    decoded[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new DeviceKeyError(
      "invalid-encoding",
      "did:key is not an Ed25519 public key",
    );
  }
  return decoded.slice(ED25519_MULTICODEC.length);
}

/** True when `did` is a syntactically valid Ed25519 `did:key`. */
export function isEd25519DidKey(did: unknown): did is string {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) {
    return false;
  }
  try {
    ed25519PublicKeyFromDidKey(did);
    return true;
  } catch {
    return false;
  }
}
