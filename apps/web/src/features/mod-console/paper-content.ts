/**
 * What a moderator reads beside the decision form: the version's PDF and its
 * extracted text (docs/design.md §5.7, "Detail view shows the paper beside a
 * decision form").
 *
 * A version waiting in moderation is not in the public catalog, and the API
 * serves its bytes (`GET /v1/content/{cid}`) and its text
 * (`GET /v1/papers/{id}/v/{n}/text`) only to its authors and to moderators, as
 * the unknown-cid / unknown-version `404` to everyone else. So:
 *
 * - **the text** goes through the paper page's own reader
 *   ({@link loadReadingText}), which sends the signed-in reader's token;
 * - **the PDF** is found from the version's signed `manifest` record
 *   (`GET /v1/records/{cid}`, public), because the catalog's manifest route
 *   (`/papers/{id}/v/{n}/manifest`) lists listed versions only. Its bytes are
 *   then opened by PDF.js with the same token (`withSessionToken`).
 *
 * Pure functions and two loaders; no React.
 */

import { api, type ApiClient } from "../../lib/api";
import { contentUrl } from "../paper-meta/meta";
import {
  ReadingResponseError,
  loadReadingText,
  type ReadingClient,
  type ReadingText,
} from "../paper-page/reading";
import { RECORDS_ENDPOINT, type ModeratedPaper } from "./decision";

/** The PDF of a version: where the node serves it, and what it is called. */
export interface VersionPdf {
  /** The file's name in the manifest, `paper.pdf`. */
  readonly name: string;
  /** The raw file id. */
  readonly cid: string;
  /** `GET /v1/content/{cid}` on this node. */
  readonly url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

interface ManifestEntry {
  readonly path: string;
  readonly cid: string;
  readonly role: string | null;
  readonly mediaType: string | null;
}

function readEntry(value: unknown): ManifestEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const path = readText(value.path);
  const cid = readText(value.cid);
  if (path === null || cid === null) {
    return null;
  }
  return {
    path,
    cid,
    role: readText(value.role),
    mediaType: readText(value.mediaType)?.toLowerCase() ?? null,
  };
}

function isPdf(entry: ManifestEntry): boolean {
  return (
    entry.mediaType === "application/pdf" ||
    entry.path.toLowerCase().endsWith(".pdf")
  );
}

/**
 * The PDF a signed `manifest` record lists: the manuscript if it is a PDF,
 * else the first PDF. `null` when the record lists none, or is not a manifest
 * (an unreadable file is skipped, as the file list on the paper page skips it).
 */
export function parseManifestPdf(payload: unknown): VersionPdf | null {
  const files = isRecord(payload) && isRecord(payload.body) ? payload.body.files : null;
  if (!Array.isArray(files)) {
    return null;
  }
  const pdfs = files
    .map(readEntry)
    .filter((entry): entry is ManifestEntry => entry !== null && isPdf(entry));
  const pdf = pdfs.find((entry) => entry.role === "manuscript") ?? pdfs[0];
  return pdf === undefined
    ? null
    : { name: pdf.path, cid: pdf.cid, url: contentUrl(pdf.cid) };
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type ManifestClient = Pick<ApiClient, "get">;

/**
 * The version's PDF, from its manifest record.
 *
 * Resolves `null`, without a request, when the version record names no
 * manifest. The record is public (it is the signed ledger entry), so no token
 * is sent, and it is never cached: a moderator decides on what is there now.
 */
export async function loadVersionPdf(
  paper: ModeratedPaper,
  client: ManifestClient = api,
): Promise<VersionPdf | null> {
  if (paper.manifestCid === null) {
    return null;
  }
  const payload = await client.get<unknown>(
    `${RECORDS_ENDPOINT}/${encodeURIComponent(paper.manifestCid)}`,
    { auth: false, cache: "no-store" },
  );
  return parseManifestPdf(payload);
}

/**
 * How to ask the text route for this version: the paper (its `sch:` id, or
 * its genesis record id when that could not be derived) and the version
 * number. `null` when the signed record does not say which they are.
 */
export function textAddress(
  paper: ModeratedPaper,
): { readonly paper: string; readonly version: number } | null {
  const id = paper.shortId ?? paper.paperCid;
  if (id === null || paper.version === null) {
    return null;
  }
  return { paper: id, version: paper.version };
}

/**
 * The version's paragraphs, read with the moderator's token.
 *
 * @throws ReadingResponseError when the record does not say which paper and
 *   version it is, so there is nothing to ask for.
 */
export async function loadVersionText(
  paper: ModeratedPaper,
  client?: ReadingClient,
): Promise<ReadingText> {
  const address = textAddress(paper);
  if (address === null) {
    throw new ReadingResponseError(
      "The signed record does not say which paper and version this is, so its text cannot be read.",
    );
  }
  return loadReadingText(address.paper, address.version, client);
}
