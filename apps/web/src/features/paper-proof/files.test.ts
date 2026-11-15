import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import { describe, expect, it, vi } from "vitest";

import { verifyPaper } from "../verify-core";
import { rawCidFromDigest } from "../submit/fingerprint";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  compareFiles,
  fileCid,
  formatBytes,
  versionManifest,
  type ManifestFile,
} from "./files";
import { buildPaper, bytesOf } from "./proof-fixtures";

describe("fileCid", () => {
  it("is the raw CIDv1 over SHA-256 the content store files bytes under", () => {
    const bytes = bytesOf("some file");
    const cid = CID.parse(fileCid(bytes));
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(0x55);
    expect(cid.multihash.code).toBe(0x12);
    expect(Array.from(cid.multihash.digest)).toEqual(Array.from(sha256(bytes)));
    expect(fileCid(bytes)).toMatch(/^bafkrei/);
  });

  it("agrees with the id the Submit wizard computes on the author's device", () => {
    const bytes = bytesOf("the same bytes");
    expect(fileCid(bytes)).toBe(rawCidFromDigest(sha256(bytes)));
  });

  it("differs for one changed byte", () => {
    expect(fileCid(bytesOf("a"))).not.toBe(fileCid(bytesOf("b")));
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1023, "1023 bytes"],
    [2048, "2 KiB"],
    [1024 * 1024, "1 MiB"],
    [1.5 * 1024 * 1024, "1.5 MiB"],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("versionManifest", () => {
  const paper = buildPaper({ versions: 2 });
  const report = verifyPaper(paper.records, { paper: paper.shortId });

  it("finds the manifest of the version that was verified", () => {
    const manifest = versionManifest(paper.records, report);
    expect(manifest?.cid).toBe(paper.manifestId);
    expect(manifest?.files).toEqual([
      { path: "main.pdf", cid: fileCid(paper.files[0].bytes), size: paper.files[0].bytes.length },
    ]);
  });

  it("is null when the manifest record is not among the records", () => {
    const records = paper.records.filter((record) => record.type !== "manifest");
    expect(versionManifest(records, report)).toBeNull();
  });

  it("is null when the report names no head", () => {
    const none = verifyPaper([], { paper: paper.shortId });
    expect(versionManifest(paper.records, none)).toBeNull();
  });

  it("takes the first record for an id, as the CLI does", () => {
    const manifest = paper.records.find((record) => record.id === paper.manifestId)!;
    const decoy = { ...manifest, body: { files: [] } };
    expect(versionManifest([...paper.records, decoy], report)?.files).toHaveLength(1);
  });
});

describe("compareFiles", () => {
  const a = bytesOf("first file");
  const b = bytesOf("second file");
  const files: ManifestFile[] = [
    { path: "a.txt", cid: fileCid(a), size: a.length },
    { path: "b.txt", cid: fileCid(b), size: b.length },
  ];
  const holder = (held: Record<string, Uint8Array | null>) =>
    vi.fn(async (cid: string) => held[cid] ?? null);

  it("matches files whose bytes are the signed ones", async () => {
    const load = holder({ [files[0].cid]: a, [files[1].cid]: b });
    const results = await compareFiles(files, load);
    expect(results.map((result) => result.status)).toEqual(["match", "match"]);
    expect(results.every((result) => result.detail === null)).toBe(true);
  });

  it("reports a different size before hashing", async () => {
    const results = await compareFiles([files[0]], holder({ [files[0].cid]: a.slice(1) }));
    expect(results[0]).toMatchObject({
      status: "mismatch",
      detail: `a.txt: the node holds ${a.length - 1} bytes, the signed manifest says ${a.length}`,
    });
  });

  it("reports the same size with different bytes by the hash", async () => {
    const flipped = a.slice();
    flipped[0] ^= 0xff;
    const results = await compareFiles([files[0]], holder({ [files[0].cid]: flipped }));
    expect(results[0].status).toBe("mismatch");
    expect(results[0].detail).toBe(`a.txt: the bytes do not hash to the signed file id ${files[0].cid}`);
  });

  it("skips every file when there is no loader", async () => {
    const results = await compareFiles(files, undefined);
    expect(results.map((result) => result.status)).toEqual(["skipped", "skipped"]);
    expect(results[0].detail).toBe("a.txt: not included here");
  });

  it("skips a file the loader does not hold, and carries on with the next", async () => {
    const results = await compareFiles(files, holder({ [files[1].cid]: b }));
    expect(results.map((result) => result.status)).toEqual(["skipped", "match"]);
    expect(results[0].detail).toBe("a.txt: not available from this node");
  });

  it("spends the budget on signed sizes in manifest order and requests nothing over it", async () => {
    const load = holder({ [files[0].cid]: a, [files[1].cid]: b });
    const results = await compareFiles(files, load, { maxDownloadBytes: a.length });
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(["match", "skipped"]);
    expect(results[1].detail).toMatch(/^b\.txt: 11 bytes is too large to download for this check$/);
  });

  it("does not spend budget on a file it could not get", async () => {
    const load = holder({ [files[1].cid]: b });
    const results = await compareFiles(files, load, { maxDownloadBytes: b.length });
    expect(results.map((result) => result.status)).toEqual(["skipped", "match"]);
  });

  it("treats a failed download as not compared", async () => {
    const load = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const results = await compareFiles([files[0]], load);
    expect(results[0]).toMatchObject({
      status: "skipped",
      detail: "a.txt: could not be downloaded from this node",
    });
  });

  it("rethrows when the check was aborted, so the caller drops the result", async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(compareFiles(files, load, { signal: controller.signal })).rejects.toThrow("aborted");
  });

  it("passes the signal on to the loader", async () => {
    const controller = new AbortController();
    const load = holder({ [files[0].cid]: a });
    await compareFiles([files[0]], load, { signal: controller.signal });
    expect(load).toHaveBeenCalledWith(files[0].cid, controller.signal);
  });

  it("has a default budget that fits a paper but not a dataset", () => {
    expect(DEFAULT_MAX_DOWNLOAD_BYTES).toBe(32 * 1024 * 1024);
  });
});
