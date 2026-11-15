/**
 * Fingerprinting: the content ID of a file, computed on the author's device.
 *
 * A file's fingerprint is its raw-codec CIDv1 over SHA-256 — the same ID the
 * API's content store files the bytes under and returns in `Upload-Cid` when an
 * upload completes. Computing it locally, while the upload runs, lets the Files
 * step compare the two: a match means the copy the node holds is byte-for-byte
 * the file the author chose.
 *
 * The file is read in chunks and fed to an incremental hash, so a 5 GB data
 * bundle never has to fit in memory, progress can be reported as it goes, and
 * the main thread gets a turn between chunks.
 */

import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { MIB } from "./limits";

/** CID version 1 (the only one the content store uses). */
const CID_VERSION = 1;
/** Multicodec `raw`: the CID addresses the bytes themselves, not a DAG node. */
const RAW_CODEC = 0x55;
/** Multihash `sha2-256`. */
const SHA2_256 = 0x12;

/** How much of the file is read and hashed at a time. */
export const FINGERPRINT_CHUNK_BYTES = 4 * MIB;

/** Thrown by {@link fingerprintBlob} when its signal is aborted. */
export class FingerprintAborted extends Error {
  constructor() {
    super("Fingerprinting was cancelled.");
    this.name = "FingerprintAborted";
  }
}

export interface FingerprintOptions {
  /** Bytes read per step. Defaults to {@link FINGERPRINT_CHUNK_BYTES}. */
  chunkBytes?: number;
  /** Aborting rejects with {@link FingerprintAborted} at the next chunk boundary. */
  signal?: AbortSignal;
  /** Called after every chunk with the bytes hashed so far and the file's size. */
  onProgress?: (hashedBytes: number, totalBytes: number) => void;
  /** Gives the page a turn between chunks. Defaults to a zero-delay timeout. */
  yieldToUi?: () => Promise<void>;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Read a blob into memory.
 *
 * `Blob.arrayBuffer()` where it exists; `FileReader` otherwise (older
 * browsers, and jsdom, which has no `arrayBuffer`).
 */
export function readBlob(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

/** The raw CIDv1 (base32, `bafkrei…`) of a SHA-256 digest. */
export function rawCidFromDigest(digest: Uint8Array): string {
  return CID.create(CID_VERSION, RAW_CODEC, createDigest(SHA2_256, digest)).toString();
}

/**
 * Compute the fingerprint (raw CIDv1) of `blob`.
 *
 * @throws {FingerprintAborted} if `options.signal` aborts first.
 * @throws whatever the browser throws when the file cannot be read (it was
 *   moved, deleted or became unreadable while being hashed).
 */
export async function fingerprintBlob(blob: Blob, options: FingerprintOptions = {}): Promise<string> {
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? FINGERPRINT_CHUNK_BYTES));
  const yieldToUi = options.yieldToUi ?? defaultYield;
  const total = blob.size;
  const hasher = sha256.create();

  let hashed = 0;
  while (hashed < total) {
    if (options.signal?.aborted) {
      throw new FingerprintAborted();
    }
    const end = Math.min(hashed + chunkBytes, total);
    hasher.update(await readBlob(blob.slice(hashed, end)));
    hashed = end;
    options.onProgress?.(hashed, total);
    if (hashed < total) {
      await yieldToUi();
    }
  }
  if (options.signal?.aborted) {
    throw new FingerprintAborted();
  }
  if (total === 0) {
    options.onProgress?.(0, 0);
  }
  return rawCidFromDigest(hasher.digest());
}

/**
 * True when two CID strings name the same content.
 *
 * Compared as parsed CIDs where both parse (so a different multibase encoding
 * of one CID still matches), and as lower-cased strings where they do not.
 */
export function sameCid(a: string, b: string): boolean {
  try {
    return CID.parse(a).toString() === CID.parse(b).toString();
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}

/** `bafkreihdwdcef…vyku`: enough of a CID to recognise it, short enough for a row. */
export function shortCid(cid: string, head = 12, tail = 4): string {
  return cid.length <= head + tail + 1 ? cid : `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}
