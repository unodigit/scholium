/**
 * The small facts the paper page's header states, worked out from the data.
 *
 * "v2 of 2", an author's name, and whether the PDF can be opened are decisions
 * about *words*, so they live here as plain functions the header renders and
 * vitest can pin, not inside markup.
 *
 * Pure data and functions, no React. (It must stay server-safe: the header is
 * a server component, and a function imported from a `"use client"` module
 * would arrive there as a client reference, not as something callable.)
 */

import {
  SCAN_STATUS_SPECS,
  contentUrl,
  type ManifestData,
  type ManifestFile,
  type VersionsData,
} from "../paper-meta/meta";
import type { PaperAuthor } from "../search-page/paper";

/* -------------------------------------------------------------------------- */
/* Version                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The newest listed version number, or `null` when the timeline is unknown.
 *
 * It is the highest listed `n` rather than the length of the list, so a paper
 * with an unlisted version in the middle still says "v3 of 3": the number the
 * reader sees is the number the authors signed. The shown version counts too,
 * so the answer is never smaller than the version on screen.
 */
export function latestVersionNumber(
  versions: VersionsData | undefined,
  shown: number,
): number | null {
  if (versions === undefined || versions.versions.length === 0) {
    return null;
  }
  return Math.max(shown, ...versions.versions.map((entry) => entry.n));
}

/**
 * `v2 of 2`. Without a known total it is just `v2`: "of ?" would be a guess,
 * and the Versions tab says why the timeline could not be read.
 */
export function versionOfTotal(version: number, total: number | null): string {
  return total === null || total < version
    ? `v${version}`
    : `v${version} of ${total}`;
}

/* -------------------------------------------------------------------------- */
/* Authors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A DID short enough for a byline: `did:key:z6MkhaXgBZ…2doK`.
 *
 * Every ed25519 `did:key` starts `did:key:z6Mk`, so the first 18 characters
 * leave six that tell two authors apart, and the last four make a clash
 * unlikely. Only a long identifier is cut, and the full DID stays available as
 * the element's title, so shortening never hides what the author actually is.
 */
export function shortDid(did: string): string {
  const text = did.trim();
  return text.length <= 24 ? text : `${text.slice(0, 18)}…${text.slice(-4)}`;
}

/**
 * How an author reads in the byline: their saved profile name, or their DID.
 *
 * The catalog stores DIDs and the profile service turns them into names. A
 * missing, erased or unreachable profile leaves the DID, which is the honest
 * fallback: inventing a name would not be.
 */
export function authorLabel(author: Pick<PaperAuthor, "did" | "name">): string {
  return author.name !== null && author.name.trim() !== ""
    ? author.name.trim()
    : shortDid(author.did);
}

/** The line under an author's name: affiliation and CRediT roles, if known. */
export function authorDetail(
  author: Pick<PaperAuthor, "did" | "affiliation" | "creditRoles">,
): string {
  return [
    author.affiliation ?? "",
    author.creditRoles.join(", "),
    author.did,
  ]
    .filter((part) => part.trim() !== "")
    .join(" · ");
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

/** Whether the PDF of the version on screen can be opened, and if not, why. */
export type PdfAccess =
  | {
      readonly kind: "available";
      /** Where the PDF's bytes are served. */
      readonly url: string;
      /** The path of the file inside the paper's bundle, `paper.pdf`. */
      readonly name: string;
    }
  | {
      readonly kind: "unavailable";
      /** One plain sentence, shown as the action's explanation. */
      readonly reason: string;
    };

function isPdf(file: ManifestFile): boolean {
  return (
    file.mediaType?.toLowerCase() === "application/pdf" ||
    file.path.toLowerCase().endsWith(".pdf")
  );
}

/**
 * The PDF of a version: the manuscript if it is a PDF, else the first PDF in
 * the signed file list.
 *
 * A file the node will not serve is never linked, and the reason is the
 * scan's own (`SCAN_STATUS_SPECS`), so "Download opens when the scan
 * finishes" is said the same way here as in the Files tab.
 */
export function pdfAccess(
  manifest: ManifestData | undefined,
  baseUrl?: string,
): PdfAccess {
  if (manifest === undefined) {
    return {
      kind: "unavailable",
      reason: "The file list could not be read, so the PDF cannot be opened.",
    };
  }
  const pdfs = manifest.files.filter(isPdf);
  const pdf = pdfs.find((file) => file.role === "manuscript") ?? pdfs[0];
  if (pdf === undefined) {
    return { kind: "unavailable", reason: "This version has no PDF." };
  }
  if (pdf.scanStatus !== "passed") {
    return {
      kind: "unavailable",
      reason: SCAN_STATUS_SPECS[pdf.scanStatus].meaning,
    };
  }
  return { kind: "available", url: contentUrl(pdf.cid, baseUrl), name: pdf.path };
}
