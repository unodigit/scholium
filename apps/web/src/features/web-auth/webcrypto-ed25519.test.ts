// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  assertNonExtractablePrivateKey,
  createEd25519Crypto,
  ed25519Crypto,
  isEd25519Supported,
  resolveCrypto,
  type CryptoProvider,
} from "./webcrypto-ed25519";
import { DeviceKeyError } from "./errors";

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DeviceKeyError);
  expect((thrown as DeviceKeyError).code).toBe(code);
}

async function rejectionFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

const subtle = globalThis.crypto.subtle;

describe("Ed25519 WebCrypto provider", () => {
  it("reports Ed25519 support in this runtime", () => {
    expect(isEd25519Supported()).toBe(true);
    expect(ed25519Crypto.isSupported()).toBe(true);
  });

  it("generates a non-extractable private key and an exportable public key", async () => {
    const pair = await ed25519Crypto.generateKeyPair();

    expect(pair.privateKey.type).toBe("private");
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.algorithm.name).toBe("Ed25519");
    expect(pair.privateKey.usages).toContain("sign");

    expect(pair.publicKey.type).toBe("public");
    expect(pair.publicKey.extractable).toBe(true);
    expect(pair.publicKey.usages).toContain("verify");
  });

  it("refuses to export the private key, so it never leaves the device", async () => {
    const pair = await ed25519Crypto.generateKeyPair();

    const error = await rejectionFrom(subtle.exportKey("pkcs8", pair.privateKey));
    expect((error as { name?: string }).name).toMatch(/InvalidAccess/);

    // Sanity check: the public half is exportable.
    const raw = await subtle.exportKey("raw", pair.publicKey);
    expect(raw.byteLength).toBe(ED25519_PUBLIC_KEY_LENGTH);
  });

  it("exports a raw 32-byte public key and re-imports it", async () => {
    const pair = await ed25519Crypto.generateKeyPair();
    const raw = await ed25519Crypto.exportPublicKey(pair.publicKey);
    expect(raw).toHaveLength(ED25519_PUBLIC_KEY_LENGTH);

    const imported = await ed25519Crypto.importPublicKey(raw);
    expect(imported.type).toBe("public");
    expect(imported.extractable).toBe(true);
  });

  it("signs and verifies, and rejects tampering", async () => {
    const pair = await ed25519Crypto.generateKeyPair();
    const payload = new TextEncoder().encode("POST /v1/auth/challenge nonce");

    const signature = await ed25519Crypto.sign(pair.privateKey, payload);
    expect(signature).toHaveLength(ED25519_SIGNATURE_LENGTH);
    await expect(ed25519Crypto.verify(pair.publicKey, signature, payload)).resolves.toBe(true);

    const tampered = Uint8Array.from(payload);
    tampered[0] ^= 0xff;
    await expect(
      ed25519Crypto.verify(pair.publicKey, signature, tampered),
    ).resolves.toBe(false);

    const badSignature = Uint8Array.from(signature);
    badSignature[10] ^= 0xff;
    await expect(
      ed25519Crypto.verify(pair.publicKey, badSignature, payload),
    ).resolves.toBe(false);
  });

  it("treats a wrong-length signature as invalid instead of throwing", async () => {
    const pair = await ed25519Crypto.generateKeyPair();
    await expect(
      ed25519Crypto.verify(
        pair.publicKey,
        Uint8Array.of(1, 2, 3),
        new Uint8Array(4),
      ),
    ).resolves.toBe(false);
  });

  it("rejects an extractable private key before signing", async () => {
    const exportable = await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    expect(exportable).toHaveProperty("privateKey");
    const pair = exportable as CryptoKeyPair;

    expectCode(
      () => assertNonExtractablePrivateKey(pair.privateKey),
      "invalid-key",
    );
    await expect(
      ed25519Crypto.sign(pair.privateKey, new Uint8Array(1)),
    ).rejects.toMatchObject({ code: "invalid-key" });
  });

  it("produces random bytes of the requested length", () => {
    const a = ed25519Crypto.randomBytes(32);
    const b = ed25519Crypto.randomBytes(32);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toEqual(b);
    expectCode(() => ed25519Crypto.randomBytes(0), "invalid-key");
  });

  it("raises unsupported when WebCrypto is absent", async () => {
    const broken = createEd25519Crypto({} as CryptoProvider);
    expect(broken.isSupported()).toBe(false);
    expectCode(() => resolveCrypto({} as CryptoProvider), "unsupported");
    await expect(broken.generateKeyPair()).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("wraps a WebCrypto signing failure as signing-failed", async () => {
    const pair = await ed25519Crypto.generateKeyPair();
    const broken: CryptoProvider = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T =>
        globalThis.crypto.getRandomValues(
          array as ArrayBufferView<ArrayBuffer>,
        ) as T,
      subtle: {
        generateKey: subtle.generateKey.bind(subtle),
        sign: async () => {
          throw new Error("kaboom");
        },
      } as unknown as SubtleCrypto,
    };
    const provider = createEd25519Crypto(broken);
    await expect(
      provider.sign(pair.privateKey, new Uint8Array(1)),
    ).rejects.toMatchObject({ code: "signing-failed" });
  });
});
