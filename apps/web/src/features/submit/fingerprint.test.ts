import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { describe, expect, it, vi } from "vitest";

import {
  FINGERPRINT_CHUNK_BYTES,
  FingerprintAborted,
  fingerprintBlob,
  rawCidFromDigest,
  readBlob,
  sameCid,
  shortCid,
} from "./fingerprint";

/** The raw CIDv1 of zero bytes: a well-known constant, so the encoding is checked against the outside world. */
const EMPTY_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const noYield = () => Promise.resolve();

function bytes(length: number): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = (i * 31 + 7) % 251;
  }
  return data;
}

function referenceCid(data: Uint8Array): string {
  return CID.create(1, 0x55, createDigest(0x12, sha256(data))).toString();
}

describe("fingerprint", () => {
  it("is the raw CIDv1 over SHA-256, bafkrei…", () => {
    expect(rawCidFromDigest(sha256(new Uint8Array()))).toBe(EMPTY_CID);
    expect(EMPTY_CID.startsWith("bafkrei")).toBe(true);
  });

  it("fingerprints a file the same however it is chunked", async () => {
    const data = bytes(10_000);
    const expected = referenceCid(data);
    const blob = new Blob([data as BlobPart]);

    for (const chunkBytes of [1, 777, 4096, 10_000, 1_000_000]) {
      expect(await fingerprintBlob(blob, { chunkBytes, yieldToUi: noYield })).toBe(expected);
    }
  });

  it("fingerprints an empty file", async () => {
    const onProgress = vi.fn();
    expect(await fingerprintBlob(new Blob([]), { onProgress })).toBe(EMPTY_CID);
    expect(onProgress).toHaveBeenCalledWith(0, 0);
  });

  it("reports progress after every chunk, ending at the file's size", async () => {
    const onProgress = vi.fn();
    await fingerprintBlob(new Blob([bytes(1000) as BlobPart]), { chunkBytes: 400, onProgress, yieldToUi: noYield });
    expect(onProgress.mock.calls).toEqual([
      [400, 1000],
      [800, 1000],
      [1000, 1000],
    ]);
  });

  it("gives the page a turn between chunks, but not after the last", async () => {
    const yieldToUi = vi.fn(noYield);
    await fingerprintBlob(new Blob([bytes(1000) as BlobPart]), { chunkBytes: 400, yieldToUi });
    expect(yieldToUi).toHaveBeenCalledTimes(2);
  });

  it("stops at the next chunk boundary when aborted", async () => {
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());
    const result = fingerprintBlob(new Blob([bytes(1000) as BlobPart]), {
      chunkBytes: 100,
      signal: controller.signal,
      onProgress,
      yieldToUi: noYield,
    });
    await expect(result).rejects.toBeInstanceOf(FingerprintAborted);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("rejects when the file cannot be read", async () => {
    const unreadable = {
      size: 10,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("disk gone")) }),
    } as unknown as Blob;
    await expect(fingerprintBlob(unreadable)).rejects.toThrow("disk gone");
  });

  it("defaults to 4 MiB chunks", () => {
    expect(FINGERPRINT_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });

  it("reads a blob with FileReader where Blob.arrayBuffer is missing (as in jsdom)", async () => {
    const blob = new Blob([bytes(64) as BlobPart]);
    expect(Array.from(await readBlob(blob))).toEqual(Array.from(bytes(64)));
  });

  describe("sameCid", () => {
    it("matches equal CIDs and tells different ones apart", () => {
      expect(sameCid(EMPTY_CID, EMPTY_CID)).toBe(true);
      expect(sameCid(EMPTY_CID, referenceCid(bytes(3)))).toBe(false);
    });

    it("matches a CID after a parse and re-encode round trip", () => {
      expect(sameCid(EMPTY_CID, CID.parse(EMPTY_CID).toString())).toBe(true);
    });

    it("falls back to a case-insensitive string comparison for what is not a CID", () => {
      expect(sameCid("Not-A-CID", "not-a-cid")).toBe(true);
      expect(sameCid("one", "two")).toBe(false);
    });
  });

  it("shortens a CID to a recognisable head and tail", () => {
    expect(shortCid(EMPTY_CID)).toBe("bafkreihdwdc…vyku");
    expect(shortCid("bafyshort")).toBe("bafyshort");
  });
});
