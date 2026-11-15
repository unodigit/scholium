// @vitest-environment node
//
// The whole record core against every shared cross-language vector.
//
// `verifyPaper` rests on record ids, Ed25519 signatures, `sch:` ids and
// manifest validation; these suites pin each of those helpers to the same
// JSON files the Python implementation is tested against.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodeCid } from "./cid-decode";
import { computeRecordId, recordBytes } from "./envelope";
import { FILE_FIELDS, parseFileCid, validateManifestBody } from "./manifest";
import {
  deriveShortId,
  formatVersionId,
  parseShortId,
  parseVersionId,
} from "./short-id";
import {
  decodeSignature,
  didKeyFromSeed,
  encodeSignature,
  isEd25519DidKey,
  publicKeyFromDidKey,
  signEnvelope,
  verifyEnvelope,
  verifyRecord,
} from "./signing";

type Json = Record<string, any>;

const VECTORS = new URL(
  "../../../../api/packages/record-core/vectors/",
  import.meta.url,
);

function load(name: string): Json {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(name, VECTORS)), "utf8"),
  ) as Json;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Replace the dotted `path` (list indices allowed) in a deep copy. */
function applySet(envelope: Json, path: string, value: unknown): Json {
  const mutated = structuredClone(envelope);
  const parts = path.split(".");
  let target: any = mutated;
  for (const part of parts.slice(0, -1)) {
    target = Array.isArray(target) ? target[Number(part)] : target[part];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(target)) {
    target[Number(last)] = value;
  } else {
    target[last] = value;
  }
  return mutated;
}

describe("vectors/records.json", () => {
  const doc = load("records.json");

  it("pins the CID parameters and hashed fields", () => {
    expect(doc.envelope_fields).toEqual([
      "v",
      "type",
      "author",
      "created",
      "prev",
      "body",
      "proofs",
    ]);
    expect(doc.excluded_fields).toEqual(["id", "sig"]);
    expect(doc.record_id).toMatchObject({
      cid_version: 1,
      codec: "dag-cbor",
      codec_code: "0x71",
      hash: "sha2-256",
      base: "base32",
    });
  });

  it("derives each canonical byte string and record id", () => {
    for (const vector of doc.vectors) {
      expect(toHex(recordBytes(vector.envelope)), vector.name).toBe(
        vector.dag_cbor_hex,
      );
      expect(computeRecordId(vector.envelope), vector.name).toBe(vector.id);
    }
  });
});

describe("vectors/signatures.json", () => {
  const doc = load("signatures.json");
  const keys: Record<string, Json> = Object.fromEntries(
    doc.keys.map((key: Json) => [key.name, key]),
  );
  const vectors: Record<string, Json> = Object.fromEntries(
    doc.vectors.map((vector: Json) => [vector.name, vector]),
  );

  it("pins Ed25519 over record bytes in unpadded base64url", () => {
    expect(doc.signature.algorithm).toBe("Ed25519");
    expect(doc.signature.encoding).toBe("base64url-unpadded");
    expect(doc.signature.preimage).toContain("record_bytes");
    expect(doc.did_key).toMatchObject({
      method: "did:key",
      multicodec: "0xed01",
      multicodec_name: "ed25519-pub",
      multibase: "base58btc",
      prefix: "did:key:z",
      public_key_length: 32,
    });
  });

  it("derives every key's did:key and public key from its seed alone", () => {
    for (const key of doc.keys) {
      const seed = fromHex(key.seed_hex);
      expect(didKeyFromSeed(seed), key.name).toBe(key.did_key);
      expect(toHex(publicKeyFromDidKey(key.did_key)), key.name).toBe(
        key.public_key_hex,
      );
      expect(isEd25519DidKey(key.did_key), key.name).toBe(true);
    }
  });

  it("reproduces and verifies every signature", () => {
    for (const vector of doc.vectors) {
      const seed = fromHex(keys[vector.key].seed_hex);
      expect(toHex(recordBytes(vector.envelope)), vector.name).toBe(
        vector.dag_cbor_hex,
      );
      expect(computeRecordId(vector.envelope), vector.name).toBe(vector.id);
      expect(signEnvelope(vector.envelope, seed), vector.name).toBe(
        vector.sig,
      );
      expect(decodeSignature(vector.sig), vector.name).toHaveLength(64);
      expect(verifyEnvelope(vector.envelope, vector.sig), vector.name).toBe(
        true,
      );
      expect(
        verifyRecord({
          ...vector.envelope,
          id: vector.id,
          sig: vector.sig,
        }),
        vector.name,
      ).toBe(true);
    }
  });

  it("rejects every invalid signature recipe", () => {
    for (const entry of doc.invalid) {
      const base = vectors[entry.base];
      let envelope = structuredClone(base.envelope);
      let sig: string = base.sig;
      for (const [path, value] of Object.entries(entry.set ?? {})) {
        envelope = applySet(envelope, path, value);
      }
      if (entry.sign_with) {
        sig = signEnvelope(envelope, fromHex(keys[entry.sign_with].seed_hex));
      }
      if (entry.corrupt_sig) {
        const raw = decodeSignature(sig);
        raw[raw.length - 1] ^= 1;
        sig = encodeSignature(raw);
      }
      expect(verifyEnvelope(envelope, sig), entry.name).toBe(false);
      expect(
        verifyRecord({ ...envelope, id: computeRecordId(envelope), sig }),
        entry.name,
      ).toBe(false);
    }
  });

  it("rejects every invalid did:key", () => {
    for (const entry of doc.invalid_did_keys) {
      expect(isEd25519DidKey(entry.input), entry.name).toBe(false);
      expect(() => publicKeyFromDidKey(entry.input), entry.name).toThrow();
    }
  });
});

