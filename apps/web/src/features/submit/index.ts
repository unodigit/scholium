/**
 * `submit` — the /submit wizard (docs/design.md §5.4).
 *
 * Steps 1 and 2 are built: Files (drag-and-drop PDF, LaTeX, code and data,
 * resumable tus uploads, a per-file fingerprint) and Details (title, abstract,
 * categories, and a licence picker that defaults to CC BY 4.0).
 *
 * ```tsx
 * import { DetailsStep, FilesStep, SubmitWizard } from "@/features/submit";
 *
 * <SubmitWizard />                       // the whole page
 * <FilesStep onFilesChange={setFiles} /> // just step 1
 * ```
 *
 * The export is the plugin's public surface; route files in
 * `apps/web/src/app/(submit)/` and later wizard steps import from here.
 */

export { SubmitWizard, type SubmitWizardProps } from "./submit-wizard";
export { DetailsStep, type DetailsStepProps } from "./details-step";
export { FilesStep, type FilesStepProps } from "./files-step";
export { WizardRail } from "./wizard-rail";
export { WIZARD_STEPS, nextStep, stepIndex, type WizardStepId } from "./wizard-steps";

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
