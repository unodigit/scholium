/**
 * `submit` — the /submit wizard (docs/design.md §5.4).
 *
 * Steps 1 to 4 are built: Files (drag-and-drop PDF, LaTeX, code and data,
 * resumable tus uploads, a per-file fingerprint), Details (title, abstract,
 * categories, and a licence picker that defaults to CC BY 4.0), Authors
 * (co-authors by DID, ORCID iD or email, CRediT roles, byline order, and a
 * consent tracker showing Waiting, Signed or Declined) and Checks (live file
 * safety, references resolved, similarity and metadata match, with a place to
 * fix each problem).
 *
 * ```tsx
 * import { ChecksStep, ConsentTracker, FilesStep, SubmitWizard } from "@/features/submit";
 *
 * <SubmitWizard />                       // the whole page
 * <FilesStep onFilesChange={setFiles} /> // just step 1
 * <ChecksStep checksFor={{ paper, version }} /> // just step 4, with live results
 * <ConsentTracker entries={entries} />   // the tracker alone, for step 5 or /consent
 * <ConsentPage version={versionCid} />   // /consent/[version]: review, then accept or decline
 * ```
 *
 * The export is the plugin's public surface; route files in
 * `apps/web/src/app/(submit)/` and later wizard steps import from here.
 */

export { SubmitWizard, type SubmitWizardProps } from "./submit-wizard";
export { AuthorsStep, type AuthorsStepProps } from "./authors-step";
export { ChecksStep, type ChecksStepProps } from "./checks-step";
export { SignStep, type SignStepProps, type SignResult } from "./sign-step";
export { StatusTracker, type StatusTrackerProps } from "./status-tracker";
export { ConsentTracker, type ConsentTrackerProps } from "./consent-tracker";
export { ConsentPage, type ConsentPageProps } from "./consent-page";
export { DetailsStep, type DetailsStepProps } from "./details-step";
export { FilesStep, type FilesStepProps } from "./files-step";
export { WizardRail } from "./wizard-rail";
export { WIZARD_STEPS, nextStep, stepIndex, type WizardStepId } from "./wizard-steps";

export {
  CHECK_TITLES,
  SIMILARITY_HIGH_PCT,
  SIMILARITY_NOTICE_PCT,
  checkItems,
  checksAreRunning,
  checksBlockers,
  checksErrorMessage,
  checksFinished,
  checksPendingReason,
  checksSummary,
  checksWarnings,
  describeFailedCheck,
  fetchVersionChecks,
  fileProblem,
  formatPercent,
  normalizeVersionChecks,
  referencesResolved,
  type CheckFix,
  type CheckId,
  type CheckItem,
  type CheckState,
  type ChecksVersionRef,
  type DraftCheckFile,
  type FetchChecks,
  type FileSafety,
  type FileScanStatus,
  type VersionChecks,
} from "./checks";
export { DEFAULT_CHECK_POLL_MS, useChecks, type ChecksState, type UseChecksOptions } from "./use-checks";

export {
  CREDIT_ROLES,
  IDENTIFIER_HELP,
  KIND_LABELS,
  SUBMITTER_KEY,
  addAuthor,
  applyLookup,
  authorLabel,
  authorsBlockers,
  canContinueAuthors,
  initialAuthors,
  initials,
  isCreditRole,
  moveAuthor,
  normalizeOrcid,
  orcidCheckCharacter,
  parseIdentifier,
  recordAuthors,
  removeAuthor,
  shortDid,
  sortCreditRoles,
  toggleCreditRole,
  withSubmitterDid,
  type AddResult,
  type AuthorIdKind,
  type AuthorLookup,
  type CreditRole,
  type DraftAuthor,
  type MatchResult,
  type MatchState,
  type ParsedIdentifier,
  type RecordAuthor,
  type ResolveAuthor,
} from "./authors";

export {
  CONSENT_STATUS_LABELS,
  consentSummary,
  consentsErrorMessage,
  countConsents,
  declineNotice,
  fetchConsents,
  toConsentStatus,
  trackerFromDraft,
  trackerFromReport,
  type ConsentAuthorReport,
  type ConsentCounts,
  type ConsentReport,
  type ConsentStatus,
  type FetchConsents,
  type TrackerEntry,
  type VersionRef,
} from "./consents";
export { DEFAULT_CONSENT_POLL_MS, useConsents, type ConsentsState, type UseConsentsOptions } from "./use-consents";

