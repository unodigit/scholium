/**
 * Keeping a review key's seed on the reviewer's device.
 *
 * The seed is the secret that signs a review's reveal, so it is never written
 * to Web Storage in the clear. It is sealed with AES-GCM under a
 * **non-extractable** key kept in IndexedDB (`review-key-vault.ts`): the
 * ciphertext is what is stored, and the key that opens it cannot be copied out
 * of the browser.
 *
 * Earlier versions kept the seed as `{"seed": "<base64>"}` in `localStorage`.
 * The first use of the storage in a page moves every such entry into the
 * vault and removes it from `localStorage`; an entry that cannot be moved (the
 * vault refused it) is left where it was, so the secret is never lost for
 * want of a place to put it.
 *
 * Where IndexedDB or WebCrypto is missing, seeds are kept in memory for the
 * page only. Nothing is ever written in the clear instead.
 *
 * This module deals in raw seeds; `review-key.ts` turns them into keys.
 */

import {
  IndexedDbReviewVault,
  type ReviewVault,
} from "./review-key-vault";
import { toUint8Array, utf8Encode } from "../web-auth/encoding";

/**
 * Prefix of the key an earlier version kept a paper's seed under in
 * `localStorage`, in the clear. Nothing is written there any more; entries are
 * migrated away on first use.
 */
export const REVIEW_KEY_STORAGE_PREFIX = "scholium.review-key.v1:";

/** The `localStorage` key an earlier version kept a paper's seed under. */
export function reviewKeyStorageKey(paperId: string): string {
  return `${REVIEW_KEY_STORAGE_PREFIX}${paperId.trim()}`;
}

/** Where review key seeds are kept. */
export interface ReviewKeyStorage {
  /** The seed kept for `paperId`, or `null`. Never rejects. */
  load(paperId: string): Promise<Uint8Array | null>;
  /** Keep a seed. Never rejects: a refusal leaves it in this page's memory. */
  save(paperId: string, seed: Uint8Array): Promise<void>;
  /** Forget a paper's seed. Never rejects. */
  forget(paperId: string): Promise<void>;
}

/**
 * What the migration reads old entries from: the part of `Storage` it needs,
 * which can enumerate keys.
 */
export interface LegacySeedStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function cleanId(paperId: string): string {
  return paperId.trim();
}

/** Seeds in memory, for a page with nowhere safe to put them. */
export class MemoryReviewKeyStorage implements ReviewKeyStorage {
  private readonly seeds = new Map<string, Uint8Array>();

  async load(paperId: string): Promise<Uint8Array | null> {
    const seed = this.seeds.get(cleanId(paperId));
    return seed === undefined ? null : new Uint8Array(seed);
  }

  async save(paperId: string, seed: Uint8Array): Promise<void> {
    const id = cleanId(paperId);
    if (id !== "") this.seeds.set(id, new Uint8Array(seed));
  }

  async forget(paperId: string): Promise<void> {
    this.seeds.delete(cleanId(paperId));
  }
}

/** Seams for {@link EncryptedReviewKeyStorage}. */
export interface EncryptedReviewKeyStorageOptions {
  readonly vault: ReviewVault;
  /** Where plaintext entries of an earlier version are looked for. */
  readonly legacy?: LegacySeedStorage;
  readonly subtle?: SubtleCrypto;
  readonly randomBytes?: (length: number) => Uint8Array;
}

const IV_BYTES = 12;
const SEED_RECORD_PREFIX = "seed:";

function seedRecord(paperId: string): string {
  return `${SEED_RECORD_PREFIX}${paperId}`;
}

