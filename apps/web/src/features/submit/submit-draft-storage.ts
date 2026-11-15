/**
 * Persistence for the `/submit` wizard draft.
 *
 * The wizard keeps its draft (step, details, authors and the finished files) in
 * React state so stepping back and forward keeps it. This module writes that
 * draft to IndexedDB on every change and reads it back when the author returns
 * to `/submit`, so a closed tab or a reloaded page does not lose the work.
 *
 * An IndexedDB-backed store is used when the browser has one; otherwise an
 * in-memory store stands in (server rendering, tests, locked-down browsers).
 * The in-memory store is per instance, so callers that need persistence across
 * instances should inject a shared one or provide an IndexedDB factory.
 */

import type { DraftAuthor } from "./authors";
import type { DetailsValues } from "./details";
import type { SubmitFile } from "./upload-manager";
import type { WizardStepId } from "./wizard-steps";

/** The serialisable shape of a wizard draft. */
export interface SubmitDraft {
  /** The step the author was on, when known. */
  step?: WizardStepId;
  /** Step 2 values. */
  details: DetailsValues;
  /** Step 3 roster. */
  authors: DraftAuthor[];
  /** Step 1 files that are on the node and match their fingerprints. */
  files: SubmitFile[];
}

/** What we persist for a draft. */
export interface StoredSubmitDraft extends SubmitDraft {
  /** Always {@link SUBMIT_DRAFT_RECORD_ID}. */
  id: typeof SUBMIT_DRAFT_RECORD_ID;
  /** {@link SUBMIT_DRAFT_RECORD_VERSION} when written. */
  version: number;
  /** Epoch milliseconds when the draft was written. */
  savedAt: number;
  /** Convenience alias for callers that expect a nested draft. */
  draft: SubmitDraft;
}

/** IndexedDB database used for submit drafts. */
export const SUBMIT_DRAFT_DATABASE_NAME = "scholium.submit-wizard";

/** Object store inside {@link SUBMIT_DRAFT_DATABASE_NAME}. */
export const SUBMIT_DRAFT_STORE_NAME = "drafts";

/** Schema version of {@link SUBMIT_DRAFT_DATABASE_NAME}. */
export const SUBMIT_DRAFT_DATABASE_VERSION = 1;

/** Fixed primary key: one draft per browser profile. */
export const SUBMIT_DRAFT_RECORD_ID = "primary";

/** Current record shape version. */
export const SUBMIT_DRAFT_RECORD_VERSION = 1;

/** Pluggable persistence for the submit draft. */
export interface SubmitDraftStorage {
  /** Short identifier, useful in diagnostics. */
  readonly kind: "indexeddb" | "memory";
  /** True when this store can be used in the current environment. */
  isAvailable(): boolean;
  /** Read the stored draft, or `null` when none exists. */
  get(): Promise<StoredSubmitDraft | null>;
  /** Insert or replace the stored draft. */
  put(draft: SubmitDraft): Promise<void>;
  /** Remove the stored draft. */
  delete(): Promise<void>;
}

/** Structural validation for records read back from storage. */
export function isStoredSubmitDraft(value: unknown): value is StoredSubmitDraft {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<StoredSubmitDraft>;
  if (record.id !== SUBMIT_DRAFT_RECORD_ID) {
    return false;
  }
  if (typeof record.version !== "number") {
    return false;
  }
  if (typeof record.savedAt !== "number") {
    return false;
  }
  if (!record.details || typeof record.details !== "object") {
    return false;
  }
  if (!Array.isArray(record.authors)) {
    return false;
  }
  if (!Array.isArray(record.files)) {
    return false;
  }
  // The nested alias must agree when present.
  if (record.draft !== undefined && !isSubmitDraft(record.draft)) {
    return false;
  }
  return true;
}

/** Structural validation for a draft payload. */
export function isSubmitDraft(value: unknown): value is SubmitDraft {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const draft = value as Partial<SubmitDraft>;
  if (!draft.details || typeof draft.details !== "object") {
    return false;
  }
  if (!Array.isArray(draft.authors)) {
    return false;
  }
  if (!Array.isArray(draft.files)) {
    return false;
  }
  if (draft.step !== undefined && typeof draft.step !== "string") {
    return false;
  }
  return true;
}

/** In-memory store used by tests and non-persistent environments. */
export class MemorySubmitDraftStorage implements SubmitDraftStorage {
  readonly kind = "memory" as const;

  private record: StoredSubmitDraft | null;

