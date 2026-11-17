/**
 * `verify-page` — "Verify a file" (`/verify`, docs/design.md §4).
 *
 * The feature owns this module and the route group `app/(verify-page)/`. A
 * paper page that wants to send a reader to the page with the version already
 * filled in links to it:
 *
 * ```tsx
 * import { verifyHref } from "@/features/verify-page";
 *
 * <a href={verifyHref("sch:6sel-2dio-orm6/v2")}>Verify a file you downloaded</a>
 * ```
 *
 * The reader drops a file; its id is computed in their browser and compared
 * with the version's signed file list. `This file does not match what the
 * authors signed` is shown when it is none of them.
 */

export { VerifyPage, type VerifyPageProps } from "./verify-page";

export { VERIFY_PATH, verifyHref } from "./verify-href";

export {
  EXAMPLE_VERSION_ID,
  PLACEHOLDER_VERSION_ID,
  parseVersionRef,
  proofHref,
  type ParsedVersionRef,
  type VersionRef,
} from "./version-ref";

export {
  ManifestUnavailableError,
  createNodeManifestLoader,
  describeManifestError,
  loadVersionManifest,
  manifestPath,
  parseManifestResponse,
  type LoadManifest,
  type ManifestClient,
  type SignedFile,
  type VersionManifest,
} from "./manifest-source";

export { baseName, compareFile, type Comparison, type FileFacts } from "./compare";

export {
  CANNOT_CHECK_HEADLINE,
  CHECKING_HEADLINE,
  MATCH_HEADLINE,
  MISMATCH_HEADLINE,
  UNREADABLE_HEADLINE,
  VERDICT_LOOKS,
  deriveVerdict,
  filesPhrase,
  manifestStateFor,
  type FileState,
  type LoadedManifest,
  type ManifestState,
  type Verdict,
  type VerdictInput,
  type VerdictKind,
  type VerdictTone,
} from "./verdict";

export { useFileCheck, type FileCheck, type FileCheckOptions } from "./use-file-check";
