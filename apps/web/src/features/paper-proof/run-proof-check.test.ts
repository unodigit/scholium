import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NetworkError } from "../../lib/api";
import { deriveShortId } from "../verify-core";
import type { RecordProofInfo } from "./anchor";
import { parsePaperRef } from "./paper-ref";
import { bytesOf, buildPaper } from "./proof-fixtures";
import { LOCAL_PRESERVATION, type PreservationInfo } from "./preservation";
import { runProofCheck } from "./run-proof-check";
import type { ProofSource, SignedRecord } from "./source";

const NODE = "https://node.example";

function sourceOf(
  records: readonly SignedRecord[],
  extra: Partial<ProofSource> = {},
): ProofSource {
  return { loadRecords: async () => records, loadPreservation: async () => LOCAL_PRESERVATION, ...extra };
}

/** A node that holds exactly `paper`'s files. */
function filesOf(paper: ReturnType<typeof buildPaper>) {
  return vi.fn(async (cid: string) => {
    const hit = paper.records
      .filter((record) => record.type === "manifest")
      .flatMap((record) => (record.body as { files: Array<{ cid: string; path: string }> }).files)
      .find((entry) => entry.cid === cid);
    return hit === undefined
      ? null
      : (paper.files.find((file) => file.path === hit.path)?.bytes ?? null);
  });
}

const ANCHORED: RecordProofInfo = {
  seq: 3,
  anchor: {
    status: "anchored",
    anchoredAt: "2027-03-02T04:00:00Z",
    chain: "8453",
    batch: "18211",
    txUrl: "https://basescan.org/tx/0xabc",
  },
};

const line = (outcome: Awaited<ReturnType<typeof runProofCheck>>, key: string) =>
  outcome.items.find((entry) => entry.key === key)!;

