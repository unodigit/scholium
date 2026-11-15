/**
 * `submit` — the /submit wizard (docs/design.md §5.4).
 *
 * Steps 1 to 3 are built: Files (drag-and-drop PDF, LaTeX, code and data,
 * resumable tus uploads, a per-file fingerprint), Details (title, abstract,
 * categories, and a licence picker that defaults to CC BY 4.0) and Authors
 * (co-authors by DID, ORCID iD or email, CRediT roles, byline order, and a
 * consent tracker showing Waiting, Signed or Declined).
 *
 * ```tsx
 * import { ConsentTracker, FilesStep, SubmitWizard } from "@/features/submit";
 *
 * <SubmitWizard />                       // the whole page
 * <FilesStep onFilesChange={setFiles} /> // just step 1
 * <ConsentTracker entries={entries} />   // the tracker alone, for step 5 or /consent
 * ```
 *
 * The export is the plugin's public surface; route files in
 * `apps/web/src/app/(submit)/` and later wizard steps import from here.
 */

export { SubmitWizard, type SubmitWizardProps } from "./submit-wizard";
export { AuthorsStep, type AuthorsStepProps } from "./authors-step";
export { ConsentTracker, type ConsentTrackerProps } from "./consent-tracker";
export { DetailsStep, type DetailsStepProps } from "./details-step";
export { FilesStep, type FilesStepProps } from "./files-step";
export { WizardRail } from "./wizard-rail";
export { WIZARD_STEPS, nextStep, stepIndex, type WizardStepId } from "./wizard-steps";

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
export { useSubmitterDid } from "./use-submitter-did";

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