export {
  AWAITING_CONSENT,
  CONSENT_COMMENT_MAX,
  CONSENT_RECORD_TYPE,
  FALLBACK_ROLE,
  ConsentVersionError,
  WrongSignerError,
  closedMessage,
  consentBody,
  consentGate,
  consentRole,
  consentTrackerEntries,
  describeConsentError,
  fetchRecord,
  fileUrl,
  formatSigned,
  loadConsentVersion,
  manifestFiles,
  normalizeConsentVersion,
  parseVersionParam,
  recordUrl,
  submitConsent,
  versionErrorMessage,
  type ComputeRecordId,
  type ConsentDecision,
  type ConsentFailure,
  type ConsentGate,
  type ConsentGateInput,
  type ConsentSubmitted,
  type ConsentVersion,
  type ConsentVersionErrorCode,
  type DeviceIdentity,
  type FetchRecord,
  type LoadConsentVersion,
  type LoadConsentVersionOptions,
  type ParsedVersionParam,
  type RecordAccepted,
  type SignConsent,
  type SubmitConsent,
  type SubmitConsentOptions,
  type VersionAuthor,
  type VersionFile,
} from "./consent-version";
export { useConsentVersion, type ConsentVersionState } from "./use-consent-version";
export { useDeviceDid } from "./use-device-did";
export { useSubmitterDid } from "./use-submitter-did";

export { NewVersionLink, type NewVersionLinkProps } from "./new-version-link";
export { NewVersionPage, type NewVersionPageProps } from "./new-version-page";

export {
  CHANGE_NOTE_MAX,
  NEW_VERSION_RECORD_TYPE,
  NewVersionPaperError,
  WrongRecordError,
  bylineAsDraft,
  canSignNewVersion,
  describeNewVersionError,
  draftFromPaper,
  fetchNewVersionPaper,
  loadNewVersionPaper,
  newVersionBlockers,
  newVersionBody,
  newVersionHref,
  newVersionLoadErrorMessage,
  parseNewVersionRef,
  recordAuthorEntries,
  submitNewVersion,
  type FetchNewVersionPaper,
  type LoadNewVersion,
  type LoadNewVersionOptions,
  type NewVersionAuthor,
  type NewVersionDraft,
  type NewVersionFailure,
  type NewVersionPaper,
  type NewVersionPaperErrorCode,
  type NewVersionSubmitted,
  type ParsedNewVersionRef,
  type SignVersionRecord,
  type SubmitNewVersionOptions,
  type SubmitVersionRecord,
  type VersionRecordAccepted,
} from "./new-version";

export {
  ABSTRACT_MAX_LENGTH,
  CATEGORIES,
  CATEGORY_GROUPS,
  DEFAULT_LICENCE_ID,
  LICENCES,
  MAX_CATEGORIES,
  TITLE_MAX_LENGTH,
  canContinueDetails,
  detailsBlockers,
  emptyDetails,
  licenceById,
  toggleCategory,
  type CategoryGroup,
  type CategoryOption,
  type DetailsValues,
  type JournalFit,
  type LicenceOption,
} from "./details";

export {
  FILE_ROLES,
  PAPER_ROLES,
  ROLE_LABELS,
  defaultRole,
  rolesFor,
  type FileRole,
  type FileZone,
} from "./file-roles";

export {
  FILE_MAX_BYTES,
  PDF_MAX_BYTES,
  SIZE_LIMITS,
  checkSize,
  formatBytes,
  isPdf,
  maxBytesFor,
} from "./limits";

export { fingerprintBlob, sameCid, shortCid } from "./fingerprint";
export { startTusUpload, type UploadFailure } from "./tus-upload";

export {
  UploadManager,
  completedFiles,
  continueBlocker,
  summarize,
  type EntryStatus,
  type FileEntry,
  type ManagerDeps,
  type SubmitFile,
} from "./upload-manager";
export { useUploadManager } from "./use-upload-manager";


export {
  SUBMIT_DRAFT_DATABASE_NAME,
  SUBMIT_DRAFT_STORE_NAME,
  SUBMIT_DRAFT_DATABASE_VERSION,
  SUBMIT_DRAFT_RECORD_ID,
  SUBMIT_DRAFT_RECORD_VERSION,
  isStoredSubmitDraft,
  isSubmitDraft,
  MemorySubmitDraftStorage,
  IndexedDbSubmitDraftStorage,
  createSubmitDraftStorage,
  type SubmitDraft,
  type StoredSubmitDraft,
  type SubmitDraftStorage,
  type IndexedDbSubmitDraftStorageOptions,
} from "./submit-draft-storage";

export { useSubmitDraft, type UseSubmitDraftOptions, type UseSubmitDraftResult } from "./use-submit-draft";