/** The additional data a sealed seed is bound to: its paper. */
function boundTo(paperId: string): Uint8Array<ArrayBuffer> {
  return utf8Encode(`scholium.review-seed.v1:${paperId}`);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The seed in an earlier version's `localStorage` entry, or `null`. */
function legacySeed(serialized: string | null): Uint8Array | null {
  if (serialized === null) return null;
  try {
    const parsed = JSON.parse(serialized) as { seed?: unknown };
    if (typeof parsed.seed !== "string") return null;
    const seed = base64ToBytes(parsed.seed);
    return seed.length === 32 ? seed : null;
  } catch {
    return null;
  }
}

/** Seeds sealed under the vault's non-extractable key. */
export class EncryptedReviewKeyStorage implements ReviewKeyStorage {
  private readonly vault: ReviewVault;
  private readonly legacy: LegacySeedStorage | undefined;
  private readonly subtleOverride: SubtleCrypto | undefined;
  private readonly randomOverride: ((length: number) => Uint8Array) | undefined;
  /** Seeds the vault refused, so the page can still reveal what it just sealed. */
  private readonly unsaved = new Map<string, Uint8Array>();
  private migration: Promise<void> | null = null;

  constructor(options: EncryptedReviewKeyStorageOptions) {
    this.vault = options.vault;
    this.legacy = options.legacy;
    this.subtleOverride = options.subtle;
    this.randomOverride = options.randomBytes;
  }

  private subtle(): SubtleCrypto {
    const subtle =
      this.subtleOverride ??
      (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (subtle === undefined) throw new Error("WebCrypto is unavailable.");
    return subtle;
  }

  private random(length: number): Uint8Array {
    if (this.randomOverride !== undefined) return this.randomOverride(length);
    return (globalThis as { crypto: Crypto }).crypto.getRandomValues(
      new Uint8Array(length),
    );
  }

  async load(paperId: string): Promise<Uint8Array | null> {
    const id = cleanId(paperId);
    if (id === "") return null;
    await this.migrate();
    try {
      const sealed = await this.vault.read(seedRecord(id));
      if (sealed !== null) {
        const key = await this.vault.encryptionKey();
        const seed = await this.subtle().decrypt(
          { name: "AES-GCM", iv: toUint8Array(sealed.iv), additionalData: boundTo(id) },
          key,
          toUint8Array(sealed.ciphertext),
        );
        return new Uint8Array(seed);
      }
    } catch {
      // A seed that cannot be opened (its key is gone) is as good as absent.
    }
    const unsaved = this.unsaved.get(id);
    return unsaved === undefined ? null : new Uint8Array(unsaved);
  }

  async save(paperId: string, seed: Uint8Array): Promise<void> {
    const id = cleanId(paperId);
    if (id === "") return;
    await this.migrate();
    try {
      await this.seal(id, seed);
      this.unsaved.delete(id);
    } catch {
      // The vault refused (private mode, quota): the review can still be
      // revealed from this page.
      this.unsaved.set(id, new Uint8Array(seed));
    }
  }

  async forget(paperId: string): Promise<void> {
    const id = cleanId(paperId);
    if (id === "") return;
    this.unsaved.delete(id);
    try {
      await this.vault.remove(seedRecord(id));
    } catch {
      // Nothing to forget.
    }
  }

  /** Seal `seed` under the vault's key and store it; rejects if it cannot. */
  private async seal(id: string, seed: Uint8Array): Promise<void> {
    const key = await this.vault.encryptionKey();
    const iv = toUint8Array(this.random(IV_BYTES));
    const ciphertext = await this.subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: boundTo(id) },
      key,
      toUint8Array(seed),
    );
    await this.vault.write(seedRecord(id), {
      iv,
      ciphertext: new Uint8Array(ciphertext),
    });
  }

  /**
   * Move the plaintext seeds an earlier version kept in `localStorage` into
   * the vault, once per page. Best effort: it never rejects, and an entry is
   * removed only after the vault has it.
   */
  private migrate(): Promise<void> {
    if (this.migration === null) this.migration = this.migrateLegacy();
    return this.migration;
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = this.legacy;
    if (legacy === undefined) return;
    try {
      const keys: string[] = [];
      for (let index = 0; index < legacy.length; index += 1) {
        const key = legacy.key(index);
        if (key !== null && key.startsWith(REVIEW_KEY_STORAGE_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        const id = key.slice(REVIEW_KEY_STORAGE_PREFIX.length);
        const seed = legacySeed(legacy.getItem(key));
        if (id === "" || seed === null) continue;
        try {
          // What the vault already holds for the paper is newer than a
          // leftover from before; do not replace it.
          if ((await this.vault.read(seedRecord(id))) === null) await this.seal(id, seed);
          legacy.removeItem(key);
        } catch {
          // The vault would not take it: leave the entry, rather than lose it,
          // and let this page use it; the next page tries again.
          this.unsaved.set(id, seed);
        }
      }
    } catch {
      // `localStorage` itself refused (private mode): nothing to migrate.
    }
  }
}

function localStorageOrUndefined(): LegacySeedStorage | undefined {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Access can throw in private-mode browsers or sandboxed iframes.
  }
  return undefined;
}

/**
 * The best storage this environment offers: the encrypted vault where
 * IndexedDB and WebCrypto are present, otherwise memory.
 */
export function createReviewKeyStorage(): ReviewKeyStorage {
  const vault = new IndexedDbReviewVault();
  if (!vault.isAvailable()) return new MemoryReviewKeyStorage();
  return new EncryptedReviewKeyStorage({ vault, legacy: localStorageOrUndefined() });
}

let resolved: ReviewKeyStorage | undefined;

function resolve(): ReviewKeyStorage {
  if (resolved === undefined) resolved = createReviewKeyStorage();
  return resolved;
}

/**
 * The page's review key storage, chosen on first use (never while rendering on
 * the server, where there is no IndexedDB to choose).
 */
export const browserReviewKeyStorage: ReviewKeyStorage = {
  load: (paperId) => resolve().load(paperId),
  save: (paperId, seed) => resolve().save(paperId, seed),
  forget: (paperId) => resolve().forget(paperId),
};
