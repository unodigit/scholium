/**
 * Comparing a dropped file with a version's signed file list.
 *
 * Files are the same when their ids are the same: a file id is the raw CIDv1
 * over SHA-256 of its bytes, so two files with one id are byte-for-byte equal
 * and nothing else about them (name, date, where they came from) matters. The
 * signed ids are validated canonical base32 strings (`parseManifestResponse`)
 * and the fingerprint is produced canonical, so the comparison is exact string
 * equality. A verification page must not be forgiving about what "equal" means.
 *
 * Pure data and functions, no React.
 */

import type { SignedFile, VersionManifest } from "./manifest-source";

/** What the reader's file is, as the browser measured it. */
export interface FileFacts {
  /** The name the file has on the reader's device. */
  readonly name: string;
  readonly size: number;
  /** The file's id: raw CIDv1 over SHA-256, computed in the browser. */
  readonly cid: string;
}

export type Comparison =
  | {
      readonly kind: "match";
      /** Every signed path whose id is the file's (usually one). */
      readonly matches: readonly SignedFile[];
    }
  | {
      readonly kind: "mismatch";
      /**
       * The signed file the reader's file shares a name with, if any: the
       * likeliest thing they meant to check, and the most useful hint when its
       * contents differ.
       */
      readonly sameName: SignedFile | null;
    };

/** `fig1.png` from `figures/fig1.png`. */
export function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Compare `file` with every file `manifest` lists. */
export function compareFile(file: FileFacts, manifest: VersionManifest): Comparison {
  const matches = manifest.files.filter((signed) => signed.cid === file.cid);
  if (matches.length > 0) {
    return { kind: "match", matches };
  }
  const name = file.name.toLowerCase();
  const sameName = manifest.files.find((signed) => baseName(signed.path).toLowerCase() === name);
  return { kind: "mismatch", sameName: sameName ?? null };
}
