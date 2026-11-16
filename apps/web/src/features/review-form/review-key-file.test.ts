// @vitest-environment node
import { describe, expect, it } from "vitest";

import { KeyFileError, PBKDF2_MIN_ITERATIONS, encryptWithPassphrase } from "./passphrase-box";
import {
  buildReviewKeyFile,
  decryptReviewKeyFile,
  encryptReviewKeyFile,
  forgetReviewKey,
  loadReviewKey,
  reviewKeyFromSeed,
  saveReviewKey,
} from "./review-key";
import { MemoryReviewKeyStorage, type ReviewKeyStorage } from "./review-key-storage";
import type { SealedReview } from "./sealed-review";

/**
 * The review key file a reviewer carries to another browser, and the seed kept
 * in this one. The file is encrypted with a passphrase; the seed is never in
 * the clear.
 */

const FAST = { iterations: PBKDF2_MIN_ITERATIONS } as const;
const PASSPHRASE = "correct horse battery staple";
const SEED = new Uint8Array(32).fill(7);
const KEY = reviewKeyFromSeed(SEED);
const SEED_BASE64 = Buffer.from(SEED).toString("base64");

const SEALED: SealedReview = {
  paperId: "sch:6sel-2dio-orm6",
  versionCid: "bafyversion",
  reviewCid: "bafycommit",
  revealAt: "2026-12-14T00:00:00.000Z",
  commitment: "a1b2c3d4e5f6",
  revealBody: {
    target: "bafyversion",
    scores: {
      soundness: { score: 4, justification: "The design is sound and carefully argued." },
      evidence: { score: 3, justification: "One claim is unsupported by the data." },
    },
    confidence: "high",
    recommendation: "minor_revisions",
    signed: true,
  },
};

async function problemOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof KeyFileError ? error.problem : `other: ${String(error)}`;
  }
  return undefined;
}

describe("the downloaded review key file", () => {
  it("holds the seed, the scores and the justifications only encrypted", async () => {
    const text = await encryptReviewKeyFile(SEALED, KEY, PASSPHRASE, FAST);

    // Not one of the things the plaintext file used to carry is readable.
    expect(text).not.toContain(SEED_BASE64);
    expect(text).not.toContain("seed");
    expect(text).not.toContain("justification");
    expect(text).not.toContain("The design is sound");
    expect(text).not.toContain("score");
    expect(text).not.toContain(SEALED.paperId);
    expect(text).not.toContain(SEALED.reviewCid);
    expect(text).not.toContain(SEALED.commitment);
  });

  it("is JSON that says how it was encrypted: PBKDF2-SHA256, 310 000 or more, AES-GCM", async () => {
    const envelope = JSON.parse(await encryptReviewKeyFile(SEALED, KEY, PASSPHRASE));

    expect(envelope.kdf.name).toBe("PBKDF2");
    expect(envelope.kdf.hash).toBe("SHA-256");
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(310_000);
    expect(envelope.cipher.name).toBe("AES-GCM");
  });

  it("opens with the passphrase to the sealed review and the same key", async () => {
    const text = await encryptReviewKeyFile(SEALED, KEY, PASSPHRASE, FAST);

    const opened = await decryptReviewKeyFile(text, PASSPHRASE, FAST);

    expect(opened.sealed).toEqual(SEALED);
    expect(opened.key.did).toBe(KEY.did);
    expect(opened.key.seed).toEqual(SEED);
  });

  it("does not open with another passphrase", async () => {
    const text = await encryptReviewKeyFile(SEALED, KEY, PASSPHRASE, FAST);

    expect(await problemOf(decryptReviewKeyFile(text, "not the passphrase", FAST))).toBe(
      "wrong-passphrase",
    );
  });

  it("is not asked for without a passphrase", async () => {
    expect(await problemOf(encryptReviewKeyFile(SEALED, KEY, "", FAST))).toBe("empty-passphrase");
  });
});

describe("a file that is not an encrypted review key file", () => {
  it("is turned away when it is the plaintext file an earlier version wrote", async () => {
    const plaintext = JSON.stringify(buildReviewKeyFile(SEALED, KEY), null, 2);

    expect(await problemOf(decryptReviewKeyFile(plaintext, PASSPHRASE, FAST))).toBe(
      "not-encrypted",
    );
  });

  it("is turned away when it is not JSON at all", async () => {
    expect(await problemOf(decryptReviewKeyFile("%PDF-1.7 …", PASSPHRASE, FAST))).toBe(
      "not-encrypted",
    );
  });

  it("is turned away when it opens to something that is not a review key", async () => {
    const envelope = await encryptWithPassphrase(
      new TextEncoder().encode(JSON.stringify({ hello: "world" })),
      PASSPHRASE,
      FAST,
    );

    expect(await problemOf(decryptReviewKeyFile(JSON.stringify(envelope), PASSPHRASE, FAST))).toBe(
      "malformed",
    );
  });
});

describe("the seed kept on this device", () => {
  it("is saved, loaded as the same key, and forgotten", async () => {
    const storage = new MemoryReviewKeyStorage();

    await saveReviewKey(SEALED.paperId, KEY, storage);
    const loaded = await loadReviewKey(SEALED.paperId, storage);

    expect(loaded?.did).toBe(KEY.did);
    expect(loaded?.seed).toEqual(SEED);

    await forgetReviewKey(SEALED.paperId, storage);
    expect(await loadReviewKey(SEALED.paperId, storage)).toBeNull();
  });

  it("is absent for a paper it was never given", async () => {
    expect(await loadReviewKey(SEALED.paperId, new MemoryReviewKeyStorage())).toBeNull();
  });

  it("never throws when the storage does", async () => {
    const broken: ReviewKeyStorage = {
      load: async () => {
        throw new Error("no");
      },
      save: async () => {
        throw new Error("no");
      },
      forget: async () => {
        throw new Error("no");
      },
    };

    await expect(saveReviewKey(SEALED.paperId, KEY, broken)).resolves.toBeUndefined();
    await expect(loadReviewKey(SEALED.paperId, broken)).resolves.toBeNull();
    await expect(forgetReviewKey(SEALED.paperId, broken)).resolves.toBeUndefined();
  });

  it("is not read back as a key when it is not a seed", async () => {
    const odd: ReviewKeyStorage = {
      load: async () => new Uint8Array(5),
      save: async () => undefined,
      forget: async () => undefined,
    };

    expect(await loadReviewKey(SEALED.paperId, odd)).toBeNull();
  });
});
