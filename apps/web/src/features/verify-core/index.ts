/**
 * `verify-core` — the browser port of the Python `scholium_record_core`
 * record core.
 *
 * Everything here is pinned to the shared cross-language vectors in
 * `apps/api/packages/record-core/vectors/`:
 *
 * - {@link computeRecordId} / {@link computeRecordCid} — record ids
 *   (`records.json`)
 * - {@link verifyEnvelope} / {@link verifyRecord} — Ed25519 over the
 *   canonical record bytes with `@noble/ed25519` (`signatures.json`)
 * - {@link deriveShortId} / {@link parseVersionId} — `sch:` ids
 *   (`short_ids.json`)
 * - {@link validateManifestBody} — manifest bodies (`manifests.json`)
 * - {@link verifyPaper} — the whole-paper verifier (`verification.json`)
 */

export * from "./envelope";
export * from "./cid-decode";
export * from "./signing";
export * from "./short-id";
export * from "./manifest";
export * from "./verify-paper";

import * as envelope from "./envelope";
import * as signing from "./signing";
import * as shortId from "./short-id";
import * as manifest from "./manifest";
import * as verifyPaperModule from "./verify-paper";

/** Namespace-style default export grouping every verify-core function. */
const verifyCore = {
  ...envelope,
  ...signing,
  ...shortId,
  ...manifest,
  ...verifyPaperModule,
};

export default verifyCore;
