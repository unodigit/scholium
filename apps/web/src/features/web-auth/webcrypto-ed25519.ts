/**
 * Ed25519 through WebCrypto's `SubtleCrypto`.
 *
 * The device signing key is generated with `extractable: false`. Browsers still
 * make the *public* half exportable, which is what lets us publish a `did:key`,
 * but `subtle.exportKey` on the private half fails with `InvalidAccessError`.
 * That property — not a software convention — is what keeps the private key on
 * the device.
 */

import { DeviceKeyError, toDeviceKeyError } from "./errors";
import { toUint8Array, type BinaryData } from "./encoding";

/** The only signing algorithm this module supports. */
export const ED25519 = "Ed25519" as const;

/** Algorithm identifier passed to WebCrypto. */
export const ED25519_ALGORITHM: Readonly<{ name: typeof ED25519 }> = {
  name: ED25519,
};

/** Ed25519 public keys are 32 bytes. */
export const ED25519_PUBLIC_KEY_LENGTH = 32;

/** Ed25519 signatures are 64 bytes. */
export const ED25519_SIGNATURE_LENGTH = 64;

/** The two halves of a device signing key. */
export interface Ed25519KeyPair {
  /** Non-extractable signing key. */
  privateKey: CryptoKey;
  /** Exportable verification key. */
  publicKey: CryptoKey;
}

/**
 * The tiny slice of `globalThis.crypto` this module needs.
 *
 * Injectable so tests (and non-browser hosts) can supply their own
 * implementation, including a deliberately broken one.
 */
