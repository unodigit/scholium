// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { loadReviewKey, reviewKeyFromSeed } from "./review-key";
import {
  EncryptedReviewKeyStorage,
  REVIEW_KEY_STORAGE_PREFIX,
  reviewKeyStorageKey,
} from "./review-key-storage";
import type { ReviewVault, SealedSecret } from "./review-key-vault";

/**
 * Entries an earlier version kept in the browser's real `localStorage`, in the
 * clear, move into the encrypted vault the first time the storage is used.
 */

const PAPER_A = "sch:6sel-2dio-orm6";
const PAPER_B = "sch:k3f9-q2xz-7mwd";
const SEED_A = new Uint8Array(32).fill(7);
const SEED_B = new Uint8Array(32).fill(9);

class FakeVault implements ReviewVault {
  readonly records = new Map<string, SealedSecret>();
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
    this.records.set(id, secret);
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

function keepInTheClear(paperId: string, seed: Uint8Array): void {
  window.localStorage.setItem(
    reviewKeyStorageKey(paperId),
    JSON.stringify({ seed: btoa(String.fromCharCode(...seed)) }),
  );
}

function storedNames(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index) as string,
  );
}

afterEach(() => window.localStorage.clear());

describe("migrating plaintext review keys out of localStorage", () => {
  it("moves every entry into the vault on first use and leaves none behind", async () => {
    keepInTheClear(PAPER_A, SEED_A);
    keepInTheClear(PAPER_B, SEED_B);
    window.localStorage.setItem("scholium.theme", "dark");
    const vault = new FakeVault();
    const storage = new EncryptedReviewKeyStorage({ vault, legacy: window.localStorage });

    // The first use, of any paper, moves them all.
    const key = await loadReviewKey(PAPER_A, storage);

    expect(key?.did).toBe(reviewKeyFromSeed(SEED_A).did);
    expect(storedNames()).toEqual(["scholium.theme"]);
    expect(storedNames().some((name) => name.startsWith(REVIEW_KEY_STORAGE_PREFIX))).toBe(false);
    expect((await loadReviewKey(PAPER_B, storage))?.seed).toEqual(SEED_B);
    expect(vault.records.size).toBe(2);
  });

  it("is not read again on the next page: the migrated key still opens", async () => {
    keepInTheClear(PAPER_A, SEED_A);
    const vault = new FakeVault();
    await loadReviewKey(PAPER_A, new EncryptedReviewKeyStorage({ vault, legacy: window.localStorage }));

    const nextPage = new EncryptedReviewKeyStorage({ vault, legacy: window.localStorage });

    expect((await loadReviewKey(PAPER_A, nextPage))?.seed).toEqual(SEED_A);
    expect(storedNames()).toEqual([]);
  });

  it("writes nothing to localStorage when a key is saved afterwards", async () => {
    const storage = new EncryptedReviewKeyStorage({
      vault: new FakeVault(),
      legacy: window.localStorage,
    });

    await storage.save(PAPER_A, SEED_A);

    expect(storedNames()).toEqual([]);
  });
});
