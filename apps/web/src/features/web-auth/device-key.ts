/**
 * The device signing key: generated once, kept non-extractable in IndexedDB,
 * and unlocked with a WebAuthn passkey prompt before every signing session.
 *
 * Security model
 * --------------
 * 1. `subtle.generateKey({ name: "Ed25519" }, extractable: false, …)` produces
 *    a private key whose bytes WebCrypto will never hand back.
 * 2. The `CryptoKey` objects are structured-cloned into IndexedDB. There is no
 *    exported form on disk.
 * 3. `unlock()` prompts for the passkey registered alongside the key and checks
 *    the assertion (credential id, challenge, user presence and verification).
 *    Signing is refused while the key is locked.
 *
 * The passkey does not wrap the WebCrypto key — browsers provide no such API.
 * It is an *authorization gate*: possession of the profile is not enough; the
 * person must also pass the authenticator's user-verification check.
 */

import { DeviceKeyError } from "./errors";
import { toBase64Url, toUint8Array, type BinaryData } from "./encoding";
import {
  DEVICE_KEY_RECORD_ID,
  DEVICE_KEY_RECORD_VERSION,
  IndexedDbDeviceKeyStorage,
  type DeviceKeyStorage,
  type StoredDeviceKey,
} from "./device-key-storage";
import {
  createBrowserPasskeyProvider,
  type PasskeyProvider,
} from "./passkey";
import {
  assertNonExtractablePrivateKey,
  createEd25519Crypto,
  type Ed25519Crypto,
} from "./webcrypto-ed25519";
import { didKeyFromEd25519PublicKey } from "./did-key";

/** How long a successful unlock lasts before the key locks itself again. */
export const DEFAULT_UNLOCK_TTL_MS = 5 * 60_000;

/** Public, private-key-free view of the device key. */
export interface DeviceKeySummary {
  /** base64url credential id of the passkey that unlocks the key. */
  credentialId: string;
  /** Epoch milliseconds when the key was created. */
  createdAt: number;
  /** Always `Ed25519`. */
  algorithm: "Ed25519";
  /** True while signing is permitted without another prompt. */
  unlocked: boolean;
  /** Epoch milliseconds when the current unlock expires. */
  unlockedUntil?: number;
  /** WebAuthn relying-party id the passkey is bound to. */
  rpId: string;
}

/** Options for {@link DeviceKeyManager.create}. */
export interface CreateDeviceKeyOptions {
  /** Account name shown in the passkey picker (email or ORCID). */
  userName: string;
  /** Display name shown in the passkey picker. */
  userDisplayName?: string;
  /** Relying-party id; defaults to the injected or current hostname. */
  rpId?: string;
  /** Relying-party name; defaults to `Scholium`. */
  rpName?: string;
  /** Stable user handle; a random 32-byte value is generated when omitted. */
  userId?: Uint8Array;
  /** Passkey prompt timeout. */
  timeoutMs?: number;
  /** Replace an existing device key instead of raising `already-exists`. */
  force?: boolean;
  /** Skip the implicit unlock after registration (defaults to `false`). */
  skipUnlock?: boolean;
}

/** Options for {@link DeviceKeyManager.unlock}. */
export interface UnlockDeviceKeyOptions {
  /** Why the key is being unlocked (for UI copy), not sent to the authenticator. */
  reason?: string;
  /** Passkey prompt timeout. */
  timeoutMs?: number;
}

/** Options for {@link DeviceKeyManager.sign}. */
export interface SignOptions {
  /**
   * When `false`, signing is allowed without an unlock.
   *
   * Defaults to `true`; only verification or test helpers should disable it.
   */
  requireUnlock?: boolean;
}

/** Injection points for {@link DeviceKeyManager}. */
export interface DeviceKeyManagerOptions {
  /** Persistence; defaults to IndexedDB with a memory fallback. */
  storage?: DeviceKeyStorage;
  /** Passkey implementation; defaults to `navigator.credentials`. */
  passkeys?: PasskeyProvider;
  /** Ed25519 implementation; defaults to WebCrypto. */
  ed25519?: Ed25519Crypto;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Random source, injectable for tests. */
  randomBytes?: (length: number) => Uint8Array;
  /** Unlock lifetime in milliseconds. */
  unlockTtlMs?: number;
  /** Default relying-party id. */
  rpId?: string;
  /** Default relying-party name. */
  rpName?: string;
}

/** Resolve the default relying-party id from the page origin. */
export function defaultRelyingPartyId(): string | undefined {
  const location = (
    globalThis as { location?: { hostname?: string } }
  ).location;
  return location?.hostname || undefined;
}

/**
 * Owns the device key lifecycle: create, load, unlock, sign, reset.
 *
 * ```ts
 * const key = new DeviceKeyManager();
 * await key.create({ userName: "mei@example.edu" }); // passkey prompt
 * const signature = await key.sign(nonceBytes);       // unlocked by create
 * await key.lock();
 * await key.sign(nonceBytes);                         // throws "locked"
 * ```
 */
