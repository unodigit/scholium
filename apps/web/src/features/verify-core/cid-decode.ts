/**
 * Decode a CID from any multibase string, as the Python `multiformats`
 * port's `CID.decode(string)` does.
 *
 * `multiformats`' JavaScript `CID.parse` only knows base32 and CIDv0; this
 * helper looks the multibase up by its prefix first, so a file id written
 * in base58btc or uppercase base32 still decodes (and is then rejected by
 * the canonical-form check rather than mistaken for garbage).
 */

import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";

interface MultibaseDecoder {
  decode(value: string): Uint8Array;
}

const BY_PREFIX = new Map<string, MultibaseDecoder>();
for (const base of Object.values(bases)) {
  const prefix = (base as { prefix?: unknown }).prefix;
  if (typeof prefix === "string") {
    BY_PREFIX.set(prefix, base as MultibaseDecoder);
  }
}

/**
 * Decode `value` (a multibase CID string, or a CIDv0 `Qm...`) into a CID.
 *
 * @throws {Error} if `value` is empty, has an unknown multibase prefix, or
 *   does not encode a CID.
 */
export function decodeCid(value: unknown): CID {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("not a valid CID");
  }
  const base = BY_PREFIX.get(value[0]);
  if (base !== undefined) {
    return CID.decode(base.decode(value));
  }
  // CIDv0 (`Qm...`) carries no multibase prefix; `CID.parse` handles it.
  return CID.parse(value);
}