  constructor(record: StoredSubmitDraft | null = null) {
    this.record = record;
  }

  isAvailable(): boolean {
    return true;
  }

  async get(): Promise<StoredSubmitDraft | null> {
    return this.record;
  }

  async put(draft: SubmitDraft): Promise<void> {
    const savedAt = Date.now();
    const stored: StoredSubmitDraft = {
      id: SUBMIT_DRAFT_RECORD_ID,
      version: SUBMIT_DRAFT_RECORD_VERSION,
      savedAt,
      step: draft.step,
      details: draft.details,
      authors: draft.authors,
      files: draft.files,
      draft: {
        step: draft.step,
        details: draft.details,
        authors: draft.authors,
        files: draft.files,
      },
    };
    this.record = stored;
  }

  async delete(): Promise<void> {
    this.record = null;
  }
}

/** Options for {@link IndexedDbSubmitDraftStorage}. */
export interface IndexedDbSubmitDraftStorageOptions {
  /** Injected factory (tests); defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  databaseName?: string;
  storeName?: string;
  version?: number;
}

function storageError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(message);
}

/**
 * IndexedDB-backed store.
 *
 * The database is opened lazily on first use, so importing this module during
 * server rendering (where `indexedDB` does not exist) is harmless.
 */
export class IndexedDbSubmitDraftStorage implements SubmitDraftStorage {
  readonly kind = "indexeddb" as const;

  private readonly options: IndexedDbSubmitDraftStorageOptions;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbSubmitDraftStorageOptions = {}) {
    this.options = options;
  }

  get databaseName(): string {
    return this.options.databaseName ?? SUBMIT_DRAFT_DATABASE_NAME;
  }

  get storeName(): string {
    return this.options.storeName ?? SUBMIT_DRAFT_STORE_NAME;
  }

  isAvailable(): boolean {
    return this.resolveFactory() !== undefined;
  }

  async get(): Promise<StoredSubmitDraft | null> {
    const database = await this.open();
    const value = await this.request<unknown>(database, "readonly", (store) =>
      store.get(SUBMIT_DRAFT_RECORD_ID),
    );
    if (!isStoredSubmitDraft(value)) {
      return null;
    }
    // Ensure the nested alias exists for older records.
    if (!value.draft) {
      value.draft = {
        step: value.step,
        details: value.details,
        authors: value.authors,
        files: value.files,
      };
    }
    return value;
  }

  async put(draft: SubmitDraft): Promise<void> {
    const database = await this.open();
    const savedAt = Date.now();
    const stored: StoredSubmitDraft = {
      id: SUBMIT_DRAFT_RECORD_ID,
      version: SUBMIT_DRAFT_RECORD_VERSION,
      savedAt,
      step: draft.step,
      details: draft.details,
      authors: draft.authors,
      files: draft.files,
      draft: {
        step: draft.step,
        details: draft.details,
        authors: draft.authors,
        files: draft.files,
      },
    };
    await this.request(database, "readwrite", (store) => store.put(stored));
  }

  async delete(): Promise<void> {
    const database = await this.open();
    await this.request(database, "readwrite", (store) =>
      store.delete(SUBMIT_DRAFT_RECORD_ID),
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
        reject(new Error("IndexedDB is unavailable; the submit draft cannot be saved"));
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, this.options.version ?? SUBMIT_DRAFT_DATABASE_VERSION);
      } catch (error) {
        reject(storageError(error, "Could not open the submit draft database"));
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
        reject(storageError(request.error, "Could not open the submit draft database"));
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
        reject(storageError(error, "Could not start a submit draft transaction"));
        return;
      }
      const store = transaction.objectStore(this.storeName);
      let request: IDBRequest;
      try {
        request = run(store);
      } catch (error) {
        reject(storageError(error, "Could not run a submit draft request"));
        return;
      }

      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () =>
        reject(storageError(request.error, "The submit draft request failed"));

      transaction.onabort = () => {
        reject(storageError(transaction.error, "The submit draft transaction was aborted"));
      };
    });
  }
}

/**
 * Pick the best store for this environment: IndexedDB when present, otherwise
 * an in-memory fallback (server rendering, tests, locked-down browsers).
 */
export function createSubmitDraftStorage(
  options: IndexedDbSubmitDraftStorageOptions = {},
): SubmitDraftStorage {
  const indexedDb = new IndexedDbSubmitDraftStorage(options);
  if (indexedDb.isAvailable()) {
    return indexedDb;
  }
  return new MemorySubmitDraftStorage();
}