export class DeviceKeyManager {
  private readonly storage: DeviceKeyStorage;
  private readonly passkeys: PasskeyProvider;
  private readonly ed25519: Ed25519Crypto;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly unlockTtlMs: number;
  private readonly defaultRpId?: string;
  private readonly defaultRpName: string;

  private record: StoredDeviceKey | null = null;
  private loaded = false;
  private loadPromise: Promise<StoredDeviceKey | null> | null = null;
  private unlockedUntil = 0;

  constructor(options: DeviceKeyManagerOptions = {}) {
    this.storage = options.storage ?? new IndexedDbDeviceKeyStorage();
    this.passkeys = options.passkeys ?? createBrowserPasskeyProvider();
    this.ed25519 = options.ed25519 ?? createEd25519Crypto();
    this.now = options.now ?? (() => Date.now());
    this.randomBytes =
      options.randomBytes ?? ((length) => this.ed25519.randomBytes(length));
    this.unlockTtlMs = options.unlockTtlMs ?? DEFAULT_UNLOCK_TTL_MS;
    this.defaultRpId = options.rpId;
    this.defaultRpName = options.rpName ?? "Scholium";
  }

  /** Storage backend in use (useful in diagnostics). */
  get storageKind(): DeviceKeyStorage["kind"] {
    return this.storage.kind;
  }

  /** True when Ed25519, storage and passkeys are all available. */
  isSupported(): boolean {
    return (
      this.ed25519.isSupported() &&
      this.storage.isAvailable() &&
      this.passkeys.isSupported()
    );
  }

  /**
   * Load the persisted key, if any.
   *
   * Loading never prompts for the passkey and never unlocks signing.
   */
  async load(): Promise<DeviceKeySummary | null> {
    if (!this.loaded) {
      if (!this.loadPromise) {
        const loading = this.loadFromStorage();
        this.loadPromise = loading;
        loading.catch(() => {
          if (this.loadPromise === loading) {
            this.loadPromise = null;
          }
        });
      }
      await this.loadPromise;
    }
    return this.summary();
  }

