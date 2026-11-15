// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEVICE_KEY_RECORD_ID,
  DEVICE_KEY_RECORD_VERSION,
  DEVICE_KEY_STORE_NAME,
  IndexedDbDeviceKeyStorage,
  MemoryDeviceKeyStorage,
  createDeviceKeyStorage,
  isStoredDeviceKey,
  type StoredDeviceKey,
} from "./device-key-storage";
import { DeviceKeyError } from "./errors";

/** Minimal in-memory IndexedDB good enough for the store's request pattern. */
class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;

  complete(result: T): this {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
    return this;
  }

  fail(error: DOMException): this {
    this.error = error;
    queueMicrotask(() => this.onerror?.());
    return this;
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly keyPath: string,
    private readonly failWith?: DOMException,
  ) {}

  get(key: string): FakeRequest {
    if (this.failWith) {
      return new FakeRequest().fail(this.failWith);
    }
    return new FakeRequest().complete(this.data.get(key));
  }

  put(value: Record<string, unknown>): FakeRequest {
    if (this.failWith) {
      return new FakeRequest().fail(this.failWith);
    }
    this.data.set(String(value[this.keyPath]), value);
    return new FakeRequest().complete(value[this.keyPath]);
  }

  delete(key: string): FakeRequest {
    if (this.failWith) {
      return new FakeRequest().fail(this.failWith);
    }
    this.data.delete(key);
    return new FakeRequest().complete(undefined);
  }
}

class FakeTransaction {
  onabort: (() => void) | null = null;
  error: DOMException | null = null;

  constructor(private readonly store: FakeObjectStore) {}

  objectStore(): FakeObjectStore {
    return this.store;
  }
}

interface StoreEntry {
  data: Map<string, unknown>;
  keyPath: string;
  failWith?: DOMException;
}

class FakeDatabase {
  readonly entries = new Map<string, StoreEntry>();
  closed = false;
  onversionchange: (() => void) | null = null;

  readonly objectStoreNames = {
    contains: (name: string) => this.entries.has(name),
    item: (index: number) => [...this.entries.keys()][index] ?? null,
    length: 0,
  };

  createObjectStore(name: string, options?: { keyPath?: string }): unknown {
    this.entries.set(name, {
      data: new Map(),
      keyPath: options?.keyPath ?? "id",
    });
    return {};
  }

  transaction(name: string): FakeTransaction {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new DOMException(`No store named ${name}`, "NotFoundError");
    }
    return new FakeTransaction(
      new FakeObjectStore(entry.data, entry.keyPath, entry.failWith),
    );
  }

  close(): void {
    this.closed = true;
  }
}

function fakeIndexedDb(): { factory: IDBFactory; database: FakeDatabase } {
  const database = new FakeDatabase();
  const factory = {
    open: () => {
      const request = new FakeRequest<FakeDatabase>();
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, database };
}

async function generatePair(extractable = false): Promise<CryptoKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    extractable,
    ["sign", "verify"],
  );
  return pair as CryptoKeyPair;
}

async function makeRecord(
  overrides: Partial<StoredDeviceKey> = {},
): Promise<StoredDeviceKey> {
  const pair = await generatePair();
  return {
    id: DEVICE_KEY_RECORD_ID,
    version: DEVICE_KEY_RECORD_VERSION,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    credentialId: "credential-1",
    userId: "user-handle",
    createdAt: 1_700_000_000_000,
    rpId: "scholium.test",
    ...overrides,
  };
}

describe("isStoredDeviceKey", () => {
  it("accepts a complete record and rejects partial ones", async () => {
    const record = await makeRecord();
    expect(isStoredDeviceKey(record)).toBe(true);
    expect(isStoredDeviceKey(null)).toBe(false);
    expect(isStoredDeviceKey({ id: DEVICE_KEY_RECORD_ID })).toBe(false);
    expect(isStoredDeviceKey({ ...record, credentialId: "" })).toBe(false);
  });
});

describe("MemoryDeviceKeyStorage", () => {
  it("stores, reads and deletes a key", async () => {
    const storage = new MemoryDeviceKeyStorage();
    expect(storage.kind).toBe("memory");
    expect(storage.isAvailable()).toBe(true);
    expect(await storage.get()).toBeNull();

    const record = await makeRecord();
    await storage.put(record);
    expect(await storage.get()).toBe(record);

    await storage.delete();
    expect(await storage.get()).toBeNull();
  });

  it("refuses to persist an extractable private key", async () => {
    const pair = await generatePair(true);
    const record = await makeRecord({
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    });
    const storage = new MemoryDeviceKeyStorage();
    await expect(storage.put(record)).rejects.toMatchObject({
      code: "invalid-key",
    });
    expect(await storage.get()).toBeNull();
  });
});

describe("IndexedDbDeviceKeyStorage", () => {
  it("persists a key across instances sharing the same database", async () => {
    const { factory } = fakeIndexedDb();
    const first = new IndexedDbDeviceKeyStorage({ factory });
    expect(first.kind).toBe("indexeddb");
    expect(first.isAvailable()).toBe(true);

    expect(await first.get()).toBeNull();
    const record = await makeRecord();
    await first.put(record);

    const second = new IndexedDbDeviceKeyStorage({ factory });
    const loaded = await second.get();
    expect(loaded?.credentialId).toBe(record.credentialId);
    expect(loaded?.privateKey.extractable).toBe(false);
  });

  it("returns null for a malformed stored value", async () => {
    const { factory, database } = fakeIndexedDb();
    const storage = new IndexedDbDeviceKeyStorage({ factory });
    await storage.get(); // opens the database and creates the store
    database.entries
      .get(DEVICE_KEY_STORE_NAME)
      ?.data.set(DEVICE_KEY_RECORD_ID, { id: DEVICE_KEY_RECORD_ID });

    expect(await storage.get()).toBeNull();
  });

  it("deletes the stored key", async () => {
    const { factory } = fakeIndexedDb();
    const storage = new IndexedDbDeviceKeyStorage({ factory });
    await storage.put(await makeRecord());
    expect(await storage.get()).not.toBeNull();

    await storage.delete();
    expect(await storage.get()).toBeNull();
  });

  it("surfaces request failures as typed storage errors", async () => {
    const { factory, database } = fakeIndexedDb();
    const storage = new IndexedDbDeviceKeyStorage({ factory });
    await storage.get();
    const entry = database.entries.get(DEVICE_KEY_STORE_NAME);
    if (entry) {
      entry.failWith = new DOMException("quota exceeded", "QuotaExceededError");
    }

    await expect(storage.get()).rejects.toBeInstanceOf(DeviceKeyError);
    await expect(storage.get()).rejects.toMatchObject({
      code: "storage-unavailable",
    });
  });

  it("reports unavailable when IndexedDB is missing", async () => {
    const storage = new IndexedDbDeviceKeyStorage();
    expect(storage.isAvailable()).toBe(false);
    await expect(storage.get()).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    await expect(storage.delete()).rejects.toMatchObject({
      code: "storage-unavailable",
    });
  });

  it("falls back to memory when IndexedDB is missing", () => {
    expect(createDeviceKeyStorage().kind).toBe("memory");
  });

  it("uses a custom database and store name", async () => {
    const { factory, database } = fakeIndexedDb();
    const storage = new IndexedDbDeviceKeyStorage({
      factory,
      databaseName: "custom-db",
      storeName: "custom-store",
    });
    await storage.put(await makeRecord());
    expect(database.entries.has("custom-store")).toBe(true);
  });
});
