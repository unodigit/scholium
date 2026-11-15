/**
 * Small byte/encoding helpers used by the device-key modules.
 *
 * Kept dependency-free and realm-agnostic (no `btoa`, no `Buffer`) so the same
 * code runs in the browser, in Node tests and during server rendering.
 */

import { DeviceKeyError } from "./errors";

/** Anything WebCrypto accepts as binary input. */
export type BinaryData = ArrayBuffer | ArrayBufferView;

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // `instanceof` fails across realms; the tag check is portable.
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/**
 * Normalise any binary input into an `ArrayBuffer`-backed `Uint8Array`.
 *
 * WebCrypto's `BufferSource` type excludes `SharedArrayBuffer`-backed views,
 * so a view that shares memory is copied rather than passed through.
 */
export function toUint8Array(
  value: BinaryData | Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    if (isArrayBuffer(value.buffer)) {
      return value as Uint8Array<ArrayBuffer>;
    }
    return Uint8Array.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (isArrayBuffer(value)) {
    return new Uint8Array(value);
  }
  throw new DeviceKeyError("invalid-encoding", "Expected binary data");
}

/** Constant-time-ish equality for short keys and ids. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}

/** Concatenate byte arrays. */
export function concatBytes(
  ...parts: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Lowercase hex encoding. */
export function toHex(bytes: BinaryData | Uint8Array): string {
  let out = "";
  for (const byte of toUint8Array(bytes)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decode a lowercase or uppercase hex string. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new DeviceKeyError("invalid-encoding", "Invalid hexadecimal string");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

/** Encode bytes as unpadded base64url (the encoding WebAuthn uses on the wire). */
export function toBase64Url(value: BinaryData | Uint8Array): string {
  const bytes = toUint8Array(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const byte0 = bytes[i];
    const byte1 = bytes[i + 1];
    const byte2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[byte0 >> 2];
    out += BASE64URL_ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    if (byte1 === undefined) {
      break;
    }
    out += BASE64URL_ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    if (byte2 === undefined) {
      break;
    }
    out += BASE64URL_ALPHABET[byte2 & 0x3f];
  }
  return out;
}

/**
 * Decode base64url (with or without padding).
 *
 * Standard base64 (`+`, `/`) is accepted too, because a few browser APIs have
 * historically emitted it; anything else raises `invalid-encoding`.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  let clean = text.trim().replace(/=+$/, "");
  clean = clean.replace(/\+/g, "-").replace(/\//g, "_");
  if (clean.length % 4 === 1) {
    throw new DeviceKeyError("invalid-encoding", "Invalid base64url string");
  }

  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE64URL_LOOKUP.get(character);
    if (value === undefined) {
      throw new DeviceKeyError("invalid-encoding", "Invalid base64url character");
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Decode UTF-8 bytes. */
export function utf8Decode(bytes: BinaryData | Uint8Array): string {
  return new TextDecoder().decode(toUint8Array(bytes));
}

/** Encode a string as UTF-8 bytes. */
export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
