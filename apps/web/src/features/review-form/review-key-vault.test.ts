// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  IndexedDbReviewVault,
  REVIEW_VAULT_KEY_RECORD,
  REVIEW_VAULT_STORE,
} from "./review-key-vault";

/**
 * The vault keeps one non-extractable AES-GCM key in IndexedDB. The database is
 * a small in-memory stand-in with the parts of the real one the vault leans on:
 * requests answer asynchronously, a transaction completes when its requests
 * have, and writes made by one connection are seen by the next.
 */

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: DOMException | null = null;
  private pending = 0;
  private finished = false;

  constructor(private readonly data: Map<string, unknown>, private readonly keyPath: string) {
    // A transaction with no request still completes.
    queueMicrotask(() => this.settle());
  }

  objectStore(): FakeStore {
    return new FakeStore(this, this.data, this.keyPath);
  }

  run<T>(produce: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      request.result = produce();
      request.onsuccess?.();
      this.pending -= 1;
      this.settle();
    });
    return request;
  }

  private settle(): void {
    if (this.pending === 0 && !this.finished) {
      this.finished = true;
      this.oncomplete?.();
    }
  }
}

class FakeStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly data: Map<string, unknown>,
    private readonly keyPath: string,
  ) {}

  get(key: string): FakeRequest {
    return this.transaction.run(() => this.data.get(key));
  }

  put(value: Record<string, unknown>): FakeRequest {
    return this.transaction.run(() => {
      this.data.set(String(value[this.keyPath]), value);
      return value[this.keyPath];
    });
  }

  delete(key: string): FakeRequest {
    return this.transaction.run(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly keyPaths = new Map<string, string>();
  onversionchange: (() => void) | null = null;

  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };

  createObjectStore(name: string, options: { keyPath: string }): void {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath);
  }

  transaction(name: string): FakeTransaction {
    const data = this.stores.get(name);
    if (data === undefined) throw new DOMException("No such store", "NotFoundError");
    return new FakeTransaction(data, this.keyPaths.get(name) as string);
  }

  close(): void {}
}

class FakeFactory {
  readonly databases = new Map<string, FakeDatabase>();

  open(name: string): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      let database = this.databases.get(name);
      if (database === undefined) {
        database = new FakeDatabase();
        this.databases.set(name, database);
        request.result = database;
        request.onupgradeneeded?.();
      }
      request.result = database;
      request.onsuccess?.();
    });
    return request;
  }

  /** What is stored, as the vault's own records. */
  records(name = "scholium.review-vault"): Map<string, unknown> {
    return this.databases.get(name)?.stores.get(REVIEW_VAULT_STORE) ?? new Map();
  }
}

function vaultOn(factory: FakeFactory): IndexedDbReviewVault {
  return new IndexedDbReviewVault({
    factory: factory as unknown as IDBFactory,
    subtle: globalThis.crypto.subtle,
  });
}

describe("the vault's key", () => {
  it("is a non-extractable AES-GCM key that cannot be exported", async () => {
    const key = await vaultOn(new FakeFactory()).encryptionKey();

    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("is the same key on the next page load", async () => {
    const factory = new FakeFactory();

    const first = await vaultOn(factory).encryptionKey();
    const afterReload = await vaultOn(factory).encryptionKey();

    expect(afterReload).toBe(first);
  });

  it("is made once when two pages open together", async () => {
    const factory = new FakeFactory();

    const [one, other] = await Promise.all([
      vaultOn(factory).encryptionKey(),
      vaultOn(factory).encryptionKey(),
    ]);

    // Whichever stored its key first wins; the other uses it, so what either
    // sealed can be opened by both.
    expect(other).toBe(one);
    expect(factory.records().get(REVIEW_VAULT_KEY_RECORD)).toEqual({
      id: REVIEW_VAULT_KEY_RECORD,
      key: one,
    });
  });

  it("is replaced when what is stored under its name is not such a key", async () => {
    const factory = new FakeFactory();
    const vault = vaultOn(factory);
    await vault.encryptionKey();
    factory.records().set(REVIEW_VAULT_KEY_RECORD, {
      id: REVIEW_VAULT_KEY_RECORD,
      key: { extractable: true, algorithm: { name: "AES-GCM" }, usages: ["encrypt", "decrypt"] },
    });

    const replaced = await vaultOn(factory).encryptionKey();

    expect(replaced.extractable).toBe(false);
  });
});

describe("the vault's blobs", () => {
  const secret = { iv: new Uint8Array([1, 2, 3]), ciphertext: new Uint8Array([4, 5, 6, 7]) };

  it("keeps a blob under its id, and gives it back on the next page load", async () => {
    const factory = new FakeFactory();
    await vaultOn(factory).write("seed:sch:abc", secret);

    const read = await vaultOn(factory).read("seed:sch:abc");

    expect(read).toEqual(secret);
  });

  it("has nothing for an id it was never given", async () => {
    expect(await vaultOn(new FakeFactory()).read("seed:sch:none")).toBeNull();
  });

  it("forgets a blob", async () => {
    const vault = vaultOn(new FakeFactory());
    await vault.write("seed:sch:abc", secret);

    await vault.remove("seed:sch:abc");

    expect(await vault.read("seed:sch:abc")).toBeNull();
  });

  it("ignores a record that is not a blob", async () => {
    const factory = new FakeFactory();
    const vault = vaultOn(factory);
    await vault.write("seed:sch:abc", secret);
    factory.records().set("seed:sch:abc", { id: "seed:sch:abc", iv: "x", ciphertext: 3 });

    expect(await vault.read("seed:sch:abc")).toBeNull();
  });
});

describe("availability", () => {
  it("needs IndexedDB and WebCrypto both", () => {
    expect(vaultOn(new FakeFactory()).isAvailable()).toBe(true);
    // Node has no `indexedDB` of its own.
    expect(new IndexedDbReviewVault({ subtle: globalThis.crypto.subtle }).isAvailable()).toBe(
      false,
    );
  });

  it("refuses to be used without IndexedDB", async () => {
    await expect(new IndexedDbReviewVault().read("seed:x")).rejects.toThrow(/IndexedDB/);
  });
});
