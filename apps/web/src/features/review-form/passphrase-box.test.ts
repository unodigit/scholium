// @vitest-environment node
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { fromBase64Url } from "../web-auth/encoding";
import {
  KEY_FILE_FORMAT,
  KEY_FILE_VERSION,
  KeyFileError,
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  decryptWithPassphrase,
  encryptWithPassphrase,
  type PassphraseEnvelope,
} from "./passphrase-box";

/**
 * The encrypted review key file's envelope: WebCrypto PBKDF2-SHA256 (at least
 * 310 000 iterations) into AES-GCM. These run the real WebCrypto of Node, so
 * what is asserted is what a browser would do.
 */

const FAST = { iterations: PBKDF2_MIN_ITERATIONS } as const;
const PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({ seed: "c2VjcmV0LXNlZWQ", justification: "Soundness is 4 of 5." }),
);

async function problemOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof KeyFileError ? error.problem : `other: ${String(error)}`;
  }
  return undefined;
}

describe("the key file envelope", () => {
  it("round-trips the contents under the passphrase", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const opened = await decryptWithPassphrase(envelope, "a long passphrase", FAST);

    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(PLAINTEXT));
  });

  it("says what it is and how to derive the key, and nothing of the contents", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const text = JSON.stringify(envelope);

    expect(envelope.format).toBe(KEY_FILE_FORMAT);
    expect(envelope.version).toBe(KEY_FILE_VERSION);
    expect(envelope.kdf.name).toBe("PBKDF2");
    expect(envelope.kdf.hash).toBe("SHA-256");
    expect(envelope.cipher.name).toBe("AES-GCM");
    // Neither the seed nor the review's words appear anywhere in the file.
    expect(text).not.toContain("c2VjcmV0LXNlZWQ");
    expect(text).not.toContain("Soundness");
    expect(text).not.toContain("seed");
  });

  it("writes at least 310 000 PBKDF2 iterations by default", async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310_000);
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase");

    expect(envelope.kdf.iterations).toBe(PBKDF2_ITERATIONS);
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(310_000);
  });

  it("asks WebCrypto for PBKDF2 with SHA-256, then an AES-GCM key", async () => {
    const subtle = globalThis.crypto.subtle;
    const deriveKey = vi.spyOn(subtle, "deriveKey");
    try {
      await encryptWithPassphrase(PLAINTEXT, "a long passphrase", { ...FAST, subtle });

      const [algorithm, , derived, extractable] = deriveKey.mock.calls[0] as unknown as [
        Pbkdf2Params,
        CryptoKey,
        AesKeyGenParams,
        boolean,
      ];
      expect(algorithm.name).toBe("PBKDF2");
      expect(algorithm.hash).toBe("SHA-256");
      expect(algorithm.iterations).toBeGreaterThanOrEqual(310_000);
      expect(derived.name).toBe("AES-GCM");
      expect(derived.length).toBe(256);
      expect(extractable).toBe(false);
    } finally {
      deriveKey.mockRestore();
    }
  });

  it("is plain PBKDF2-SHA256 and AES-256-GCM, so another tool can read it", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);

    const key = pbkdf2Sync(
      "a long passphrase",
      fromBase64Url(envelope.kdf.salt),
      envelope.kdf.iterations,
      32,
      "sha256",
    );
    const sealed = fromBase64Url(envelope.ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, fromBase64Url(envelope.cipher.iv));
    decipher.setAAD(Buffer.from(`${KEY_FILE_FORMAT}:${KEY_FILE_VERSION}`));
    decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);

    expect(plain.toString("utf8")).toBe(new TextDecoder().decode(PLAINTEXT));
  });

  it("uses a fresh salt and IV every time", async () => {
    const first = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const second = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);

    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.cipher.iv).not.toBe(second.cipher.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("does not open under a different passphrase", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);

    expect(await problemOf(decryptWithPassphrase(envelope, "another passphrase", FAST))).toBe(
      "wrong-passphrase",
    );
  });

  it("does not open once the ciphertext was changed", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const bytes = fromBase64Url(envelope.ciphertext);
    bytes[0] ^= 1;
    const tampered: PassphraseEnvelope = {
      ...envelope,
      ciphertext: Buffer.from(bytes).toString("base64url"),
    };

    expect(await problemOf(decryptWithPassphrase(tampered, "a long passphrase", FAST))).toBe(
      "wrong-passphrase",
    );
  });

  it("treats a passphrase typed in another Unicode form as the same one", async () => {
    const composed = "café au lait";
    const decomposed = "café au lait";
    const envelope = await encryptWithPassphrase(PLAINTEXT, composed, FAST);

    const opened = await decryptWithPassphrase(envelope, decomposed, FAST);

    expect(opened).toEqual(PLAINTEXT);
  });

  it("refuses an empty passphrase, to write or to read", async () => {
    expect(await problemOf(encryptWithPassphrase(PLAINTEXT, "", FAST))).toBe("empty-passphrase");
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    expect(await problemOf(decryptWithPassphrase(envelope, "", FAST))).toBe("empty-passphrase");
  });
});

