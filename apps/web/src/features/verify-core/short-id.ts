/**
 * Stable `sch:` short ids for papers and paper versions.
 *
 * Browser port of `scholium_record_core.short_id`, pinned to
 * `apps/api/packages/record-core/vectors/short_ids.json`.
 *
 * ```text
 * sch:xxxx-xxxx-xxxx          paper
 * sch:xxxx-xxxx-xxxx/vN       version N of that paper (N >= 1)
 * ```
 *
 * The twelve `x` characters are lowercase RFC 4648 base32: the first ten
 * are the first 50 bits of the genesis CID's sha2-256 digest; the last two
 * are CRC-10/ATM (polynomial `0x233`, init 0, no reflection, no final xor)
 * over those 50 bits, high five bits first.  Parsing is case-insensitive
 * and always yields the canonical lowercase form.
 */

import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";

import { decodeCid } from "./cid-decode";
import { CID_CODEC_CODE, CID_VERSION } from "./envelope";

/** Scheme prefix of every short id and version id. */
export const SHORT_ID_PREFIX = "sch:";

/** Lowercase RFC 4648 base32 alphabet (the one CIDs use). */
export const SHORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Characters taken from the genesis CID digest. */
export const SHORT_ID_PAYLOAD_LENGTH = 10;

/** Checksum characters following the payload. */
export const SHORT_ID_CHECKSUM_LENGTH = 2;

/** Characters per hyphen-separated group. */
export const SHORT_ID_GROUP_SIZE = 4;

/** Largest supported version number (nine decimal digits). */
export const MAX_VERSION = 999_999_999;

/** SHA-256 multicodec code. */
const SHA2_256_CODE = 0x12;

const _BITS_PER_CHAR = 5;
const _CRC_WIDTH = 10;
const _CRC_MASK = (1 << _CRC_WIDTH) - 1;
const _CRC_POLY = 0x233;

const _SHOW_LIMIT = 60;

const _ID_PATTERN =
  /^sch:([a-z2-7]{4})-([a-z2-7]{4})-([a-z2-7]{4})(?:\/v([1-9][0-9]{0,8}))?$/i;

/** A parsed `sch:xxxx-xxxx-xxxx/vN` id. */
export interface VersionId {
  /** Canonical paper short id, `sch:xxxx-xxxx-xxxx`. */
  shortId: string;
  /** Version number `N`, at least 1. */
  version: number;
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > _SHOW_LIMIT
    ? `${text.slice(0, _SHOW_LIMIT - 3)}...`
    : text;
}

/**
 * CRC-10/ATM over `payload`'s characters, five bits each, MSB first.
 *
 * The fifty payload bits are consumed one at a time so no JavaScript number
 * ever has to hold them all.
 */
function checksum(payload: string): string {
  let crc = 0;
  for (const character of payload) {
    const value = SHORT_ID_ALPHABET.indexOf(character);
    for (let shift = _BITS_PER_CHAR - 1; shift >= 0; shift -= 1) {
      const feedback = ((crc >> (_CRC_WIDTH - 1)) ^ ((value >> shift) & 1)) & 1;
      crc = (crc << 1) & _CRC_MASK;
      if (feedback) {
        crc ^= _CRC_POLY;
      }
    }
  }
  const high = (crc >> _BITS_PER_CHAR) & 0x1f;
  const low = crc & 0x1f;
  return SHORT_ID_ALPHABET[high] + SHORT_ID_ALPHABET[low];
}

/** Render the twelve id characters as `sch:xxxx-xxxx-xxxx`. */
function group(body: string): string {
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += SHORT_ID_GROUP_SIZE) {
    groups.push(body.slice(i, i + SHORT_ID_GROUP_SIZE));
  }
  return SHORT_ID_PREFIX + groups.join("-");
}

function isCidLike(value: unknown): value is CID {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { version?: unknown; code?: unknown; multihash?: unknown };
  return (
    typeof candidate.version === "number" &&
    typeof candidate.code === "number" &&
    typeof candidate.multihash === "object" &&
    candidate.multihash !== null
  );
}

