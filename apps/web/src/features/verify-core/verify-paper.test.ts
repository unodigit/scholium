// @vitest-environment node
//
// `verifyPaper` against the shared cross-language vectors
// (`apps/api/packages/record-core/vectors/verification.json`).
//
// Each vector carries pre-built signed records, the ids they hash to and the
// report the Python `scholium_record_core.verify_paper` produces.  The browser
// port must reach the same verdict for every one, whatever the record order.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { didKeyFromSeed, verifyRecord } from "./signing";
import { deriveShortId } from "./short-id";
import verifyCore, { verifyPaper as verifyPaperFromIndex } from "./index";
import { verifyPaper as verifyPaperFromEntry } from "./verify-core";
import {
  CHECK_NAMES,
  STATUS_INVALID,
  VerificationReport,
  verifyPaper,
} from "./verify-paper";

interface VectorKey {
  name: string;
  seed_hex: string;
  did_key: string;
}

interface VectorRecord {
  id?: string;
  type?: string;
  author?: string;
  body?: Record<string, unknown>;
  [key: string]: unknown;
}

interface VerificationVector {
  name: string;
  records: VectorRecord[];
  ids: Record<string, string>;
  call: {
    paper?: string;
    head?: string;
    authorities?: string[];
  };
  expect: {
    status: string;
    version_count: number;
    signers: string[];
    genesis: string | null;
    head: string | null;
    checks: Record<string, boolean>;
    supersessions: Array<{ kind: string; applied: boolean }>;
  };
}

interface VerificationDocument {
  verification: {
    statuses: string[];
    status_precedence: string[];
    checks: string[];
  };
  keys: VectorKey[];
  vectors: VerificationVector[];
}

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../../../api/packages/record-core/vectors/verification.json",
    import.meta.url,
  ),
);

const doc = JSON.parse(
  readFileSync(VECTORS_PATH, "utf8"),
) as VerificationDocument;

const dids: Record<string, string> = Object.fromEntries(
  doc.keys.map((key) => [key.name, key.did_key]),
);

/** Deterministic Fisher-Yates, so a failure is reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Compare a report against the vector's expectation. */
function expectVectorReport(
  report: VerificationReport,
  vector: VerificationVector,
): void {
  const expected = vector.expect;
  const ids = vector.ids;
  expect(report.status, vector.name).toBe(expected.status);
  expect(report.valid, vector.name).toBe(expected.status !== STATUS_INVALID);
  expect(report.version_count, vector.name).toBe(expected.version_count);
  expect(report.signers, vector.name).toEqual(
    expected.signers.map((name) => dids[name]),
  );
  expect(report.genesis, vector.name).toBe(
    expected.genesis === null ? null : ids[expected.genesis],
  );
  expect(report.head, vector.name).toBe(
    expected.head === null ? null : ids[expected.head],
  );
  expect(
    Object.fromEntries(
      Object.entries(report.checks).map(([name, check]) => [name, check.passed]),
    ),
    vector.name,
  ).toEqual(expected.checks);
  expect(
    report.supersessions.map((item) => ({
      kind: item.kind,
      applied: item.applied,
    })),
    vector.name,
  ).toEqual(expected.supersessions);
}