export interface CryptoProvider {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/** Low-level Ed25519 operations used by the device-key manager. */
export interface Ed25519Crypto {
  /** True when `subtle` and Ed25519 generation are present. */
  isSupported(): boolean;
  /** Generate a fresh key pair whose private half cannot be exported. */
  generateKeyPair(): Promise<Ed25519KeyPair>;
  /** Export the raw 32-byte public key. */
  exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array>;
  /** Import a raw 32-byte public key for verification. */
  importPublicKey(raw: BinaryData | Uint8Array): Promise<CryptoKey>;
  /** Sign bytes with the non-extractable private key. */
  sign(privateKey: CryptoKey, data: BinaryData | Uint8Array): Promise<Uint8Array>;
  /** Verify a signature against a public key. */
  verify(
    publicKey: CryptoKey,
    signature: BinaryData | Uint8Array,
    data: BinaryData | Uint8Array,
  ): Promise<boolean>;
  /** Cryptographically secure random bytes. */
  randomBytes(length?: number): Uint8Array;
}

/** Resolve the ambient WebCrypto implementation, or throw `unsupported`. */
export function resolveCrypto(provider?: CryptoProvider): CryptoProvider {
  const candidate = provider ?? (globalThis as { crypto?: CryptoProvider }).crypto;
  if (
    !candidate ||
    !candidate.subtle ||
    typeof candidate.subtle.generateKey !== "function" ||
    typeof candidate.getRandomValues !== "function"
  ) {
    throw new DeviceKeyError(
      "unsupported",
      "WebCrypto is unavailable. Use a secure (https) context in a modern browser.",
    );
  }
  return candidate;
}

/** Throws `unsupported` unless Ed25519 key generation is available. */
export function isEd25519Supported(provider?: CryptoProvider): boolean {
  try {
    const resolved = resolveCrypto(provider);
    return typeof resolved.subtle.generateKey === "function";
  } catch {
    return false;
  }
}

/**
 * Refuse a key that could leave the device.
 *
 * Called before persisting and again after loading: if anything ever wrote an
 * extractable private key into IndexedDB, we would rather fail loudly than
 * sign with a key that can be copied out.
 */
export function assertNonExtractablePrivateKey(privateKey: CryptoKey): void {
  if (!privateKey || typeof privateKey !== "object") {
    throw new DeviceKeyError("invalid-key", "The device key has no private half");
  }
  if (privateKey.extractable !== false) {
    throw new DeviceKeyError(
      "invalid-key",
      "Refusing to use an Ed25519 private key that can be exported",
    );
  }
  if (!Array.isArray(privateKey.usages) || !privateKey.usages.includes("sign")) {
    throw new DeviceKeyError(
      "invalid-key",
      "The device private key cannot sign",
    );
  }
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return (
    typeof value === "object" &&
    value !== null &&
    "privateKey" in value &&
    "publicKey" in value
  );
}

/** Create an {@link Ed25519Crypto} bound to `provider` (defaults to ambient WebCrypto). */
export function createEd25519Crypto(provider?: CryptoProvider): Ed25519Crypto {
  const subtle = (): SubtleCrypto => resolveCrypto(provider).subtle;

  return {
    isSupported() {
      return isEd25519Supported(provider);
    },

    async generateKeyPair(): Promise<Ed25519KeyPair> {
      let generated: CryptoKey | CryptoKeyPair;
      try {
        generated = await subtle().generateKey(ED25519_ALGORITHM, false, [
          "sign",
          "verify",
        ]);
      } catch (error) {
        throw toDeviceKeyError(
          error,
          "unsupported",
          "This browser cannot create an Ed25519 signing key",
        );
      }
      if (!isCryptoKeyPair(generated)) {
        throw new DeviceKeyError(
          "invalid-key",
          "WebCrypto returned an unexpected Ed25519 key",
        );
      }
      assertNonExtractablePrivateKey(generated.privateKey);
      return {
        privateKey: generated.privateKey,
        publicKey: generated.publicKey,
      };
    },

    async exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
      try {
        const raw = await subtle().exportKey("raw", publicKey);
        const bytes = toUint8Array(raw);
        if (bytes.length !== ED25519_PUBLIC_KEY_LENGTH) {
          throw new DeviceKeyError(
            "invalid-key",
            `Expected a ${ED25519_PUBLIC_KEY_LENGTH}-byte Ed25519 public key`,
          );
        }
        return bytes;
      } catch (error) {
        throw toDeviceKeyError(
          error,
          "invalid-key",
          "Could not export the device public key",
        );
      }
    },

    async importPublicKey(raw: BinaryData | Uint8Array): Promise<CryptoKey> {
      const bytes = toUint8Array(raw);
      if (bytes.length !== ED25519_PUBLIC_KEY_LENGTH) {
        throw new DeviceKeyError(
          "invalid-key",
          `Expected a ${ED25519_PUBLIC_KEY_LENGTH}-byte Ed25519 public key`,
        );
      }
      try {
        return await subtle().importKey(
          "raw",
          bytes,
          ED25519_ALGORITHM,
          true,
          ["verify"],
        );
      } catch (error) {
        throw toDeviceKeyError(
          error,
          "invalid-key",
          "Could not import the Ed25519 public key",
        );
      }
    },

    async sign(
      privateKey: CryptoKey,
      data: BinaryData | Uint8Array,
    ): Promise<Uint8Array> {
      assertNonExtractablePrivateKey(privateKey);
      try {
        return new Uint8Array(
          await subtle().sign(ED25519_ALGORITHM, privateKey, toUint8Array(data)),
        );
      } catch (error) {
        throw toDeviceKeyError(error, "signing-failed", "Could not sign with the device key");
      }
    },

    async verify(
      publicKey: CryptoKey,
      signature: BinaryData | Uint8Array,
      data: BinaryData | Uint8Array,
    ): Promise<boolean> {
      const signatureBytes = toUint8Array(signature);
      if (signatureBytes.length !== ED25519_SIGNATURE_LENGTH) {
        return false;
      }
      try {
        return await subtle().verify(
          ED25519_ALGORITHM,
          publicKey,
          signatureBytes,
          toUint8Array(data),
        );
      } catch (error) {
        throw toDeviceKeyError(
          error,
          "signing-failed",
          "Could not verify the Ed25519 signature",
        );
      }
    },

    randomBytes(length = 32): Uint8Array {
      if (!Number.isInteger(length) || length <= 0) {
        throw new DeviceKeyError("invalid-key", "Random byte length must be positive");
      }
      return resolveCrypto(provider).getRandomValues(new Uint8Array(length));
    },
  };
}

/** Default implementation backed by the browser's `crypto.subtle`. */
export const ed25519Crypto: Ed25519Crypto = createEd25519Crypto();