describe("a paper that verifies", () => {
  const paper = buildPaper({ authors: 3, versions: 2 });
  const ref = parsePaperRef(paper.shortId);

  it("reads the counted indicator, then the anchor state, while the node has no anchor", async () => {
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, { loadFile: filesOf(paper) }),
      nodeUrl: NODE,
    });

    expect(outcome.state).toBe("anchor_pending");
    // The indicator carries the PRD's counts; the anchor state follows as the
    // summary (a promise of a time only when an anchor is actually scheduled).
    expect(outcome.headline).toBe("Verified · 2 versions · 3 signatures");
    // The same counts reach the header badge, which words them itself.
    expect(outcome.counts).toEqual({ versions: 2, signatures: 3 });
    expect(outcome.summary).toBe("Signed. Anchoring is not enabled on this node yet.");
    expect(outcome.items.map((entry) => [entry.key, entry.state])).toEqual([
      ["authors", "pass"],
      ["history", "pass"],
      ["files", "pass"],
      ["ledger", "pending"],
      ["anchor", "pending"],
      ["retraction", "pass"],
      ["preservation", "pending"],
    ]);
    expect(line(outcome, "authors").text).toBe("Signed by all 3 listed authors");
    expect(line(outcome, "history").text).toMatch(/^Version history is intact \(v1 → v2\)/);
    expect(line(outcome, "files").text).toBe("Files match what the authors signed (1 file)");
    expect(line(outcome, "preservation").text).toBe("Preserved: 1 of 1 local copy");
    expect(line(outcome, "preservation").link).toEqual({
      href: "/network",
      label: "Network details",
    });
  });

  it("is Verified once the node reports an anchor, and records the log entry", async () => {
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, {
        loadFile: filesOf(paper),
        loadRecordProof: async () => ANCHORED,
      }),
      nodeUrl: NODE,
    });

    expect(outcome.state).toBe("verified");
    expect(outcome.headline).toBe("Verified · 2 versions · 3 signatures");
    expect(line(outcome, "anchor")).toMatchObject({
      state: "pass",
      text: "Timestamp anchored: 2 Mar 2027 04:00 UTC",
    });
    expect(line(outcome, "ledger")).toMatchObject({
      state: "pass",
      text: "Recorded in the node's public log (entry #3)",
    });
  });

  it("asks the node for its replication summary, and keeps the paper verified without it", async () => {
    const loadPreservation = vi.fn(async () => LOCAL_PRESERVATION as PreservationInfo);
    const withSummary = await runProofCheck({
      ref,
      source: sourceOf(paper.records, { loadPreservation }),
      nodeUrl: NODE,
    });
    expect(loadPreservation).toHaveBeenCalledTimes(1);
    expect(line(withSummary, "preservation").state).toBe("pending");

    const withoutSummary = await runProofCheck({
      ref,
      source: sourceOf(paper.records, {
        loadPreservation: async () => {
          throw new NetworkError("https://node.example/v1/network");
        },
      }),
      nodeUrl: NODE,
    });
    expect(line(withoutSummary, "preservation")).toMatchObject({
      state: "warn",
      text: "This node's preservation state could not be read",
    });
    expect(withoutSummary.state).toBe("anchor_pending");
  });

  it("asks the node for the proof of the version it verified", async () => {
    const loadRecordProof = vi.fn(async (_recordId: string) => ANCHORED);
    await runProofCheck({ ref, source: sourceOf(paper.records, { loadRecordProof }), nodeUrl: NODE });
    expect(loadRecordProof).toHaveBeenCalledTimes(1);
    expect(loadRecordProof.mock.calls[0][0]).toBe(paper.versionIds[1]);
  });

  it("keeps the paper verified when only the proof cannot be fetched", async () => {
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, {
        loadRecordProof: async () => {
          throw new NetworkError("https://node.example/v1/records/x/proof");
        },
      }),
      nodeUrl: NODE,
    });
    expect(outcome.state).toBe("anchor_pending");
    expect(line(outcome, "anchor").state).toBe("pending");
  });

  it("verifies the newest version by default and names it in the command", async () => {
    const outcome = await runProofCheck({ ref, source: sourceOf(paper.records), nodeUrl: NODE });
    expect(outcome.schId).toBe(`${paper.shortId}/v2`);
    expect(outcome.command).toBe(`scholium verify ${paper.shortId}/v2 --node ${NODE}`);
  });

  it("verifies exactly the version asked for", async () => {
    const outcome = await runProofCheck({
      ref: parsePaperRef(`${paper.shortId}/v1`),
      source: sourceOf(paper.records),
      nodeUrl: NODE,
    });
    expect(outcome.state).toBe("anchor_pending");
    expect(outcome.schId).toBe(`${paper.shortId}/v1`);
    expect(outcome.report?.head).toBe(paper.versionIds[0]);
    expect(line(outcome, "history").text).toMatch(/\(v1\)/);
  });

  it("carries the technical details and the checks verify-core ran", async () => {
    const outcome = await runProofCheck({ ref, source: sourceOf(paper.records), nodeUrl: NODE });
    const rows = Object.fromEntries(outcome.rows.map((row) => [row.key, row.value]));
    expect(rows.version).toBe(paper.versionIds[1]);
    expect(rows.manifest).toBe(paper.manifestId);
    expect(rows.paper).toBe(paper.genesisId);
    expect(rows["signer-1"]).toBe(paper.authorDids[0]);
    expect(outcome.checks).toHaveLength(6);
    expect(outcome.checks.every((check) => check.passed)).toBe(true);
  });

  it("says the files were not compared, rather than that they match, when it has no bytes", async () => {
    const outcome = await runProofCheck({ ref, source: sourceOf(paper.records), nodeUrl: NODE });
    expect(line(outcome, "files")).toMatchObject({ state: "warn" });
    expect(line(outcome, "files").text).toMatch(/not compared here/);
    expect(outcome.state).toBe("anchor_pending");
  });
});

