import { describe, expect, it } from "vitest";

import {
  deriveReviewKey,
  nullifierForReviewKey,
  reviewKeyFromSeed,
  signWithReviewKey,
} from "./review-key";

const SEED = new Uint8Array(32).fill(7);

describe("reviewKeyFromSeed", () => {
  it("turns a 32-byte seed into a pseudonymous did:key", () => {
    const key = reviewKeyFromSeed(SEED);

    expect(key.seed).toHaveLength(32);
    expect(key.publicKey).toHaveLength(32);
    expect(key.did).toMatch(/^did:key:z6Mk/);
  });

  it("is deterministic for a seed", () => {
    expect(reviewKeyFromSeed(SEED)).toEqual(reviewKeyFromSeed(SEED));
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => reviewKeyFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("deriveReviewKey", () => {
  const signChallenge = async () => new Uint8Array(64).fill(3);

  it("derives the same key for the same paper and device", async () => {
    const first = await deriveReviewKey("sch:6sel-2dio-orm6", signChallenge);
    const second = await deriveReviewKey("sch:6sel-2dio-orm6", signChallenge);

    expect(first.did).toBe(second.did);
  });

  it("derives a different key for another paper", async () => {
    const thisPaper = await deriveReviewKey("sch:6sel-2dio-orm6", signChallenge);
    const otherPaper = await deriveReviewKey("sch:k3f9-q2xz-7mwd", signChallenge);

    expect(thisPaper.did).not.toBe(otherPaper.did);
  });

  it("refuses an empty paper id before prompting", async () => {
    const sign = async () => new Uint8Array(64);
    await expect(deriveReviewKey("  ", sign)).rejects.toThrow(/paper id/);
  });
});

describe("nullifierForReviewKey", () => {
  const key = reviewKeyFromSeed(SEED);

  it("is stable for one reviewer and one paper, as lowercase hex", () => {
    const first = nullifierForReviewKey(key, "sch:6sel-2dio-orm6");
    const second = nullifierForReviewKey(key, "sch:6sel-2dio-orm6");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for another paper", () => {
    expect(nullifierForReviewKey(key, "sch:6sel-2dio-orm6")).not.toBe(
      nullifierForReviewKey(key, "sch:k3f9-q2xz-7mwd"),
    );
  });
});

describe("signWithReviewKey", () => {
  it("signs with the derived key, verifiably", async () => {
    const { verify } = await import("@noble/ed25519");
    const key = reviewKeyFromSeed(SEED);
    const message = new TextEncoder().encode("a review.commit cid");

    const signature = signWithReviewKey(key, message);

    expect(signature).toHaveLength(64);
    expect(verify(signature, message, key.publicKey)).toBe(true);
  });
});
