/**
 * "Files match what the authors signed": the signed manifest of the verified
 * version, and (where the node will hand them over) the files themselves.
 *
 * verify-core's `manifests` check says the manifest is signed and valid. That
 * alone does not say the bytes a reader would download are the ones it lists,
 * so this module also fetches each listed file, hashes it in the browser and
 * compares it with the signed id and size. It is the browser's counterpart of
 * the CLI's file check in `scholium_cli.checklist`:
 *
 * - every listed file present and equal: a match;
 * - a file present but different (size or id): a mismatch, which fails the
 *   paper;
 * - a file not compared (the source has no bytes, the node refuses it, or it
 *   would blow the download budget): *not compared*, which is a warning and
 *   never a pass. The reader is told the files were not checked here.
 *
 * Large files are the reason for the budget. A data bundle can be gigabytes;
 * a Proof tab must not pull it into memory unasked. Whatever is skipped is
 * still checked when the reader downloads it, and on `/verify`.
 *
 * Pure data and functions (plus an injected loader), no React.
 */

import { sha256 } from "@noble/hashes/sha256";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { validateManifestBody, type VerificationReport } from "../verify-core";

/** One file the signed manifest lists. */
export interface ManifestFile {
  readonly path: string;
  /** The signed file id: a raw-codec CIDv1 over SHA-256 (`bafkrei…`). */
  readonly cid: string;
  /** The signed size in bytes. */
  readonly size: number;
}

/** How one file fared against the manifest. */
export type FileStatus = "match" | "mismatch" | "skipped";

export interface FileResult {
  readonly file: ManifestFile;
  readonly status: FileStatus;
  /** Why it mismatched or was skipped; `null` for a match. */
  readonly detail: string | null;
}

/** The manifest of the verified version, as the CLI's `manifest_files` finds it. */
export interface VersionManifest {
  /** Record id of the manifest. */
  readonly cid: string;
  readonly files: readonly ManifestFile[];
}

/**
 * Bytes of a file by its signed id, or `null` when the source does not hold
 * it. May throw for a transport failure; that file is then not compared.
 */
export type FileLoader = (
  cid: string,
  signal?: AbortSignal,
) => Promise<Uint8Array | null>;

/** Total bytes a check may download: enough for a paper, not for a dataset. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

const RAW_CODEC = 0x55;
const SHA2_256 = 0x12;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The raw CIDv1 (`bafkrei…`) of `bytes`: the id the content store files them under. */
export function fileCid(bytes: Uint8Array): string {
  return CID.create(1, RAW_CODEC, createDigest(SHA2_256, sha256(bytes))).toString();
}

/** `1.5 MiB`, `812 KiB`, `40 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

/**
 * The manifest of the version `report` verified, or `null` when it cannot be
 * read. Follows `head → body.manifest → manifest.body.files`, the same walk
 * the CLI does, and takes the first record for an id.
 */
export function versionManifest(
  records: readonly unknown[],
  report: VerificationReport,
): VersionManifest | null {
  if (report.head === null) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (isMapping(record) && typeof record.id === "string" && !byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  const head = byId.get(report.head);
  const reference = isMapping(head?.body) ? head.body.manifest : undefined;
  const manifest = typeof reference === "string" ? byId.get(reference) : undefined;
  if (manifest === undefined || typeof reference !== "string") return null;
  try {
    const { files } = validateManifestBody(manifest.body);
    return {
      cid: reference,
      files: files.map((entry) => ({
        path: String(entry.path),
        cid: String(entry.cid),
        size: Number(entry.size),
      })),
    };
  } catch {
    return null;
  }
}

function skipped(file: ManifestFile, detail: string): FileResult {
  return { file, status: "skipped", detail };
}

/**
 * Compare each listed file with the bytes `load` returns for it.
 *
 * Files are fetched one at a time, in manifest order, while the total of their
 * signed sizes fits `maxDownloadBytes`; the rest are skipped without being
 * requested. With no `load`, every file is skipped.
 */
export async function compareFiles(
  files: readonly ManifestFile[],
  load: FileLoader | undefined,
  options: { maxDownloadBytes?: number; signal?: AbortSignal } = {},
): Promise<FileResult[]> {
  const { signal } = options;
  let budget = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const results: FileResult[] = [];

  for (const file of files) {
    if (load === undefined) {
      results.push(skipped(file, `${file.path}: not included here`));
      continue;
    }
    if (file.size > budget) {
      results.push(
        skipped(
          file,
          `${file.path}: ${formatBytes(file.size)} is too large to download for this check`,
        ),
      );
      continue;
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await load(file.cid, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      results.push(skipped(file, `${file.path}: could not be downloaded from this node`));
      continue;
    }
    if (bytes === null) {
      results.push(skipped(file, `${file.path}: not available from this node`));
      continue;
    }

    budget -= file.size;
    if (bytes.length !== file.size) {
      results.push({
        file,
        status: "mismatch",
        detail:
          `${file.path}: the node holds ${bytes.length} bytes, ` +
          `the signed manifest says ${file.size}`,
      });
    } else if (fileCid(bytes) !== file.cid) {
      results.push({
        file,
        status: "mismatch",
        detail: `${file.path}: the bytes do not hash to the signed file id ${file.cid}`,
      });
    } else {
      results.push({ file, status: "match", detail: null });
    }
  }
  return results;
}