describe("vectors/short_ids.json", () => {
  const doc = load("short_ids.json");

  it("derives every short id and version id", () => {
    for (const vector of doc.vectors) {
      expect(deriveShortId(vector.genesis_cid), vector.name).toBe(
        vector.short_id,
      );
      expect(toHex(decodeCid(vector.genesis_cid).multihash.digest), vector.name).toBe(
        vector.digest_hex,
      );
      for (const [number, versionId] of Object.entries(vector.version_ids)) {
        expect(formatVersionId(vector.short_id, Number(number)), vector.name).toBe(
          versionId,
        );
        expect(parseVersionId(versionId as string), vector.name).toEqual({
          shortId: vector.short_id,
          version: Number(number),
        });
      }
      expect(parseShortId(vector.short_id), vector.name).toBe(vector.short_id);
    }
  });

  it("parses paper and version ids, canonicalising case", () => {
    for (const entry of doc.parse) {
      if (entry.version === null) {
        expect(parseShortId(entry.input), entry.name).toBe(entry.short_id);
      } else {
        expect(parseVersionId(entry.input), entry.name).toEqual({
          shortId: entry.short_id,
          version: entry.version,
        });
      }
    }
  });

  it("rejects every invalid id with the stated error kind", () => {
    for (const entry of doc.invalid) {
      for (const parse of [parseShortId, parseVersionId]) {
        let message = "";
        try {
          parse(entry.input as string);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message.length, entry.name).toBeGreaterThan(0);
        expect(message.includes("checksum"), entry.name).toBe(
          entry.error === "checksum",
        );
      }
    }
  });
});

describe("vectors/file_ids.json", () => {
  const doc = load("file_ids.json");

  it("accepts every canonical file id and reads its digest", () => {
    for (const vector of doc.vectors) {
      const cid = decodeCid(vector.cid);
      expect(cid.version, vector.name).toBe(1);
      expect(cid.code, vector.name).toBe(0x55);
      expect(cid.multihash.code, vector.name).toBe(0x12);
      expect(toHex(cid.multihash.digest), vector.name).toBe(vector.digest_hex);
    }
  });

  it("rejects every invalid file id with the stated error kind", () => {
    const patterns: Record<string, RegExp> = {
      format: /must be a string|not a valid CID/,
      version: /not a raw file id/,
      codec: /not a raw file id/,
      hash: /not a raw file id/,
      canonical: /canonical base32/,
    };
    for (const entry of doc.invalid) {
      expect(() => parseFileCid(entry.input), entry.name).toThrow(
        patterns[entry.error],
      );
    }
  });
});

describe("vectors/manifests.json", () => {
  const doc = load("manifests.json");
  const patterns: Record<string, RegExp> = {
    body: /manifest (body|field)/,
    path: /path/,
    cid: /cid/,
    size: /size/,
    mediaType: /mediaType/,
    role: /role/,
    fields: /field|mapping/,
  };

  it("pins the manifest rules", () => {
    expect(doc.manifest.record_type).toBe("manifest");
    expect(doc.manifest.body_fields).toEqual(["files"]);
    expect(doc.manifest.file_fields).toEqual([...FILE_FIELDS]);
    expect(doc.manifest.max_path_length).toBe(1024);
  });

  it("canonicalises every valid body", () => {
    for (const vector of doc.vectors) {
      const { files } = validateManifestBody(vector.body);
      expect(files, vector.name).toEqual(vector.files);
      for (const entry of files) {
        expect(Object.keys(entry), vector.name).toEqual([...FILE_FIELDS]);
      }
    }
  });

  it("rejects every invalid body with the stated error kind", () => {
    for (const entry of doc.invalid) {
      expect(() => validateManifestBody(entry.body), entry.name).toThrow(
        patterns[entry.error],
      );
    }
  });
});
