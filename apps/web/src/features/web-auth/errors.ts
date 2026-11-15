/**
 * Errors raised by the WebAuthn-gated device signing key.
 *
 * Every failure a caller can act on has a stable {@link DeviceKeyErrorCode} so
 * UI code can branch on the failure without matching message text (for
 * example, "the user dismissed the passkey sheet" versus "this browser has no
 * Ed25519 support").
 */

/** Stable, machine-readable failure codes. */
export type DeviceKeyErrorCode =
  /** The runtime cannot produce a non-extractable Ed25519 key or run WebAuthn. */
  | "unsupported"
  /** The key store cannot be opened (private mode, blocked storage, SSR). */
  | "storage-unavailable"
  /** No device key has been created on this device yet. */
  | "not-found"
  /** A device key already exists and `force` was not requested. */
  | "already-exists"
  /** A signing operation was attempted while the key was locked. */
  | "locked"
  /** The user dismissed or aborted the passkey prompt. */
  | "passkey-cancelled"
  /** WebAuthn ran but its result failed validation (wrong credential, challenge, no user verification). */
  | "passkey-failed"
  /** WebCrypto refused to sign, or produced an unusable result. */
  | "signing-failed"
  /** A key was missing the expected shape, length or non-extractable flag. */
  | "invalid-key"
  /** A base58 / base64url / did:key value could not be decoded. */
  | "invalid-encoding";

/** Base class for every device-key failure. */
export class DeviceKeyError extends Error {
  /** Stable code callers can branch on. */
  readonly code: DeviceKeyErrorCode;

  constructor(code: DeviceKeyErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "DeviceKeyError";
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The user dismissed the passkey sheet, or the prompt otherwise did not complete. */
export class PasskeyCancelledError extends DeviceKeyError {
  constructor(message = "The passkey prompt was dismissed", options: { cause?: unknown } = {}) {
    super("passkey-cancelled", message, options);
    this.name = "PasskeyCancelledError";
  }
}

/** True when `error` looks like the user abandoning a WebAuthn prompt. */
export function isPasskeyCancellation(error: unknown): boolean {
  if (error instanceof PasskeyCancelledError) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "NotAllowedError" || name === "AbortError";
}

/** True when `error` is a {@link DeviceKeyError}. */
export function isDeviceKeyError(error: unknown): error is DeviceKeyError {
  return error instanceof DeviceKeyError;
}

/**
 * Wrap anything thrown by WebAuthn / WebCrypto / IndexedDB into a typed error.
 *
 * Cancellations keep their own subclass so a UI can show "Passkey prompt
 * dismissed" instead of an alarming failure message.
 */
export function toDeviceKeyError(
  error: unknown,
  fallbackCode: DeviceKeyErrorCode,
  message: string,
): DeviceKeyError {
  if (error instanceof DeviceKeyError) {
    return error;
  }
  if (isPasskeyCancellation(error)) {
    return new PasskeyCancelledError(message, { cause: error });
  }
  return new DeviceKeyError(fallbackCode, message, { cause: error });
}