  /** True when a device key exists in storage. */
  async exists(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  /**
   * Create and persist a device key, then register its passkey.
   *
   * Registration already proves the user is present, so the key is unlocked
   * for {@link DEFAULT_UNLOCK_TTL_MS} unless `skipUnlock` is set.
   */
  async create(options: CreateDeviceKeyOptions): Promise<DeviceKeySummary> {
    await this.load();
    if (this.record && !options.force) {
      throw new DeviceKeyError(
        "already-exists",
        "A device key already exists; unlock it or reset it first",
      );
    }

    if (!options.userName || options.userName.trim() === "") {
      throw new DeviceKeyError(
        "invalid-key",
        "A user name is required to register a passkey",
      );
    }

    const rpId = this.resolveRpId(options.rpId);
    const userId = options.userId
      ? toUint8Array(options.userId)
      : this.randomBytes(32);

    const pair = await this.ed25519.generateKeyPair();
    assertNonExtractablePrivateKey(pair.privateKey);

    const registration = await this.passkeys.register({
      rpId,
      rpName: options.rpName ?? this.defaultRpName,
      userId,
      userName: options.userName,
      userDisplayName: options.userDisplayName,
      challenge: this.randomBytes(32),
      timeoutMs: options.timeoutMs,
    });

    const record: StoredDeviceKey = {
      id: DEVICE_KEY_RECORD_ID,
      version: DEVICE_KEY_RECORD_VERSION,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      credentialId: registration.credentialId,
      userId: toBase64Url(userId),
      createdAt: this.now(),
      rpId,
    };

    await this.storage.put(record);
    this.record = record;
    this.loaded = true;
    this.loadPromise = Promise.resolve(record);
    this.unlockedUntil = options.skipUnlock ? 0 : this.now() + this.unlockTtlMs;
    return this.summary() as DeviceKeySummary;
  }

  /** Create the key if missing, otherwise return the existing summary. */
  async ensure(options: CreateDeviceKeyOptions): Promise<DeviceKeySummary> {
    const existing = await this.load();
    if (existing) {
      return existing;
    }
    return this.create(options);
  }

  /**
   * Prompt for the passkey and unlock signing until the TTL elapses.
   *
   * Throws `passkey-cancelled` when the user dismisses the sheet, and
   * `passkey-failed` when the authenticator's result does not validate.
   */
  async unlock(
    options: UnlockDeviceKeyOptions = {},
  ): Promise<DeviceKeySummary> {
    await this.load();
    const record = this.record;
    if (!record) {
      throw new DeviceKeyError(
        "not-found",
        "No device key exists on this device yet",
      );
    }

    const challenge = this.randomBytes(32);
    const assertion = await this.passkeys.assert({
      rpId: record.rpId,
      credentialId: record.credentialId,
      challenge,
      timeoutMs: options.timeoutMs,
    });

    if (assertion.credentialId !== record.credentialId) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey does not match this device key",
      );
    }
    if (assertion.challenge !== toBase64Url(challenge)) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey answered the wrong challenge",
      );
    }
    if (!assertion.userPresent) {
      throw new DeviceKeyError(
        "passkey-failed",
        "The passkey did not report user presence",
      );
    }
    if (!assertion.userVerified) {
      throw new DeviceKeyError(
        "passkey-failed",
        "Your passkey did not verify you (PIN or biometric required)",
      );
    }

    this.unlockedUntil = this.now() + this.unlockTtlMs;
    return this.summary() as DeviceKeySummary;
  }

  /** True while signing is permitted without another prompt. */
  isUnlocked(): boolean {
    if (!this.record || this.unlockedUntil <= this.now()) {
      return false;
    }
    return true;
  }

  /** Forget the current unlock; the next signature needs a passkey prompt. */
  lock(): void {
    this.unlockedUntil = 0;
  }

  /**
   * Sign bytes with the non-extractable device private key.
   *
   * Refuses with `locked` unless {@link unlock} succeeded recently (or
   * `requireUnlock` is explicitly disabled).
   */
  async sign(
    data: BinaryData | Uint8Array,
    options: SignOptions = {},
  ): Promise<Uint8Array> {
    await this.load();
    const record = this.record;
    if (!record) {
      throw new DeviceKeyError(
        "not-found",
        "No device key exists on this device yet",
      );
    }
    if (options.requireUnlock !== false && !this.isUnlocked()) {
      throw new DeviceKeyError(
        "locked",
        "Unlock the device key with your passkey before signing",
      );
    }
    return this.ed25519.sign(record.privateKey, data);
  }

  /**
   * Unlock with a passkey prompt and sign in one call.
   *
   * This is the "Sign and submit" path used by the record and sign-in flows.
   */
  async signWithPasskey(
    data: BinaryData | Uint8Array,
    options: UnlockDeviceKeyOptions = {},
  ): Promise<Uint8Array> {
    await this.unlock(options);
    return this.sign(data);
  }

  /** Verify a signature with the stored public key. */
  async verify(
    data: BinaryData | Uint8Array,
    signature: BinaryData | Uint8Array,
  ): Promise<boolean> {
    await this.load();
    const record = this.record;
    if (!record) {
      throw new DeviceKeyError(
        "not-found",
        "No device key exists on this device yet",
      );
    }
    return this.ed25519.verify(record.publicKey, signature, data);
  }

  /** Raw 32-byte Ed25519 public key, for registration with the API. */
  async publicKey(): Promise<Uint8Array> {
    await this.load();
    const record = this.record;
    if (!record) {
      throw new DeviceKeyError(
        "not-found",
        "No device key exists on this device yet",
      );
    }
    return this.ed25519.exportPublicKey(record.publicKey);
  }

  /** The account identifier derived from the public key (`did:key:z6Mk…`). */
  async didKey(): Promise<string> {
    return didKeyFromEd25519PublicKey(await this.publicKey());
  }

  /** Credential id of the passkey that unlocks the key, if one exists. */
  async credentialId(): Promise<string | null> {
    await this.load();
    return this.record?.credentialId ?? null;
  }

  /** Summary of the loaded key, or `null` when none exists. */
  summary(): DeviceKeySummary | null {
    const record = this.record;
    if (!record) {
      return null;
    }
    const unlocked = this.isUnlocked();
    return {
      credentialId: record.credentialId,
      createdAt: record.createdAt,
      algorithm: "Ed25519",
      unlocked,
      ...(unlocked ? { unlockedUntil: this.unlockedUntil } : {}),
      rpId: record.rpId,
    };
  }

  /** Delete the device key and its passkey binding, and lock immediately. */
  async reset(): Promise<void> {
    try {
      await this.storage.delete();
    } finally {
      this.record = null;
      this.loaded = true;
      this.loadPromise = Promise.resolve(null);
      this.lock();
    }
  }

  private async loadFromStorage(): Promise<StoredDeviceKey | null> {
    const record = await this.storage.get();
    if (record) {
      assertNonExtractablePrivateKey(record.privateKey);
    }
    this.record = record;
    this.loaded = true;
    if (!record) {
      this.lock();
    }
    return record;
  }

  private resolveRpId(explicit?: string): string {
    const rpId = explicit ?? this.defaultRpId ?? defaultRelyingPartyId();
    if (!rpId) {
      throw new DeviceKeyError(
        "unsupported",
        "WebAuthn needs a browser origin to determine the relying-party id",
      );
    }
    return rpId;
  }
}

/** Create a manager with explicit dependencies. */
export function createDeviceKeyManager(
  options: DeviceKeyManagerOptions = {},
): DeviceKeyManager {
  return new DeviceKeyManager(options);
}

/**
 * Application-wide manager backed by IndexedDB and the browser's passkeys.
 *
 * Safe to import during server rendering: nothing touches `indexedDB` or
 * `navigator` until a method is called.
 */
export const deviceKey = new DeviceKeyManager();