describe("verification vectors", () => {
  it("pins the shared statuses, precedence and check order", () => {
    expect(doc.verification.statuses).toEqual([
      "verified",
      "corrected",
      "retracted",
      "tombstoned",
      "invalid",
    ]);
    expect(doc.verification.status_precedence).toEqual([
      "invalid",
      "retracted",
      "tombstoned",
      "corrected",
      "verified",
    ]);
    expect(doc.verification.checks).toEqual([...CHECK_NAMES]);
  });

  it("derives every key's did:key from its seed alone", () => {
    for (const key of doc.keys) {
      const seed = Uint8Array.from(Buffer.from(key.seed_hex, "hex"));
      expect(didKeyFromSeed(seed), key.name).toBe(key.did_key);
    }
  });

  describe.each(doc.vectors.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      it("matches the Python report", () => {
        expectVectorReport(verifyPaper(vector.records, vector.call), vector);
      });

      it("reaches the same verdict whatever the record order", () => {
        const reference = verifyPaper(vector.records, vector.call);
        for (const seed of [1, 7, 42, 1234]) {
          const shuffled = shuffle(vector.records, seed);
          expectVectorReport(verifyPaper(shuffled, vector.call), vector);
        }
        expect(verifyPaper(vector.records, vector.call).toDict()).toEqual(
          reference.toDict(),
        );
      });
    },
  );

  it("returns the Python report shape", () => {
    const vector = doc.vectors[0];
    const report = verifyPaper(vector.records, vector.call);
    const dict = report.toDict();
    expect(Object.keys(dict)).toEqual([
      "status",
      "valid",
      "short_id",
      "genesis",
      "head",
      "version_count",
      "signers",
      "authors",
      "checks",
      "supersessions",
    ]);
    expect(Object.keys(dict.checks)).toEqual([...CHECK_NAMES]);
    for (const check of Object.values(dict.checks)) {
      expect(Object.keys(check)).toEqual(["passed", "message", "details"]);
    }
    expect(dict.short_id).toMatch(/^sch:[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(report.to_dict()).toEqual(dict);
    expect(JSON.parse(JSON.stringify(report))).toEqual(dict);
  });

  it("accepts options in the second position as well as proofs", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "verified-earlier-version-by-sch-id",
    )!;
    const viaOptions = verifyPaper(vector.records, { head: vector.call.head });
    const viaProofs = verifyPaper(vector.records, [], {
      head: vector.call.head,
    });
    const viaBoth = verifyPaper(vector.records, {
      proofs: [],
      head: vector.call.head,
    });
    expectVectorReport(viaOptions, vector);
    expectVectorReport(viaProofs, vector);
    expectVectorReport(viaBoth, vector);
    expect(viaProofs.proofs).toEqual([]);

    const proof = { seq: 1, anchor_status: "pending" };
    const withProofs = verifyPaper(vector.records, [proof], {
      head: vector.call.head,
    });
    expectVectorReport(withProofs, vector);
    expect(withProofs.proofs).toEqual([proof]);
    // Proofs never change the report shape or the verdict.
    expect(withProofs.toDict()).toEqual(viaOptions.toDict());
  });
});

describe("Ed25519 over the shared records", () => {
  it("authenticates every untampered record of a verified paper", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "verified-single-version",
    )!;
    for (const record of vector.records) {
      expect(verifyRecord(record), record.type).toBe(true);
    }
  });

  it("rejects a record whose body changed after signing", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "invalid-tampered-head-body",
    )!;
    const tampered = vector.records.find(
      (record) => record.id === vector.ids.v1,
    )!;
    expect((tampered.body as Record<string, unknown>).title).toBe("Forged title");
    expect(verifyRecord(tampered)).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const vector = doc.vectors.find(
      (candidate) => candidate.name === "invalid-forged-consent-signature",
    )!;
    const forged = vector.records.find(
      (record) => record.id === vector.ids["c1-bob"],
    )!;
    expect(verifyRecord(forged)).toBe(false);
  });
});

describe("plugin entry points", () => {
  it("exports verifyPaper from the index, the entry module and the default namespace", () => {
    expect(verifyPaperFromIndex).toBe(verifyPaper);
    expect(verifyPaperFromEntry).toBe(verifyPaper);
    expect(verifyCore.verifyPaper).toBe(verifyPaper);
    const vector = doc.vectors[0];
    expect(
      verifyCore.verifyPaper(vector.records, vector.call).status,
    ).toBe(vector.expect.status);
  });
});

describe("invalid arguments", () => {
  const records = doc.vectors[0].records;

  it("rejects a non-mapping record", () => {
    expect(() => verifyPaper([...records, 7 as never])).toThrow(
      /records\[\d+\] must be a mapping/,
    );
  });

  it("rejects a malformed paper and head", () => {
    expect(() => verifyPaper(records, { paper: "sch:nope" })).toThrow(
      /not a valid sch: id/,
    );
    expect(() => verifyPaper(records, { head: 42 as never })).toThrow(/head/);
    expect(() =>
      verifyPaper(records, { authorities: "did:key:z6Mk" as never }),
    ).toThrow(/authorities/);
  });

  it("rejects a paper and head naming different papers", () => {
    const twoPapers = doc.vectors.find(
      (candidate) => candidate.name === "verified-paper-chosen-among-two",
    )!;
    const paper = deriveShortId(twoPapers.ids["x-genesis"]);
    const head = doc.vectors.find(
      (candidate) => candidate.name === "verified-earlier-version-by-sch-id",
    )!.call.head!;
    expect(() => verifyPaper(records, { paper, head })).toThrow(
      /name different papers/,
    );
  });
});
