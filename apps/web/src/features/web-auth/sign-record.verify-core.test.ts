// @vitest-environment node
//
// `signRecord` against the real verify-core (dag-cbor + multiformats), and
// against the shared cross-language signature vectors the Python record core
// is tested with.
//
// The suite is skipped, visibly, when those packages are not installed; it
// never swallows any other import failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
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

// `@noble/ed25519` v2 needs a SHA-512 implementation wired before it signs
// synchronously.  verify-core does this at module load; pin it here too so the
// vector signer never depends on import order.
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  sha512(ed.etc.concatBytes(...messages));

const VECTORS_PATH = new URL(
  "../../../../api/packages/record-core/vectors/signatures.json",
  import.meta.url,
);

interface SignatureVector {
  name: string;
  key: string;
  envelope: {
    v: number;
    type: string;
    author: string;
    created: string;
    prev: string | null;
    body: Record<string, unknown>;
    proofs: unknown[];
  };
  dag_cbor_hex: string;
  id: string;
  sig: string;
}

interface SignatureVectors {
  keys: Array<{ name: string; seed_hex: string; did_key: string }>;
  vectors: SignatureVector[];
}

function loadSignatureVectors(): SignatureVectors {
  return JSON.parse(
    readFileSync(fileURLToPath(VECTORS_PATH), "utf8"),
  ) as SignatureVectors;
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

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
  it("returns an id verify-core reproduces and a signature over the record bytes", async () => {
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

    // The signed preimage is the canonical DAG-CBOR record bytes, the same
    // bytes the id hashes over -- not the binary CID.
    expect(
      await verify(core.recordBytes(record), fromBase64Url(record.sig)),
    ).toBe(true);
    expect(core.verifyEnvelope(record, record.sig)).toBe(true);
    expect(core.verifyRecord(record)).toBe(true);

    // Regression: signing the binary CID is the defect this suite pins.
    expect(
      await verify(core.computeRecordCid(record).bytes, fromBase64Url(record.sig)),
    ).toBe(false);
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

describe.skipIf(verifyCore === null)(
  "signRecord against the shared record-core signature vectors",
  () => {
    // Cross-language pin: Python's `test_signature_vectors.py` signs these same
    // fixed keys and bodies with `sign_envelope` and expects these ids and
    // signatures.  The web signer must reproduce them byte for byte, which is
    // only possible when both sides sign `record_bytes(envelope)`.
    it("reproduces the Python core's id and signature for a fixed key and body", async () => {
      const doc = loadSignatureVectors();
      const key = doc.keys.find((candidate) => candidate.name === "author-a");
      const vector = doc.vectors.find(
        (candidate) => candidate.name === "paper-genesis-signed",
      );
      expect(key).toBeDefined();
      expect(vector).toBeDefined();

      const seed = fromHex(key!.seed_hex);
      expect(key!.did_key).toBe(vector!.envelope.author);

      const signed: Uint8Array[] = [];
      const signer: RecordSigner = {
        didKey: async () => vector!.envelope.author,
        signWithPasskey: async (data) => {
          signed.push(data);
          return ed.sign(data, seed);
        },
      };

      const record = await signRecord(
        vector!.envelope.type,
        vector!.envelope.body,
        vector!.envelope.prev,
        {
          signer,
          proofs: vector!.envelope.proofs,
          now: () => Date.parse(vector!.envelope.created),
        },
      );

      // The bytes handed to the signer are exactly the vector's DAG-CBOR.
      expect(signed).toHaveLength(1);
      expect(toHex(signed[0])).toBe(vector!.dag_cbor_hex);
      expect(record).toMatchObject(vector!.envelope);
      expect(record.id).toBe(vector!.id);
      expect(record.sig).toBe(vector!.sig);

      const core = verifyCore!;
      expect(core.verifyEnvelope(record, record.sig)).toBe(true);
      expect(core.verifyRecord(record)).toBe(true);
    });
  },
);