describe("a paper that does not match what the authors signed", () => {
  const paper = buildPaper({
    files: [
      { path: "main.pdf", bytes: bytesOf("the real manuscript") },
      { path: "data.csv", bytes: bytesOf("a,b\n1,2\n") },
    ],
  });
  const ref = parsePaperRef(paper.shortId);

  it("fails when a file's bytes are not the signed ones", async () => {
    // "the real manuscript" is 19 bytes and so is the forgery: the size matches,
    // so only the hash can tell them apart.
    expect(bytesOf("the real manuscript").length).toBe(bytesOf("a forged manuscript").length);
    const forged = async (cid: string) => {
      const bytes = await filesOf(paper)(cid);
      return bytes !== null && bytes.length === 19 ? bytesOf("a forged manuscript") : bytes;
    };

    const outcome = await runProofCheck({ ref, source: sourceOf(paper.records, { loadFile: forged }), nodeUrl: NODE });

    expect(outcome.state).toBe("failed");
    expect(outcome.headline).toBe("Verification failed");
    expect(line(outcome, "files")).toMatchObject({
      state: "fail",
      text: "1 of 2 files does not match what the authors signed",
    });
    expect(line(outcome, "files").details[0]).toMatch(/main\.pdf: the bytes do not hash to the signed file id/);
    // The signatures are fine: only the files line is red.
    expect(line(outcome, "authors").state).toBe("pass");
    expect(line(outcome, "history").state).toBe("pass");
  });

  it("fails when a file has the wrong size", async () => {
    const loadFile = async (cid: string) => {
      const bytes = await filesOf(paper)(cid);
      return bytes === null ? null : bytes.slice(0, bytes.length - 1);
    };
    const outcome = await runProofCheck({ ref, source: sourceOf(paper.records, { loadFile }), nodeUrl: NODE });
    expect(outcome.state).toBe("failed");
    expect(line(outcome, "files").text).toBe("2 of 2 files do not match what the authors signed");
    expect(line(outcome, "files").details[0]).toMatch(/the node holds 18 bytes, the signed manifest says 19/);
  });

  it("fails when a signed record was altered", async () => {
    const records = paper.records.map((record) =>
      record.type === "paper.version"
        ? { ...record, body: { ...(record.body as object), title: "Altered after signing" } }
        : record,
    );
    const outcome = await runProofCheck({ ref, source: sourceOf(records), nodeUrl: NODE });
    expect(outcome.state).toBe("failed");
    expect(line(outcome, "authors")).toMatchObject({ state: "fail" });
    expect(line(outcome, "authors").details.join(" ")).toMatch(/id does not match the hash of its content/);
  });

  it("fails when a record has no signature among signed ones", async () => {
    const records = paper.records.map((record) => {
      if (record.type !== "coauthor.consent") return record;
      const { sig: _sig, ...unsigned } = record;
      return unsigned;
    });
    const outcome = await runProofCheck({ ref, source: sourceOf(records), nodeUrl: NODE });
    expect(outcome.state).toBe("failed");
    expect(line(outcome, "authors").details.join(" ")).toMatch(/has no signature/);
  });

  it("does not download files for a paper that already failed", async () => {
    const loadFile = vi.fn(async () => null);
    const records = paper.records.filter((record) => record.type !== "coauthor.consent");
    const outcome = await runProofCheck({ ref, source: sourceOf(records, { loadFile }), nodeUrl: NODE });
    expect(outcome.state).toBe("failed");
    expect(loadFile).not.toHaveBeenCalled();
  });
});

describe("files the check cannot compare", () => {
  const paper = buildPaper({
    files: [
      { path: "main.pdf", bytes: bytesOf("manuscript") },
      { path: "big.bin", bytes: new Uint8Array(2048) },
    ],
  });
  const ref = parsePaperRef(paper.shortId);

  it("skips a file over the download budget without requesting it", async () => {
    const loadFile = filesOf(paper);
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, { loadFile }),
      maxDownloadBytes: 1024,
      nodeUrl: NODE,
    });

    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(line(outcome, "files")).toMatchObject({ state: "warn" });
    expect(line(outcome, "files").text).toBe(
      "1 of 2 files match what the authors signed; 1 could not be compared here",
    );
    expect(line(outcome, "files").details[0]).toMatch(/big\.bin: 2 KiB is too large to download/);
    // Not compared is a warning, not a failure: the signatures and hashes are good.
    expect(outcome.state).toBe("anchor_pending");
  });

  it("treats a file the node withholds as not compared, not as a mismatch", async () => {
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, { loadFile: async () => null }),
      nodeUrl: NODE,
    });
    expect(line(outcome, "files").state).toBe("warn");
    expect(outcome.state).toBe("anchor_pending");
  });

  it("treats a download that fails as not compared", async () => {
    const outcome = await runProofCheck({
      ref,
      source: sourceOf(paper.records, {
        loadFile: async () => {
          throw new NetworkError("https://node.example/v1/content/x");
        },
      }),
      nodeUrl: NODE,
    });
    expect(line(outcome, "files").details[0]).toMatch(/could not be downloaded from this node/);
    expect(outcome.state).toBe("anchor_pending");
  });
});

