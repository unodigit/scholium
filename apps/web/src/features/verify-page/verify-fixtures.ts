/**
 * Test-only: a version's signed file list built from real bytes.
 *
 * The ids come from `paper-proof`'s `fileCid`, a second implementation of the
 * raw CIDv1 that does not share code with the page's chunked fingerprinting
 * (`submit/fingerprint`), so a test that drops these bytes checks the page's
 * hashing against an independent reference, not against itself.
 */

import { fileCid } from "../paper-proof/files";
import type { VersionManifest } from "./manifest-source";
import { parseManifestResponse } from "./manifest-source";
import { parseVersionRef, type VersionRef } from "./version-ref";

/** A real paper id from the shared vectors (checksum included). */
export const SHORT_ID = "sch:6sel-2dio-orm6";
export const VERSION_ID = `${SHORT_ID}/v2`;

const encoder = new TextEncoder();

/** The signed files' bytes, by path. */
export const SIGNED_BYTES = {
  "main.pdf": encoder.encode("%PDF-1.7 the manuscript of version two"),
  "data/results.csv": encoder.encode("run,score\n1,0.91\n2,0.93\n"),
} as const;

export const MANIFEST_CID = "bafyreigsignedmanifestrecordidforthefixtureonly4ybrz5a2xcqu";
export const VERSION_CID = "bafyreiaversionrecordidforthefixtureonlyxxxxxxxxxxxxxxxxxxxxxx";

/** The body `GET /v1/papers/{id}/v/{n}/manifest` answers with for {@link VERSION_ID}. */
export function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const file = (path: keyof typeof SIGNED_BYTES, mediaType: string, role: string) => ({
    path,
    cid: fileCid(SIGNED_BYTES[path]),
    size: SIGNED_BYTES[path].length,
    mediaType,
    role,
    licence: "CC-BY-4.0",
    scanStatus: "passed",
    scan_status: "passed",
  });
  return {
    paper: SHORT_ID,
    shortId: SHORT_ID,
    versionCid: VERSION_CID,
    n: 2,
    version: 2,
    manifestCid: MANIFEST_CID,
    licence: "CC-BY-4.0",
    files: [
      file("main.pdf", "application/pdf", "manuscript"),
      file("data/results.csv", "text/csv", "dataset"),
    ],
    ...overrides,
  };
}

export function versionRef(text: string = VERSION_ID): VersionRef {
  const parsed = parseVersionRef(text);
  if (!parsed.ok) throw new Error(`fixture id ${text} is not valid: ${parsed.message}`);
  return parsed.ref;
}

/** The parsed manifest for {@link VERSION_ID}. */
export function manifest(overrides: Record<string, unknown> = {}): VersionManifest {
  return parseManifestResponse(manifestBody(overrides), versionRef());
}

/** A `File` the way a browser hands one over. */
export function fileOf(bytes: Uint8Array, name: string, type = "application/octet-stream"): File {
  return new File([bytes as BlobPart], name, { type });
}
