/**
 * The signed file list of one version: what a dropped file is compared with.
 *
 * `GET /v1/papers/{id}/v/{n}/manifest` lists the files of a version in the
 * order the signed `manifest` record lists them. Its `path`, `cid`, `size`,
 * `mediaType` and `role` are the signed values; the rest of the response
 * (licence, scan status) is the node's own and is not read here.
 *
 * A node can say anything, so the answer is checked before it is believed:
 * it must name the version that was asked for (a node that answers for another
 * version would turn a genuine file into a "mismatch"), and every file must
 * carry a well-formed file id (the canonical raw-codec CIDv1 verify-core's
 * manifest validation demands). An answer that fails either is treated as no
 * answer, "could not check", never as evidence about the file.
 *
 * No React here; safe to import from a server component.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { parseFileCid } from "../verify-core";
import type { VersionRef } from "./version-ref";

/** One file the signed manifest lists. */
export interface SignedFile {
  /** Path inside the paper's bundle, `main.pdf` or `figures/fig1.png`. */
  readonly path: string;
  /** The signed file id: a raw-codec CIDv1 over SHA-256 (`bafkrei…`). */
  readonly cid: string;
  /** The signed size in bytes. */
  readonly size: number;
  /** What the file is for: `manuscript`, `dataset`, `code`… (display only). */
  readonly role: string;
}

/** The signed file list of one version. */
export interface VersionManifest {
  readonly ref: VersionRef;
  /** Id of the `paper.version` record, when the node says it. */
  readonly versionCid: string | null;
  /** Id of the signed `manifest` record, when the node says it. */
  readonly manifestCid: string | null;
  readonly files: readonly SignedFile[];
}

/** Loads one version's manifest. Rejects with a reason {@link describeManifestError} can say. */
export type LoadManifest = (ref: VersionRef, signal?: AbortSignal) => Promise<VersionManifest>;

/** `GET`-only slice of the API client, so tests need no network stack. */
export type ManifestClient = Pick<ApiClient, "get">;

/**
 * The node answered, but not with a usable file list for this version. The
 * message is shown to the reader as is, so write it for them.
 */
export class ManifestUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestUnavailableError";
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The manifest's path under `/v1`; the API client adds the prefix. */
export function manifestPath(ref: VersionRef): string {
  return `/papers/${encodeURIComponent(ref.shortId)}/v/${ref.version}/manifest`;
}

function parseSignedFile(entry: unknown, index: number): SignedFile {
  const where = `file ${index + 1}`;
  if (!isMapping(entry)) {
    throw new ManifestUnavailableError(`The node's file list was not readable (${where}).`);
  }
  const { path, cid, size, role } = entry;
  if (typeof path !== "string" || path === "") {
    throw new ManifestUnavailableError(`The node's file list was not readable (${where} has no path).`);
  }
  try {
    parseFileCid(cid);
  } catch {
    throw new ManifestUnavailableError(
      `The node's file list was not readable (${path} has no valid file id).`,
    );
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new ManifestUnavailableError(
      `The node's file list was not readable (${path} has no valid size).`,
    );
  }
  return { path, cid: cid as string, size, role: typeof role === "string" ? role : "other" };
}

/**
 * Read the manifest response for `ref`.
 *
 * @throws {ManifestUnavailableError} if the answer is not a file list for
 *   exactly this version.
 */
export function parseManifestResponse(body: unknown, ref: VersionRef): VersionManifest {
  if (!isMapping(body)) {
    throw new ManifestUnavailableError("The node's answer was not a file list.");
  }
  const shortId = body.shortId ?? body.paper;
  const version = body.n ?? body.version;
  if (shortId !== ref.shortId || version !== ref.version) {
    throw new ManifestUnavailableError(
      `The node answered for a different version than ${ref.schId}, so its files were not used.`,
    );
  }
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new ManifestUnavailableError(`The node lists no files for ${ref.schId}.`);
  }
  return {
    ref,
    versionCid: typeof body.versionCid === "string" ? body.versionCid : null,
    manifestCid: typeof body.manifestCid === "string" ? body.manifestCid : null,
    files: files.map(parseSignedFile),
  };
}

/** Build a {@link LoadManifest} that reads a node's public catalog API. */
export function createNodeManifestLoader(client: ManifestClient = api): LoadManifest {
  return async (ref, signal) => {
    const body = await client.get<unknown>(manifestPath(ref), { auth: false, signal });
    return parseManifestResponse(body, ref);
  };
}

/** The default loader: the shared API client, public read, no account. */
export const loadVersionManifest: LoadManifest = (ref, signal) =>
  createNodeManifestLoader()(ref, signal);

/** A reader-facing sentence for why the signed files could not be loaded. */
export function describeManifestError(error: unknown, ref: VersionRef): string {
  if (error instanceof ManifestUnavailableError) return error.message;
  if (error instanceof NetworkError) {
    return "Scholium could not reach the node. You may be offline.";
  }
  if (error instanceof ApiError) {
    return error.isNotFound
      ? `This node has no published ${ref.schId}. Check the id, or open the paper to see which versions exist.`
      : error.detail || error.title || "The node could not provide the signed files.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "The signed files could not be loaded.";
}