describe("a check that could not run is not a failure", () => {
  const paper = buildPaper();
  const ref = parsePaperRef(paper.shortId);

  it("is 'Could not check' when the node cannot be reached", async () => {
    const outcome = await runProofCheck({
      ref,
      nodeUrl: NODE,
      source: {
        loadRecords: async () => {
          throw new NetworkError("https://node.example/v1/sync/range");
        },
      },
    });

    expect(outcome.state).toBe("cannot_verify");
    expect(outcome.headline).toBe("Could not check");
    expect(outcome.summary).toBe(
      "Scholium could not reach the node. You may be offline. This is not a failure.",
    );
    expect(outcome.items).toEqual([]);
    expect(outcome.report).toBeNull();
    // The offline command is the way forward, so it is still given.
    expect(outcome.command).toBe(`scholium verify ${paper.shortId} --node ${NODE}`);
  });

  it("is 'Could not check' when the node has no records for the paper", async () => {
    // A well-formed id (checksum and all) of a paper these records do not hold.
    const other = parsePaperRef("sch:6sel-2dio-orm6");
    expect(other.shortId).not.toBe(paper.shortId);
    const outcome = await runProofCheck({ ref: other, source: sourceOf(paper.records), nodeUrl: NODE });
    expect(outcome.state).toBe("cannot_verify");
    expect(outcome.summary).toBe(`The node has no records for ${other.shortId}. This is not a failure.`);
  });

  it("is 'Could not check' for a version the node does not have", async () => {
    const outcome = await runProofCheck({
      ref: parsePaperRef(`${paper.shortId}/v9`),
      source: sourceOf(paper.records),
      nodeUrl: NODE,
    });
    expect(outcome.state).toBe("cannot_verify");
    expect(outcome.summary).toBe(`The node has no version 9 of ${paper.shortId}. This is not a failure.`);
  });

  it("is 'Could not check' when the source cannot supply records at all", async () => {
    const outcome = await runProofCheck({ ref, source: sourceOf([]), nodeUrl: NODE });
    expect(outcome.state).toBe("cannot_verify");
  });

  it("rejects, rather than reporting, when the check is aborted", async () => {
    const controller = new AbortController();
    const pending = runProofCheck({
      ref,
      nodeUrl: NODE,
      signal: controller.signal,
      source: {
        loadRecords: () =>
          new Promise((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("authorities and notices (the CLI's --authority)", () => {
  interface Vector {
    name: string;
    records: SignedRecord[];
    ids: Record<string, string>;
    call: { authorities?: string[] };
  }
  const path = [
    resolve(process.cwd(), "../api/packages/record-core/vectors/verification.json"),
    resolve(process.cwd(), "apps/api/packages/record-core/vectors/verification.json"),
  ].find((candidate) => existsSync(candidate))!;
  const vectors = (JSON.parse(readFileSync(path, "utf8")) as { vectors: Vector[] }).vectors;
  const vector = vectors.find((entry) => entry.name === "tombstoned-by-trusted-authority")!;
  const ref = parsePaperRef(deriveShortId(vector.ids.genesis));

  it("applies a tombstone only when the caller trusts the authority that signed it", async () => {
    const trusted = await runProofCheck({
      ref,
      source: sourceOf(vector.records),
      authorities: vector.call.authorities,
      nodeUrl: NODE,
    });
    expect(line(trusted, "retraction").state).toBe("warn");
    expect(line(trusted, "retraction").text).toMatch(/^Content removed/);
    expect(trusted.report?.status).toBe("tombstoned");
    // A tombstone leaves the signed history verifying.
    expect(trusted.state).toBe("anchor_pending");

    const untrusted = await runProofCheck({ ref, source: sourceOf(vector.records), nodeUrl: NODE });
    expect(untrusted.report?.status).toBe("verified");
    expect(line(untrusted, "retraction").state).toBe("pass");
  });
});
