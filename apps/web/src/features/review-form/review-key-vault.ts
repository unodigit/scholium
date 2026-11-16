/**
 * Where a reviewer's review key seeds are kept in the browser: an IndexedDB
 * vault holding one non-extractable AES-GCM key and the seeds it encrypted.
 *
 * `CryptoKey` objects are structured-cloneable, so a key made with
 * `extractable: false` can be written straight into IndexedDB and handed back
 * to `subtle.encrypt` and `subtle.decrypt` later, while its bytes are never
 * available to script: there is no value to copy out of the page, and none in
 * the browser profile on disk. The seeds themselves are stored only as AES-GCM
 * ciphertext next to it, so Web Storage never holds one.
 *
 * This module is the vault: the key, and opaque sealed blobs by id. What goes
 * in them and how it is sealed is `review-key-storage.ts`'s business.
 *
 * The database is opened lazily, so importing this module while rendering on
 * the server, where there is no `indexedDB`, is harmless.
 */

/** IndexedDB database the vault lives in. */
export const REVIEW_VAULT_DATABASE = "scholium.review-vault";

/** Object store inside {@link REVIEW_VAULT_DATABASE}. */
export const REVIEW_VAULT_STORE = "secrets";

/** Schema version of {@link REVIEW_VAULT_DATABASE}. */
export const REVIEW_VAULT_VERSION = 1;

/** The record that holds the AES-GCM key. */
export const REVIEW_VAULT_KEY_RECORD = "aes-gcm-key";

/** A blob sealed by the vault's key: AES-GCM output and the IV it used. */
export interface SealedSecret {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** What `review-key-storage.ts` needs of a vault. */
export interface ReviewVault {
  /** True when this vault can be used in the current environment. */
  isAvailable(): boolean;
  /**
   * The vault's AES-GCM key, made on first use and kept, so the same key
   * answers every later call, in this page and in the next.
   */
  encryptionKey(): Promise<CryptoKey>;
  /** The blob stored under `id`, or `null`. */
  read(id: string): Promise<SealedSecret | null>;
  /** Store `secret` under `id`, replacing what was there. */
  write(id: string, secret: SealedSecret): Promise<void>;
  /** Forget what is stored under `id`. */
  remove(id: string): Promise<void>;
}

/** Options for {@link IndexedDbReviewVault}. */
export interface IndexedDbReviewVaultOptions {
  /** Injected factory (tests); defaults to `globalThis.indexedDB`. */
  readonly factory?: IDBFactory;
  /** Injected WebCrypto (tests); defaults to `globalThis.crypto.subtle`. */
  readonly subtle?: SubtleCrypto;
  readonly databaseName?: string;
  readonly storeName?: string;
}

function isKeyLike(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Partial<CryptoKey>;
  return (
    key.extractable === false &&
    typeof key.algorithm === "object" &&
    key.algorithm !== null &&
    (key.algorithm as { name?: unknown }).name === "AES-GCM" &&
    Array.isArray(key.usages) &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";
}

/** The vault in IndexedDB. */
export class IndexedDbReviewVault implements ReviewVault {
  private readonly options: IndexedDbReviewVaultOptions;
  private databasePromise: Promise<IDBDatabase> | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(options: IndexedDbReviewVaultOptions = {}) {
    this.options = options;
  }

  private get databaseName(): string {
    return this.options.databaseName ?? REVIEW_VAULT_DATABASE;
  }

  private get storeName(): string {
    return this.options.storeName ?? REVIEW_VAULT_STORE;
  }

  private factory(): IDBFactory | undefined {
    return this.options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }

  private subtle(): SubtleCrypto | undefined {
    return (
      this.options.subtle ??
      (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
    );
  }

  isAvailable(): boolean {
    return this.factory() !== undefined && this.subtle() !== undefined;
  }

  encryptionKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      const pending = this.loadOrCreateKey();
      this.keyPromise = pending;
      // A failure must not be remembered: the next call tries again.
      pending.catch(() => {
        if (this.keyPromise === pending) this.keyPromise = null;
      });
    }
    return this.keyPromise;
  }

  async read(id: string): Promise<SealedSecret | null> {
    const database = await this.open();
    const value = await this.transact<unknown>(database, "readonly", (store, done) => {
      const request = store.get(id);
      request.onsuccess = () => done(request.result);
    });
    if (typeof value !== "object" || value === null) return null;
    const record = value as { iv?: unknown; ciphertext?: unknown };
    if (!isBytes(record.iv) || !isBytes(record.ciphertext)) return null;
    return { iv: record.iv, ciphertext: record.ciphertext };
  }

  async write(id: string, secret: SealedSecret): Promise<void> {
    const database = await this.open();
    await this.transact<void>(database, "readwrite", (store) => {
      store.put({ id, iv: secret.iv, ciphertext: secret.ciphertext });
    });
  }

  async remove(id: string): Promise<void> {
    const database = await this.open();
    await this.transact<void>(database, "readwrite", (store) => {
      store.delete(id);
    });
  }

  /** Close the cached connection (tests and hot-reload teardown). */
  close(): void {
    const pending = this.databasePromise;
    this.databasePromise = null;
    this.keyPromise = null;
    void pending
      ?.then((database) => database.close())
      .catch(() => {
        // The open failed, so there is nothing to close.
      });
  }

  /**
   * The stored key, or a fresh non-extractable one stored in its place.
   *
   * The key is generated outside the transaction (a transaction ends when
   * nothing is waiting on it), then stored only if no other page stored one in
   * the meantime: two tabs opening together must end with one key, or the
   * seeds one of them sealed could never be opened again.
   */
  private async loadOrCreateKey(): Promise<CryptoKey> {
    const subtle = this.subtle();
    if (subtle === undefined) throw new Error("WebCrypto is unavailable.");
    const database = await this.open();

    const existing = await this.transact<unknown>(database, "readonly", (store, done) => {
      const request = store.get(REVIEW_VAULT_KEY_RECORD);
      request.onsuccess = () => done(request.result);
    });
    const stored = (existing as { key?: unknown } | undefined)?.key;
    if (isKeyLike(stored)) return stored;

    const fresh = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    return this.transact<CryptoKey>(database, "readwrite", (store, done) => {
      const lookup = store.get(REVIEW_VAULT_KEY_RECORD);
      lookup.onsuccess = () => {
        const winner = (lookup.result as { key?: unknown } | undefined)?.key;
        if (isKeyLike(winner)) {
          done(winner);
          return;
        }
        store.put({ id: REVIEW_VAULT_KEY_RECORD, key: fresh });
        done(fresh);
      };
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise === null) {
      const opening = this.openDatabase();
      this.databasePromise = opening;
      // A failed open must not poison every later attempt.
      opening.catch(() => {
        if (this.databasePromise === opening) this.databasePromise = null;
      });
    }
    return this.databasePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.factory();
      if (factory === undefined) {
        reject(new Error("IndexedDB is unavailable."));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, REVIEW_VAULT_VERSION);
      } catch (error) {
        reject(error);
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
      request.onerror = () => reject(request.error ?? new Error("Could not open the vault."));
    });
  }

  /**
   * Run `work` in one transaction and settle when the transaction completes,
   * so a write is on disk before the caller is told it is. `work` calls `done`
   * with the value the promise resolves to.
   */
  private transact<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this.storeName, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("The vault transaction was aborted."));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("The vault transaction failed."));
      work(transaction.objectStore(this.storeName), (value) => {
        result = value;
      });
    });
  }
}
