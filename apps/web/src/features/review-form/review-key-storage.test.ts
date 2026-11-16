// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  EncryptedReviewKeyStorage,
  MemoryReviewKeyStorage,
  REVIEW_KEY_STORAGE_PREFIX,
  reviewKeyStorageKey,
  type LegacySeedStorage,
} from "./review-key-storage";
import type { ReviewVault, SealedSecret } from "./review-key-vault";

/**
 * Where a review key's seed is kept: sealed with AES-GCM under a
 * non-extractable key, never in the clear, and never lost when an earlier
 * version's plaintext entry is moved.
 *
 * The vault is an in-memory stand-in that makes its key with the real
 * WebCrypto, so what is sealed here is really sealed.
 */

const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);
const PAPER_A = "sch:6sel-2dio-orm6";
const PAPER_B = "sch:k3f9-q2xz-7mwd";

class FakeVault implements ReviewVault {
  readonly records = new Map<string, SealedSecret>();
  failWrites = false;
  private key: Promise<CryptoKey> | null = null;

  isAvailable(): boolean {
    return true;
  }

  encryptionKey(): Promise<CryptoKey> {
    this.key ??= globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    return this.key;
  }

  async read(id: string): Promise<SealedSecret | null> {
    return this.records.get(id) ?? null;
  }

