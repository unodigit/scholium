/**
 * Test fixtures: a small, genuinely signed paper.
 *
 * The shared verification vectors pin verify-core, but their manifests list
 * file ids whose bytes nobody holds, so they cannot show a file matching (or
 * not matching) its signed id. These builders sign real records with real
 * Ed25519 keys through verify-core itself, so a test can hand the Proof tab a
 * paper that verifies, then change one byte of a file or a record and watch
 * the verdict change.
 *
 * Imported by tests only; nothing in the app depends on it.
 */

import {
  computeRecordId,
  deriveShortId,
  didKeyFromSeed,
  signEnvelope,
} from "../verify-core";
import { fileCid } from "./files";

export interface FixtureFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface BuildPaperOptions {
  /** How many authors are listed on every version. Default 2. */
  readonly authors?: number;
  /**
   * Authors listed per version instead of one count for all: entry `n − 1` is
   * version `n`'s author count (the submitting author always included). Lets a
   * test build a paper whose authorship grew from one version to the next.
   */
  readonly authorCounts?: readonly number[];
  /** How many versions to chain. Default 1. */
  readonly versions?: number;
  /** Files of every version's manifest. Default: one small PDF. */
  readonly files?: readonly FixtureFile[];
}

export interface BuiltPaper {
  /** Signed records, genesis first, in no order a verifier may rely on. */
  readonly records: Record<string, unknown>[];
  readonly genesisId: string;
  readonly shortId: string;
  /** Version record ids, oldest first. */
  readonly versionIds: string[];
  /** Manifest record id of the newest version. */
  readonly manifestId: string;
  readonly files: readonly FixtureFile[];
  /** did:keys of the listed authors, submitting author first. */
  readonly authorDids: string[];
}

const CREATED = "2026-11-14T05:33:00Z";

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A deterministic 32-byte seed, distinct per author. */
function seedFor(author: number): Uint8Array {
  return new Uint8Array(32).fill(author + 1);
}

function sign(
  author: number,
  type: string,
  prev: string | null,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const envelope = {
    v: 1,
    type,
    author: didKeyFromSeed(seedFor(author)),
    created: CREATED,
    prev,
    body,
    proofs: [],
  };
  return {
    ...envelope,
    id: computeRecordId(envelope),
    sig: signEnvelope(envelope, seedFor(author)),
  };
}

export function buildPaper(options: BuildPaperOptions = {}): BuiltPaper {
  const versionCount =
    options.versions ?? (options.authorCounts ? options.authorCounts.length : 1);
  const files = options.files ?? [{ path: "main.pdf", bytes: bytesOf("%PDF-1.7 fixture") }];
  // How many authors version `n` lists: one count for every version, or that
  // version's own count when the caller grew the authorship across versions.
  // Author `a` is always the same did:key (seed `a`), submitting author first.
  const authorCountOf = (n: number): number =>
    options.authorCounts?.[n - 1] ?? options.authors ?? 2;
  const authorDids = Array.from(
    { length: authorCountOf(versionCount) },
    (_, i) => didKeyFromSeed(seedFor(i)),
  );

  const records: Record<string, unknown>[] = [];
  const genesis = sign(0, "paper.genesis", null, {
    seed: "paper-proof-fixture",
    title: "A Fixture Paper",
    categories: ["mathematics"],
    licence: "CC-BY-4.0",
  });
  records.push(genesis);

  const versionIds: string[] = [];
  let manifestId = "";
  let prev = genesis.id as string;
  for (let n = 1; n <= versionCount; n += 1) {
    const manifest = sign(0, "manifest", null, {
      files: files.map((file) => ({
        path: file.path,
        cid: fileCid(file.bytes),
        size: file.bytes.length,
        mediaType: "application/pdf",
        role: "manuscript",
      })),
    });
    manifestId = manifest.id as string;
    const version = sign(0, "paper.version", prev, {
      paper: genesis.id,
      n,
      title: `A Fixture Paper, version ${n}`,
      abstract: "Signed in a test.",
      authors: Array.from({ length: authorCountOf(n) }, (_, a) => ({
        did: didKeyFromSeed(seedFor(a)),
        credit: ["writing"],
      })),
      manifest: manifest.id,
      licence: "CC-BY-4.0",
      changeNote: n === 1 ? "First version" : `Revision ${n}`,
    });
    records.push(manifest, version);
    for (let a = 0; a < authorCountOf(n); a += 1) {
      records.push(
        sign(a, "coauthor.consent", null, {
          version: version.id,
          role: "author",
          decision: "accept",
        }),
      );
    }
    versionIds.push(version.id as string);
    prev = version.id as string;
  }

  return {
    records,
    genesisId: genesis.id as string,
    shortId: deriveShortId(genesis.id as string),
    versionIds,
    manifestId,
    files,
    authorDids,
  };
}
