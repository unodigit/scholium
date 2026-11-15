// @vitest-environment node
//
// `signRecord` against the real verify-core (dag-cbor + multiformats).
//
// The suite is skipped, visibly, when those packages are not installed; it
// never swallows any other import failure.
import { describe, expect, it } from "vitest";

import { didKeyFromEd25519PublicKey } from "./did-key";
import { fromBase64Url } from "./encoding";
import { createEd25519Crypto } from "./webcrypto-ed25519";
import { signRecord, type RecordSigner } from "./sign-record";

type VerifyCore = typeof import("../verify-core");

const MISSING_DEPENDENCY = /Cannot find (package|module)|Failed to (resolve|load)/i;

async function loadVerifyCore(): Promise<VerifyCore | null> {
  try {
    return await import("../verify-core");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_DEPENDENCY.test(message)) {
      return null;
    }
    throw error;
  }
}

const verifyCore = await loadVerifyCore();

async function createSigner() {
  const ed25519 = createEd25519Crypto();
  const pair = await ed25519.generateKeyPair();
  const prompts: Uint8Array[] = [];
  const signer: RecordSigner = {
    didKey: async () =>
      didKeyFromEd25519PublicKey(await ed25519.exportPublicKey(pair.publicKey)),
    signWithPasskey: async (data) => {
      prompts.push(data);
      return ed25519.sign(pair.privateKey, data);
    },
  };
  const verify = (data: Uint8Array, signature: Uint8Array) =>
    ed25519.verify(pair.publicKey, signature, data);
  return { signer, prompts, verify };
}

describe.skipIf(verifyCore === null)("signRecord with the real verify-core", () => {
  it("returns an id verify-core reproduces and a signature over that CID", async () => {
    const core = verifyCore!;
    const { signer, verify } = await createSigner();

    const record = await signRecord(
      "paper.genesis",
      {
        title: "A Minimal Scholium Paper",
        licence: "CC-BY-4.0",
        categories: ["mathematics"],
      },
      null,
      { signer, now: () => Date.UTC(2026, 10, 14, 5, 33, 0) },
    );

    expect(record.id).toMatch(/^bafyrei/);
    // `id` and `sig` are excluded from the hash, so recomputing over the full
    // signed envelope must give back the id signRecord reported.
    expect(core.computeRecordId(record)).toBe(record.id);
    expect(
      await verify(core.computeRecordCid(record).bytes, fromBase64Url(record.sig)),
    ).toBe(true);
  });

  it("rejects what verify-core rejects as invalid-record, before any prompt", async () => {
    const { signer, prompts } = await createSigner();
    const invalid: Array<[string, Record<string, unknown>, string | null]> = [
      ["", {}, null],
      ["paper.genesis", [] as never, null],
      ["paper.genesis", {}, undefined as never],
    ];

    for (const [type, body, prev] of invalid) {
      await expect(signRecord(type, body, prev, { signer })).rejects.toMatchObject({
        name: "RecordSigningError",
        code: "invalid-record",
      });
    }
    expect(prompts).toHaveLength(0);
  });
});
