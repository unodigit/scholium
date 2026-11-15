// The default Vitest environment in this app is JSDOM, which participates in
// the same `"browser"` package-resolution path a real browser build uses.
//
// This suite deliberately does NOT opt into the node environment: it is the
// guard that `verifyPaper` and record ids keep working in a browser-like
// realm, where `multiformats/hashes/sha2` resolves to its async WebCrypto
// implementation and `@ipld/dag-cbor` may hand back a foreign-realm buffer.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { computeRecordId } from "./envelope";
import { verifyEnvelope, verifyRecord } from "./signing";
import { CHECK_NAMES, verifyPaper } from "./verify-paper";

/** The vectors live in `apps/api`, next door to this `apps/web` package. */
function vectorsPath(): string {
  const relative = "api/packages/record-core/vectors/verification.json";
  const candidates = [
    resolve(process.cwd(), "../api/packages/record-core/vectors/verification.json"),
    resolve(process.cwd(), relative),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

interface Vector {
  name: string;
  records: Array<Record<string, any>>;
  ids: Record<string, string>;
  call: Record<string, unknown>;
  expect: {
    status: string;
    version_count: number;
    signers: string[];
    checks: Record<string, boolean>;
  };
}

interface Document {
  keys: Array<{ name: string; did_key: string }>;
  vectors: Vector[];
}

const doc = JSON.parse(readFileSync(vectorsPath(), "utf8")) as Document;

const dids = Object.fromEntries(
  doc.keys.map((key) => [key.did_key, key.name]),
);

describe("verify-core in a browser-like environment", () => {
  it("is running under JSDOM rather than the bare node environment", () => {
    expect(typeof globalThis.window).toBe("object");
  });

  it("computes the shared record ids", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "verified-three-versions",
    )!;
    for (const record of vector.records) {
      expect(computeRecordId(record), record.type).toBe(record.id);
    }
  });

  it("authenticates signatures without Node crypto", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "verified-single-version",
    )!;
    for (const record of vector.records) {
      expect(verifyEnvelope(record, record.sig), record.type).toBe(true);
      expect(verifyRecord(record), record.type).toBe(true);
    }
  });

  it("reaches every vector's verdict", () => {
    for (const vector of doc.vectors) {
      const report = verifyPaper(vector.records, vector.call);
      expect(report.status, vector.name).toBe(vector.expect.status);
      expect(report.version_count, vector.name).toBe(
        vector.expect.version_count,
      );
      expect(
        report.signers.map((did) => dids[did]),
        vector.name,
      ).toEqual(vector.expect.signers);
      expect(
        Object.fromEntries(
          Object.entries(report.checks).map(([name, check]) => [
            name,
            check.passed,
          ]),
        ),
        vector.name,
      ).toEqual(vector.expect.checks);
      expect(Object.keys(report.checks), vector.name).toEqual([
        ...CHECK_NAMES,
      ]);
    }
  });
});
