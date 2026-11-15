/**
 * `submit` — the /submit wizard (docs/design.md §5.4).
 *
 * Step 1, Files, is built: drag-and-drop PDF, LaTeX, code and data, resumable
 * tus uploads, a per-file fingerprint, and the size limits stated up front.
 *
 * ```tsx
 * import { FilesStep, SubmitWizard } from "@/features/submit";
 *
 * <SubmitWizard />                       // the whole page
 * <FilesStep onFilesChange={setFiles} /> // just step 1
 * ```
 *
 * The export is the plugin's public surface; route files in
 * `apps/web/src/app/(submit)/` and later wizard steps import from here.
 */

export { SubmitWizard, type SubmitWizardProps } from "./submit-wizard";
export { FilesStep, type FilesStepProps } from "./files-step";
export { WizardRail } from "./wizard-rail";
export { WIZARD_STEPS, nextStep, stepIndex, type WizardStepId } from "./wizard-steps";

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