describe("the iteration count", () => {
  it("is never written below the minimum", async () => {
    await expect(
      encryptWithPassphrase(PLAINTEXT, "a long passphrase", {
        iterations: PBKDF2_MIN_ITERATIONS - 1,
      }),
    ).rejects.toThrow(/at least 310000/);
  });

  it("is refused on a file that asks for less than the minimum", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const weak = { ...envelope, kdf: { ...envelope.kdf, iterations: 1000 } };

    expect(await problemOf(decryptWithPassphrase(weak, "a long passphrase", FAST))).toBe(
      "unsupported",
    );
  });

  it("is refused on a file that would hang the page", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);
    const heavy = {
      ...envelope,
      kdf: { ...envelope.kdf, iterations: PBKDF2_MAX_ITERATIONS + 1 },
    };

    expect(await problemOf(decryptWithPassphrase(heavy, "a long passphrase", FAST))).toBe(
      "unsupported",
    );
  });
});

describe("a file that is not an encrypted key file", () => {
  it("is named as not encrypted, for the plaintext file an earlier version wrote", async () => {
    const legacy = {
      paperId: "sch:6sel-2dio-orm6",
      versionCid: "bafyversion",
      reviewCid: "bafycommit",
      revealAt: "2026-12-14T00:00:00.000Z",
      commitment: "a1b2c3",
      revealBody: {},
      seed: "c2VlZA==",
    };

    expect(await problemOf(decryptWithPassphrase(legacy, "a long passphrase", FAST))).toBe(
      "not-encrypted",
    );
  });

  it.each([null, "text", 42, [], {}])("is named as not encrypted: %j", async (raw) => {
    expect(await problemOf(decryptWithPassphrase(raw, "a long passphrase", FAST))).toBe(
      "not-encrypted",
    );
  });

  it("is unsupported when it is another version", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);

    expect(
      await problemOf(decryptWithPassphrase({ ...envelope, version: 99 }, "a long passphrase", FAST)),
    ).toBe("unsupported");
  });

  it("is malformed when a part is missing or garbled", async () => {
    const envelope = await encryptWithPassphrase(PLAINTEXT, "a long passphrase", FAST);

    expect(
      await problemOf(
        decryptWithPassphrase({ ...envelope, ciphertext: "" }, "a long passphrase", FAST),
      ),
    ).toBe("malformed");
    expect(
      await problemOf(
        decryptWithPassphrase(
          { ...envelope, kdf: { ...envelope.kdf, salt: "***" } },
          "a long passphrase",
          FAST,
        ),
      ),
    ).toBe("malformed");
    expect(
      await problemOf(
        decryptWithPassphrase({ ...envelope, cipher: undefined }, "a long passphrase", FAST),
      ),
    ).toBe("malformed");
  });
});
