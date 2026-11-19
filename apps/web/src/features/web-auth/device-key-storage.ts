/**
 * Persistence for the device signing key.
 *
 * `CryptoKey` objects are structured-cloneable, so a non-extractable private
 * key can be written straight into IndexedDB and later handed back to
 * `subtle.sign`. The raw key material is never serialised, which is exactly
 * the point: there is no bytes-to-steal representation on disk.
 *
 * A memory store exists for tests and for environments without IndexedDB.
 */

import { DeviceKeyError } from "./errors";
import { assertNonExtractablePrivateKey } from "./webcrypto-ed25519";

/** IndexedDB database used for device keys. */
export const DEVICE_KEY_DATABASE_NAME = "scholium.web-auth";

/** Object store inside {@link DEVICE_KEY_DATABASE_NAME}. */
export const DEVICE_KEY_STORE_NAME = "device-keys";

/** Schema version of {@link DEVICE_KEY_DATABASE_NAME}. */
export const DEVICE_KEY_DATABASE_VERSION = 1;

/** Fixed primary key: one device key per browser profile. */
export const DEVICE_KEY_RECORD_ID = "primary";

/** Current record shape version. */
export const DEVICE_KEY_RECORD_VERSION = 1;

/** What we persist for a device key. */
export interface StoredDeviceKey {
  /** Always {@link DEVICE_KEY_RECORD_ID}. */
  id: typeof DEVICE_KEY_RECORD_ID;
  /** {@link DEVICE_KEY_RECORD_VERSION} when written. */
  version: number;
  /** Non-extractable Ed25519 signing key. */
  privateKey: CryptoKey;
  /** Exportable Ed25519 verification key. */
  publicKey: CryptoKey;
  /** base64url WebAuthn credential id that unlocks the key. */
  credentialId: string;
  /** base64url random user handle passed to the authenticator. */
  userId: string;
  /** Epoch milliseconds when the key was created. */
  createdAt: number;
  /** WebAuthn relying-party id the passkey is bound to. */
  rpId: string;
  /**
   * `did:key` of the account this key signs for, kept beside the key.
   *
   * An account's DID never changes when its key does, so after Rotate key or a
   * recovery the key's own did:key is no longer the account's DID: this field
   * says which account the key signs in as. A key that created its account
   * stores its own did:key. Absent on a key saved before this field existed,
   * which reads as "the key's own did:key, unless the server says otherwise".
   */
  accountDid?: string;
}

/** Pluggable persistence for the device key. */
export interface DeviceKeyStorage {
  /** Short identifier, useful in diagnostics. */
  readonly kind: "indexeddb" | "memory";
  /** True when this store can be used in the current environment. */
  isAvailable(): boolean;
  /** Read the stored key, or `null` when none exists. */
  get(): Promise<StoredDeviceKey | null>;
  /** Insert or replace the stored key. */
  put(record: StoredDeviceKey): Promise<void>;
  /** Remove the stored key. */
  delete(): Promise<void>;
}

function isCryptoKeyLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "algorithm" in value &&
    "usages" in value &&
    "extractable" in value
  );
}

/** Structural validation for records read back from storage. */
export function isStoredDeviceKey(value: unknown): value is StoredDeviceKey {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<StoredDeviceKey>;
  return (
    record.id === DEVICE_KEY_RECORD_ID &&
    typeof record.version === "number" &&
    isCryptoKeyLike(record.privateKey) &&
    isCryptoKeyLike(record.publicKey) &&
    typeof record.credentialId === "string" &&
    record.credentialId.length > 0 &&
    typeof record.userId === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.rpId === "string" &&
    record.rpId.length > 0
  );
}

/** In-memory store used by tests and non-persistent environments. */
export class MemoryDeviceKeyStorage implements DeviceKeyStorage {
  readonly kind = "memory" as const;

  private record: StoredDeviceKey | null;

  constructor(record: StoredDeviceKey | null = null) {
    this.record = record;
  }

  isAvailable(): boolean {
    return true;
  }

  async get(): Promise<StoredDeviceKey | null> {
    return this.record;
  }

  async put(record: StoredDeviceKey): Promise<void> {
    assertNonExtractablePrivateKey(record.privateKey);
    this.record = record;
  }

