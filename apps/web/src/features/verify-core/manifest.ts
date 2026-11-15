/**
 * Validation of `manifest` record bodies.
 *
 * Browser port of `scholium_record_core.manifest`, pinned to
 * `apps/api/packages/record-core/vectors/manifests.json`.
 *
 * ```json
 * {"files": [
 *   {"path": "main.pdf", "cid": "bafkrei...", "size": 1048576,
 *    "mediaType": "application/pdf", "role": "manuscript"}
 * ]}
 * ```
 *
 * Every field is validated strictly so all ports agree byte-for-byte on
 * what a manifest may contain.
 */

import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";

import { decodeCid } from "./cid-decode";
import { CID_VERSION } from "./envelope";

/** Record type this module validates. */
export const MANIFEST_TYPE = "manifest";

/** Body-level key holding the file list. */
export const FILES_FIELD = "files";

/** Fields of one manifest file entry, in canonical order. */
export const FILE_FIELDS = ["path", "cid", "size", "mediaType", "role"] as const;

/** Roles a file may play in a paper bundle. `other` is the catch-all. */
export const FILE_ROLES: ReadonlySet<string> = new Set([
  "manuscript",
  "source",
  "figure",
  "table",
  "dataset",
  "code",
  "supplementary",
  "bibliography",
  "style",
  "cover",
  "other",
]);

/** Largest accepted `size` (JS `Number.MAX_SAFE_INTEGER`). */
export const MAX_FILE_SIZE = 2 ** 53 - 1;

/** Longest accepted `path`. */
export const MAX_PATH_LENGTH = 1024;

/** Codec used for file ids: raw bytes, no wrapping DAG. */
export const FILE_CODEC_CODE = 0x55;

/** SHA-256 multicodec code. */
const SHA2_256_CODE = 0x12;

const _MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const _SHOW_LIMIT = 60;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = JSON.stringify(value);
  } else if (value === null || value === undefined) {
    text = "None";
  } else if (value === true) {
    text = "True";
  } else if (value === false) {
    text = "False";
  } else {
    text = String(value);
  }
  return text.length > _SHOW_LIMIT
    ? `${text.slice(0, _SHOW_LIMIT - 3)}...`
    : text;
}

function validatePath(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${where} field 'path' must be a non-empty string, got ${show(value)}`,
    );
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(
      `${where} field 'path' is ${value.length} characters; at most ` +
        `${MAX_PATH_LENGTH} are allowed`,
    );
  }
  if (value.includes("\\")) {
    throw new Error(
      `${where} field 'path' ${show(value)} must use '/' separators, ` +
        "not backslashes",
    );
  }
  if (value.startsWith("/")) {
    throw new Error(
      `${where} field 'path' ${show(value)} must be relative, not absolute`,
    );
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `${where} field 'path' ${show(value)} must not contain control ` +
          "characters",
      );
    }
  }
  const components = value.split("/");
  if (components.some((c) => c === "" || c === "." || c === "..")) {
    throw new Error(
      `${where} field 'path' ${show(value)} must be a normalized ` +
        "relative path: no empty, '.' or '..' components",
    );
  }
  return value;
}

function validateSize(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `${where} field 'size' must be an integer number of bytes, got ${show(value)}`,
    );
  }
  if (value < 0) {
    throw new Error(
      `${where} field 'size' must not be negative, got ${value}`,
    );
  }
  if (value > MAX_FILE_SIZE) {
    throw new Error(
      `${where} field 'size' ${value} exceeds the maximum accepted file ` +
        `size ${MAX_FILE_SIZE}`,
    );
  }
  return value;
}

function validateMediaType(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${where} field 'mediaType' must be a non-empty string, got ${show(value)}`,
    );
  }
  if (!_MEDIA_TYPE_PATTERN.test(value)) {
    throw new Error(
      `${where} field 'mediaType' ${show(value)} must be a bare lowercase ` +
        "type/subtype per RFC 6838 (no parameters, no wildcards, no uppercase)",
    );
  }
  return value;
}

