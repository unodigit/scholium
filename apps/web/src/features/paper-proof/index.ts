/**
 * `paper-proof` — the Proof tab of the paper page (docs/design.md §5.3).
 *
 * The feature owns this module and the route group `app/(paper-proof)/`. The
 * paper page mounts the tab and, if it wants the header badge to follow it,
 * listens for the state:
 *
 * ```tsx
 * import { ProofTab } from "@/features/paper-proof";
 * import { VerifyBadge, type VerifyState } from "@/features/ui-kit";
 *
 * const [state, setState] = useState<VerifyState>("checking");
 *
 * <VerifyBadge state={state} />
 * <ProofTab schId="sch:k3f9-q2xz-7mwd/v2" onStateChange={setState} />
 * ```
 *
 * The tab runs verify-core in the browser and shows the plain-language
 * checklist, the technical details and the offline `scholium verify` command.
 * `/proof/k3f9-q2xz-7mwd/v2` shows it on a page of its own.
 */

export {
  ProofNotice,
  ProofTab,
  type ProofTabProps,
} from "./proof-tab";

export {
  runProofCheck,
  type ProofCheckOptions,
  type ProofOutcome,
} from "./run-proof-check";

export {
  PaperRefError,
  parsePaperRef,
  refFromSegments,
  type PaperRef,
} from "./paper-ref";

export {
  MAX_SYNC_PAGES,
  ProofUnavailableError,
  SYNC_PAGE_SIZE,
  createNodeProofSource,
  describeProofError,
  recordFromSyncEntry,
  type ProofClient,
  type ProofSource,
  type SignedRecord,
} from "./source";

export {
  PENDING_PROOF,
  formatAnchorTime,
  parseRecordProof,
  type AnchorInfo,
  type RecordProofInfo,
} from "./anchor";

export {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  fileCid,
  type FileLoader,
  type FileResult,
  type ManifestFile,
} from "./files";

export {
  archiveCommand,
  buildChecklist,
  noticeKindWord,
  offlineCommand,
  verdictCopy,
  verdictState,
  type ChecklistItem,
  type CheckLine,
  type ItemKey,
  type ItemState,
  type TechnicalRow,
  type VerdictState,
} from "./checklist";

export {
  LOCAL_PRESERVATION,
  NETWORK_PAGE_HREF,
  NETWORK_PATH,
  loadPreservation,
  parsePreservation,
  preservationCopy,
  type PreservationClient,
  type PreservationCopy,
  type PreservationInfo,
} from "./preservation";

export { PreservationFact, type PreservationFactProps } from "./preservation-fact";
