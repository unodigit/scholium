import { describe, expect, it } from "vitest";

import {
  ED25519_MULTICODEC,
  decodeBase58,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
  encodeBase58,
  isEd25519DidKey,
} from "./did-key";
import { concatBytes, fromHex, toHex } from "./encoding";
import { DeviceKeyError } from "./errors";

function errorFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

function expectCode(run: () => unknown, code: string): void {
  const error = errorFrom(run);
  expect(error).toBeInstanceOf(DeviceKeyError);
  expect((error as DeviceKeyError).code).toBe(code);
}

/** RFC 8032 test public key, also used by the W3C did:key vectors. */
const SAMPLE_PUBLIC_KEY_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

const SAMPLE_DID =
  "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";

describe("base58btc", () => {
  it("matches reference vectors", () => {
    expect(encodeBase58(new Uint8Array(0))).toBe("");
    expect(encodeBase58(Uint8Array.of(0))).toBe("1");
    expect(encodeBase58(Uint8Array.of(0, 0, 1))).toBe("112");
    expect(encodeBase58(new TextEncoder().encode("Hello World!"))).toBe(
      "2NEpo7TZRRrLZSi2U",
    );
    expect(encodeBase58(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))).toBe(
      "kA3B2yGe2z4",
    );
  });

  it("round-trips values with leading zero bytes", () => {
    const vectors = [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0, 0, 255),
      Uint8Array.of(255),
      Uint8Array.of(1, 0, 0),
      Uint8Array.of(0, 1, 0, 0, 2),
    ];
    for (const bytes of vectors) {
      expect([...decodeBase58(encodeBase58(bytes))]).toEqual([...bytes]);
    }
  });

  it("round-trips a 34-byte multikey", () => {
    const multikey = concatBytes(
      ED25519_MULTICODEC,
      fromHex(SAMPLE_PUBLIC_KEY_HEX),
    );
    expect(encodeBase58(multikey)).toBe(SAMPLE_DID.slice("did:key:z".length));
    expect([...decodeBase58(encodeBase58(multikey))]).toEqual([...multikey]);
  });

  it("rejects characters outside the alphabet", () => {
    expectCode(() => decodeBase58("0OIl"), "invalid-encoding");
  });
});

describe("did:key", () => {
  it("derives the canonical Ed25519 did:key", () => {
    const publicKey = fromHex(SAMPLE_PUBLIC_KEY_HEX);
    expect(didKeyFromEd25519PublicKey(publicKey)).toBe(SAMPLE_DID);
  });

  it("round-trips did:key to public key bytes", () => {
    const publicKey = fromHex(SAMPLE_PUBLIC_KEY_HEX);
    const did = didKeyFromEd25519PublicKey(publicKey);
    expect(toHex(ed25519PublicKeyFromDidKey(did))).toBe(SAMPLE_PUBLIC_KEY_HEX);
  });

  it("requires exactly 32 public-key bytes", () => {
    expectCode(
      () => didKeyFromEd25519PublicKey(new Uint8Array(31)),
      "invalid-key",
    );
    expectCode(
      () => didKeyFromEd25519PublicKey(new Uint8Array(33)),
      "invalid-key",
    );
  });

  it("rejects non-did and non-base58 identifiers", () => {
    expectCode(() => ed25519PublicKeyFromDidKey("did:web:example.com"), "invalid-encoding");
    expectCode(() => ed25519PublicKeyFromDidKey("did:key:z0OIl"), "invalid-encoding");
  });

  it("rejects did:key values for other key types", () => {
    // A sha2-256 multihash has the 0x12 0x20 header, not the Ed25519 one.
    const notEd25519 = concatBytes(
      Uint8Array.of(0x12, 0x20),
      new Uint8Array(32),
    );
    const wrongDid = `did:key:z${encodeBase58(notEd25519)}`;
    expectCode(() => ed25519PublicKeyFromDidKey(wrongDid), "invalid-encoding");
  });

  it("classifies identifiers", () => {
    expect(isEd25519DidKey(SAMPLE_DID)).toBe(true);
    expect(isEd25519DidKey("did:key:z6Mk")).toBe(false);
    expect(isEd25519DidKey("did:web:example.com")).toBe(false);
    expect(isEd25519DidKey(undefined)).toBe(false);
  });
});