function validateRole(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${where} field 'role' must be a non-empty string, got ${show(value)}`,
    );
  }
  if (!FILE_ROLES.has(value)) {
    const known = [...FILE_ROLES].sort().join(", ");
    throw new Error(
      `${where} field 'role' ${show(value)} is not one of the known file ` +
        `roles: ${known}`,
    );
  }
  return value;
}

/**
 * Validate a file id string and return it as a CIDv1 raw-codec object.
 *
 * `value` must be the canonical base32 form -- exactly what a file id is
 * written as.  Equivalent encodings of the same CID are rejected so a
 * manifest can never carry two spellings of one file id.
 */
export function parseFileCid(value: unknown): CID {
  if (typeof value !== "string") {
    throw new Error(
      `file id must be a string, got ${value === null ? "None" : typeof value}`,
    );
  }
  let cid: CID;
  try {
    cid = decodeCid(value);
  } catch (cause) {
    throw new Error(`file id ${show(value)} is not a valid CID`, { cause });
  }
  if (
    cid.version !== CID_VERSION ||
    cid.code !== FILE_CODEC_CODE ||
    cid.multihash.code !== SHA2_256_CODE
  ) {
    throw new Error(
      `file id ${show(value)} is not a raw file id: expected CIDv${CID_VERSION} ` +
        "with raw codec and sha2-256 hash",
    );
  }
  const canonical = cid.toString(base32);
  if (value !== canonical) {
    throw new Error(
      `file id ${show(value)} is not in canonical base32 form; ` +
        `expected ${canonical}`,
    );
  }
  return cid;
}

/**
 * Validate one manifest file entry; return it in canonical form.
 *
 * The entry must carry exactly {@link FILE_FIELDS}; extra keys are
 * rejected, so it never silently drops data.
 */
export function validateManifestEntry(
  entry: unknown,
  where = "file entry",
): Record<string, unknown> {
  if (!isMapping(entry)) {
    throw new Error(
      `${where} must be a mapping, got ${entry === null ? "None" : typeof entry}`,
    );
  }
  const missing = FILE_FIELDS.filter((field) => !(field in entry));
  if (missing.length > 0) {
    throw new Error(
      `${where} is missing required field(s): ${missing.join(", ")}`,
    );
  }
  const unexpected = Object.keys(entry).filter(
    (key) => !(FILE_FIELDS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${where} has unexpected field(s): ${unexpected
        .map((key) => JSON.stringify(key))
        .join(", ")}`,
    );
  }

  const canonical: Record<string, unknown> = {};
  canonical.path = validatePath(entry.path, where);
  try {
    parseFileCid(entry.cid);
  } catch (cause) {
    throw new Error(
      `${where} field 'cid': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  canonical.cid = entry.cid; // already the canonical spelling
  canonical.size = validateSize(entry.size, where);
  canonical.mediaType = validateMediaType(entry.mediaType, where);
  canonical.role = validateRole(entry.role, where);
  return canonical;
}

/**
 * Validate a `manifest` record body; return it in canonical form.
 *
 * `body` must be a mapping with exactly one key, `files`: a non-empty list
 * of file entries.  Every `path` must be unique.
 */
export function validateManifestBody(body: unknown): { files: Record<string, unknown>[] } {
  if (!isMapping(body)) {
    throw new Error(
      `manifest body must be a mapping, got ${body === null ? "None" : typeof body}`,
    );
  }
  if (!(FILES_FIELD in body)) {
    throw new Error(
      `manifest body is missing required field(s): ${FILES_FIELD}`,
    );
  }
  const unexpected = Object.keys(body).filter((key) => key !== FILES_FIELD);
  if (unexpected.length > 0) {
    throw new Error(
      "manifest body has unexpected field(s): " +
        unexpected.map((key) => JSON.stringify(key)).join(", "),
    );
  }

  const files = body[FILES_FIELD];
  if (!Array.isArray(files)) {
    throw new Error(
      `manifest field 'files' must be a sequence, got ${
        files === null ? "None" : typeof files
      }`,
    );
  }
  if (files.length === 0) {
    throw new Error("manifest field 'files' must list at least one file");
  }

  const seen = new Map<string, number>();
  const canonicalFiles: Record<string, unknown>[] = [];
  files.forEach((entry, index) => {
    const where = `files[${index}]`;
    const canonical = validateManifestEntry(entry, where);
    const path = canonical.path as string;
    const previous = seen.get(path);
    if (previous !== undefined) {
      throw new Error(
        `${where} field 'path' ${show(path)} repeats files[${previous}]`,
      );
    }
    seen.set(path, index);
    canonicalFiles.push(canonical);
  });
  return { files: canonicalFiles };
}

// Aliases matching the Python names.
export const validate_manifest_entry = validateManifestEntry;
export const validate_manifest_body = validateManifestBody;
export const parse_file_cid = parseFileCid;