  async delete(): Promise<void> {
    this.record = null;
  }
}

/** Options for {@link IndexedDbDeviceKeyStorage}. */
export interface IndexedDbDeviceKeyStorageOptions {
  /** Injected factory (tests); defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  databaseName?: string;
  storeName?: string;
  version?: number;
}

function storageError(error: unknown, message: string): DeviceKeyError {
  if (error instanceof DeviceKeyError) {
    return error;
  }
  return new DeviceKeyError("storage-unavailable", message, { cause: error });
}

/**
 * IndexedDB-backed store.
 *
 * The database is opened lazily on first use, so importing this module during
 * server rendering (where `indexedDB` does not exist) is harmless.
 */
export class IndexedDbDeviceKeyStorage implements DeviceKeyStorage {
  readonly kind = "indexeddb" as const;

  private readonly options: IndexedDbDeviceKeyStorageOptions;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbDeviceKeyStorageOptions = {}) {
    this.options = options;
  }

  get databaseName(): string {
    return this.options.databaseName ?? DEVICE_KEY_DATABASE_NAME;
  }

  get storeName(): string {
    return this.options.storeName ?? DEVICE_KEY_STORE_NAME;
  }

  isAvailable(): boolean {
    return this.resolveFactory() !== undefined;
  }

  async get(): Promise<StoredDeviceKey | null> {
    const database = await this.open();
    return this.request<StoredDeviceKey | null>(database, "readonly", (store) =>
      store.get(DEVICE_KEY_RECORD_ID),
    ).then((value) => (isStoredDeviceKey(value) ? value : null));
  }

  async put(record: StoredDeviceKey): Promise<void> {
    assertNonExtractablePrivateKey(record.privateKey);
    const database = await this.open();
    await this.request(database, "readwrite", (store) => store.put(record));
  }

  async delete(): Promise<void> {
    const database = await this.open();
    await this.request(database, "readwrite", (store) =>
      store.delete(DEVICE_KEY_RECORD_ID),
    );
  }

  /** Close the cached connection (tests and hot-reload teardown). */
  close(): void {
    const pending = this.databasePromise;
    this.databasePromise = null;
    void pending
      ?.then((database) => database.close())
      .catch(() => {
        // The open failed, so there is nothing to close.
      });
  }

  private resolveFactory(): IDBFactory | undefined {
    if (this.options.factory) {
      return this.options.factory;
    }
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      const opening = this.openDatabase();
      this.databasePromise = opening;
      // A failed open must not poison every later attempt (e.g. the user
      // blocked storage temporarily).
      opening.catch(() => {
        if (this.databasePromise === opening) {
          this.databasePromise = null;
        }
      });
    }
    return this.databasePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.resolveFactory();
      if (!factory) {
        reject(
          new DeviceKeyError(
            "storage-unavailable",
            "IndexedDB is unavailable; the device key cannot be saved",
          ),
        );
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, DEVICE_KEY_DATABASE_VERSION);
      } catch (error) {
        reject(storageError(error, "Could not open the device key database"));
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.storeName)) {
          database.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        reject(
          storageError(request.error, "Could not open the device key database"),
        );
      };
    });
  }

  private request<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this.storeName, mode);
      } catch (error) {
        reject(storageError(error, "Could not start a device key read"));
        return;
      }
      const request = run(transaction.objectStore(this.storeName));
      request.onsuccess = () => {
        resolve(request.result as T);
      };
      request.onerror = () => {
        reject(
          storageError(request.error, "Could not read or write the device key"),
        );
      };
      transaction.onabort = () => {
        reject(
          storageError(transaction.error, "The device key transaction was aborted"),
        );
      };
    });
  }
}

/**
 * Pick the best store for this environment: IndexedDB when present, otherwise
 * an in-memory fallback (server rendering, tests, locked-down browsers).
 */
export function createDeviceKeyStorage(
  options: IndexedDbDeviceKeyStorageOptions = {},
): DeviceKeyStorage {
  const indexedDb = new IndexedDbDeviceKeyStorage(options);
  if (indexedDb.isAvailable()) {
    return indexedDb;
  }
  return new MemoryDeviceKeyStorage();
}