function genesisDigest(genesisCid: string | CID): Uint8Array {
  let cid: CID;
  if (typeof genesisCid === "string") {
    try {
      cid = decodeCid(genesisCid);
    } catch (cause) {
      throw new Error(
        `genesis CID ${show(genesisCid)} is not a valid CID`,
        { cause },
      );
    }
  } else if (isCidLike(genesisCid)) {
    cid = genesisCid;
  } else {
    throw new Error(
      `genesis CID must be a CID string or object, got ${
        genesisCid === null ? "None" : typeof genesisCid
      }`,
    );
  }
  if (
    cid.version !== CID_VERSION ||
    cid.code !== CID_CODEC_CODE ||
    cid.multihash.code !== SHA2_256_CODE
  ) {
    throw new Error(
      `genesis CID ${show(String(cid))} is not a record id: expected ` +
        `CIDv${CID_VERSION} with dag-cbor codec and sha2-256 hash`,
    );
  }
  return cid.multihash.digest;
}

/**
 * Derive the stable `sch:xxxx-xxxx-xxxx` short id of a paper.
 *
 * `genesisCid` is the record id (CIDv1, dag-cbor, sha2-256) of the paper's
 * `paper.genesis` record, as a string or a `CID` object.
 */
export function deriveShortId(genesisCid: string | CID): string {
  const digest = genesisDigest(genesisCid);
  // Seven bytes cover the 50 payload bits; base32 renders them as eleven
  // significant characters.  The first ten are the payload.
  const encoded = base32.encode(digest.subarray(0, 7)).slice(1).toLowerCase();
  const payload = encoded.slice(0, SHORT_ID_PAYLOAD_LENGTH);
  return group(payload + checksum(payload));
}

function parse(value: unknown): { shortId: string; version: number | null } {
  if (typeof value !== "string") {
    throw new Error(
      `sch: id must be a string, got ${
        value === null ? "None" : typeof value
      }`,
    );
  }
  const match = _ID_PATTERN.exec(value);
  if (match === null) {
    throw new Error(
      `${show(value)} is not a valid sch: id; expected ` +
        "'sch:xxxx-xxxx-xxxx' or 'sch:xxxx-xxxx-xxxx/vN' with base32 " +
        "characters (a-z, 2-7) and N from 1 to " +
        `${MAX_VERSION}`,
    );
  }
  const body = (match[1] + match[2] + match[3]).toLowerCase();
  const payload = body.slice(0, SHORT_ID_PAYLOAD_LENGTH);
  if (body.slice(SHORT_ID_PAYLOAD_LENGTH) !== checksum(payload)) {
    throw new Error(
      `sch: id ${show(value)} has a bad checksum; ` +
        "it was probably mistyped or truncated",
    );
  }
  const version = match[4] === undefined ? null : Number.parseInt(match[4], 10);
  return { shortId: group(body), version };
}

/**
 * Validate a paper `sch:xxxx-xxxx-xxxx` id; return its canonical form.
 *
 * A version id (`.../vN`) is not accepted here; use {@link parseVersionId}.
 */
export function parseShortId(value: string): string {
  const { shortId, version } = parse(value);
  if (version !== null) {
    throw new Error(
      `${show(value)} is a version id; expected a paper id ` +
        "'sch:xxxx-xxxx-xxxx' without a /vN suffix",
    );
  }
  return shortId;
}

/**
 * Parse a `sch:xxxx-xxxx-xxxx/vN` version id.
 *
 * @throws {Error} if `value` is malformed, has no `/vN` suffix, or has a
 *   bad checksum.
 */
export function parseVersionId(value: string): VersionId {
  const { shortId, version } = parse(value);
  if (version === null) {
    throw new Error(
      `${show(value)} has no version; expected 'sch:xxxx-xxxx-xxxx/vN'`,
    );
  }
  return { shortId, version };
}

/** Return the `sch:xxxx-xxxx-xxxx/vN` id of version `version`. */
export function formatVersionId(shortId: string, version: number): string {
  const canonical = parseShortId(shortId);
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION
  ) {
    throw new Error(
      `version must be an integer from 1 to ${MAX_VERSION}, got ${show(version)}`,
    );
  }
  return `${canonical}/v${version}`;
}

// Aliases matching the Python names.
export const derive_short_id = deriveShortId;
export const parse_short_id = parseShortId;
export const parse_version_id = parseVersionId;
export const format_version_id = formatVersionId;