  async write(id: string, secret: SealedSecret): Promise<void> {
    if (this.failWrites) throw new Error("The vault refused.");
    this.records.set(id, secret);
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

/** A `localStorage` with an earlier version's plaintext entries in it. */
class FakeLegacyStorage implements LegacySeedStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  /** What an earlier version wrote: `{"seed": "<base64>"}`. */
  keep(paperId: string, seed: Uint8Array): void {
    this.values.set(
      reviewKeyStorageKey(paperId),
      JSON.stringify({ seed: Buffer.from(seed).toString("base64") }),
    );
  }
}

function storageOn(vault: FakeVault, legacy?: FakeLegacyStorage): EncryptedReviewKeyStorage {
  return new EncryptedReviewKeyStorage({
    vault,
    legacy,
    subtle: globalThis.crypto.subtle,
  });
}

describe("a seed kept in the vault", () => {
  it("comes back as it went in", async () => {
    const storage = storageOn(new FakeVault());

    await storage.save(PAPER_A, SEED_A);

    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
  });

  it("is kept as ciphertext, not as the seed", async () => {
    const vault = new FakeVault();
    await storageOn(vault).save(PAPER_A, SEED_A);

    const [record] = [...vault.records.values()];

    expect(vault.records.size).toBe(1);
    // AES-GCM adds a 16-byte tag; the bytes are not the seed's.
    expect(record.ciphertext).toHaveLength(SEED_A.length + 16);
    expect(Buffer.from(record.ciphertext).includes(Buffer.from(SEED_A))).toBe(false);
  });

  it("is sealed afresh each time", async () => {
    const vault = new FakeVault();
    const storage = storageOn(vault);

    await storage.save(PAPER_A, SEED_A);
    const first = vault.records.get(`seed:${PAPER_A}`) as SealedSecret;
    await storage.save(PAPER_A, SEED_A);
    const second = vault.records.get(`seed:${PAPER_A}`) as SealedSecret;

    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
  });

  it("opens only for the paper it was sealed for", async () => {
    const vault = new FakeVault();
    const storage = storageOn(vault);
    await storage.save(PAPER_A, SEED_A);
    // The same bytes moved under another paper's name do not open there.
    vault.records.set(`seed:${PAPER_B}`, vault.records.get(`seed:${PAPER_A}`) as SealedSecret);

    expect(await storage.load(PAPER_B)).toBeNull();
    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
  });

  it("is one per paper", async () => {
    const storage = storageOn(new FakeVault());
    await storage.save(PAPER_A, SEED_A);
    await storage.save(PAPER_B, SEED_B);

    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
    expect(await storage.load(PAPER_B)).toEqual(SEED_B);
  });

  it("is absent for a paper it was never given", async () => {
    expect(await storageOn(new FakeVault()).load(PAPER_A)).toBeNull();
  });

  it("is forgotten on request", async () => {
    const storage = storageOn(new FakeVault());
    await storage.save(PAPER_A, SEED_A);

    await storage.forget(PAPER_A);

    expect(await storage.load(PAPER_A)).toBeNull();
  });

  it("is not opened if the key that sealed it is gone", async () => {
    const vault = new FakeVault();
    await storageOn(vault).save(PAPER_A, SEED_A);
    // A new vault key (the profile's was cleared) cannot open the old seeds.
    const rekeyed = new FakeVault();
    for (const [id, record] of vault.records) rekeyed.records.set(id, record);

    expect(await storageOn(rekeyed).load(PAPER_A)).toBeNull();
  });

  it("is kept for the page when the vault refuses it", async () => {
    const vault = new FakeVault();
    vault.failWrites = true;
    const storage = storageOn(vault);

    await expect(storage.save(PAPER_A, SEED_A)).resolves.toBeUndefined();

    expect(vault.records.size).toBe(0);
    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
  });

  it("ignores a blank paper id", async () => {
    const vault = new FakeVault();
    const storage = storageOn(vault);

    await storage.save("  ", SEED_A);

    expect(vault.records.size).toBe(0);
    expect(await storage.load("  ")).toBeNull();
  });
});

describe("a seed saved here is never written in the clear", () => {
  it("leaves the plaintext storage as it was", async () => {
    const legacy = new FakeLegacyStorage();
    const storage = storageOn(new FakeVault(), legacy);

    await storage.save(PAPER_A, SEED_A);

    expect(legacy.length).toBe(0);
    expect(legacy.getItem(reviewKeyStorageKey(PAPER_A))).toBeNull();
  });
});

describe("the plaintext entries an earlier version kept", () => {
  it("move into the vault on first use, and leave the plaintext storage", async () => {
    const vault = new FakeVault();
    const legacy = new FakeLegacyStorage();
    legacy.keep(PAPER_A, SEED_A);
    legacy.keep(PAPER_B, SEED_B);
    legacy.values.set("scholium.something-else", "kept");

    // Asking about one paper moves every paper's seed.
    expect(await storageOn(vault, legacy).load(PAPER_A)).toEqual(SEED_A);

    expect([...legacy.values.keys()]).toEqual(["scholium.something-else"]);
    expect(vault.records.size).toBe(2);
    // Another page, with nothing in the plaintext storage, still has both.
    const next = storageOn(vault, new FakeLegacyStorage());
    expect(await next.load(PAPER_A)).toEqual(SEED_A);
    expect(await next.load(PAPER_B)).toEqual(SEED_B);
  });

  it("move when the first thing done is a save", async () => {
    const vault = new FakeVault();
    const legacy = new FakeLegacyStorage();
    legacy.keep(PAPER_A, SEED_A);

    await storageOn(vault, legacy).save(PAPER_B, SEED_B);

    expect(legacy.length).toBe(0);
    expect(vault.records.has(`seed:${PAPER_A}`)).toBe(true);
  });

  it("do not replace a newer seed the vault already holds", async () => {
    const vault = new FakeVault();
    await storageOn(vault).save(PAPER_A, SEED_B);
    const legacy = new FakeLegacyStorage();
    legacy.keep(PAPER_A, SEED_A);

    expect(await storageOn(vault, legacy).load(PAPER_A)).toEqual(SEED_B);
    expect(legacy.length).toBe(0);
  });

  it("stay where they were, and still work, when the vault refuses them", async () => {
    const vault = new FakeVault();
    vault.failWrites = true;
    const legacy = new FakeLegacyStorage();
    legacy.keep(PAPER_A, SEED_A);

    const storage = storageOn(vault, legacy);

    // Not lost for want of a place to put it ...
    expect(legacy.getItem(reviewKeyStorageKey(PAPER_A))).not.toBeNull();
    // ... and the page can still reveal with it.
    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
  });

  it("are left alone when they are not a seed", async () => {
    const legacy = new FakeLegacyStorage();
    legacy.values.set(`${REVIEW_KEY_STORAGE_PREFIX}${PAPER_A}`, "not json");
    legacy.values.set(`${REVIEW_KEY_STORAGE_PREFIX}${PAPER_B}`, JSON.stringify({ seed: "AAAA" }));

    expect(await storageOn(new FakeVault(), legacy).load(PAPER_A)).toBeNull();

    expect(legacy.length).toBe(2);
  });

  it("are looked for once per page", async () => {
    const vault = new FakeVault();
    const legacy = new FakeLegacyStorage();
    const storage = storageOn(vault, legacy);
    await storage.load(PAPER_A);

    // An entry that appears later (another tab on the old version) is not
    // swept again by this page; the next page does.
    legacy.keep(PAPER_B, SEED_B);
    await storage.load(PAPER_B);

    expect(legacy.length).toBe(1);
  });
});

describe("a page with nowhere safe to keep a seed", () => {
  it("keeps it in memory for the page", async () => {
    const storage = new MemoryReviewKeyStorage();

    await storage.save(PAPER_A, SEED_A);

    expect(await storage.load(PAPER_A)).toEqual(SEED_A);
    expect(await storage.load(PAPER_B)).toBeNull();
    await storage.forget(PAPER_A);
    expect(await storage.load(PAPER_A)).toBeNull();
  });
});
