"use client";

/**
 * Step 1 of the submit wizard: Files (docs/design.md §5.4).
 *
 * "Drop PDF and/or LaTeX; optional code and data; resumable upload — shows
 * per-file fingerprint progress; size limits stated up front."
 *
 * - Two drop zones: **Paper** (PDF and/or LaTeX source) and **Code and data**
 *   (optional). Dropping or choosing files starts them straight away.
 * - The size limits sit above the zones, before anything is dropped.
 * - Each file shows its own fingerprint bar and upload bar (see `FileRow`).
 * - **Continue** opens only when every file is on the node and matches its
 *   fingerprint, and at least one of them is the paper.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { DropZone } from "./drop-zone";
import { FileRow } from "./file-row";
import { summaryText } from "./file-view";
import { SIZE_LIMITS } from "./limits";
import { useUploadManager } from "./use-upload-manager";
import {
  completedFiles,
  continueBlocker,
  summarize,
  type ManagerDeps,
  type SubmitFile,
} from "./upload-manager";
import "./submit.css";

/** What the Paper zone's file picker offers first; any file can still be chosen and is then validated. */
const PAPER_ACCEPT = ".pdf,.tex,.latex,.ltx,.bib,.bbl,.bst,.sty,.cls,.zip,.tar,.tar.gz,.tgz,.png,.jpg,.jpeg,.svg,.eps";

export interface FilesStepProps {
  /**
   * Called with the files that are on the node and match their fingerprints,
   * whenever that set changes. This is what later steps build the manifest from.
   */
  onFilesChange?: (files: SubmitFile[]) => void;
  /**
   * Called when the author continues. Without it the Continue button stays
   * closed: there is no next step to go to.
   */
  onContinue?: (files: SubmitFile[]) => void;
  /** The name of the step Continue leads to, for the button and its hint. */
  nextStepLabel?: string;
  /** Replaces the real fingerprinting and tus uploading (tests). */
  managerDeps?: ManagerDeps;
}

export function FilesStep({
  onFilesChange,
  onContinue,
  nextStepLabel = "Details",
  managerDeps,
}: FilesStepProps): ReactElement {
  const { manager, entries } = useUploadManager(managerDeps);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);

  const completed = useMemo(() => completedFiles(entries), [entries]);
  const summary = useMemo(() => summarize(entries), [entries]);
  const blocker = continueBlocker(entries);

  // Tell the parent about the set of finished files, not about every progress tick.
  const completedKey = JSON.stringify(completed);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (reported.current !== completedKey) {
      reported.current = completedKey;
      onFilesChange?.(completed);
    }
  }, [completedKey, completed, onFilesChange]);

  const handleFiles =
    (zone: "paper" | "extras") =>
    (files: File[], folders: string[]): void => {
      setFolderNotice(
        folders.length > 0
          ? `Folders cannot be uploaded as they are (${folders.join(", ")}). ` +
              "Compress each into a .zip or .tar.gz and add that instead."
          : null,
      );
      if (files.length > 0) {
        manager.addFiles(files, zone);
      }
    };

  const canContinue = blocker === null && onContinue !== undefined;
  const hint =
    blocker ?? (onContinue === undefined ? `Step 2, ${nextStepLabel}, is not open in this release yet.` : null);

  return (
    <section className="sw-step" aria-labelledby="sw-files-title">
      <h2 id="sw-files-title" className="sw-step__title">
        Files
      </h2>
      <p className="sw-step__lede">
        Add your paper as a PDF, a LaTeX source, or both. Code and data are optional.
      </p>

      <aside className="sw-limits" aria-labelledby="sw-limits-title">
        <h3 id="sw-limits-title" className="sw-limits__title">
          Size limits
        </h3>
        <ul className="sw-limits__list">
          {SIZE_LIMITS.map((limit) => (
            <li key={limit.id}>
              <span>{limit.label}</span> <strong>up to {limit.limit}</strong>
            </li>
          ))}
        </ul>
        <p className="sw-limits__note">
          Uploads are resumable. If your connection drops they carry on where they stopped; if you close the
          page, add the same file again to continue. Each file is fingerprinted on your device and checked
          against the copy on the node.
        </p>
      </aside>

      <div className="sw-zones">
        <DropZone
          title="Paper"
          prompt="Drop your PDF and/or LaTeX source here, or a .zip of it."
          limit="PDF up to 50 MB · other files up to 5 GB"
          inputLabel="Choose paper files"
          accept={PAPER_ACCEPT}
          onFiles={handleFiles("paper")}
        />
        <DropZone
          title="Code and data (optional)"
          prompt="Drop analysis code, notebooks or datasets here. Bundle many files into a .zip."
          limit="Up to 5 GB per file"
          inputLabel="Choose code and data files"
          onFiles={handleFiles("extras")}
        />
      </div>

      {folderNotice ? (
        <p className="sw-notice" role="alert">
          {folderNotice}
        </p>
      ) : null}

      <p className="sw-summary" role="status">
        {summaryText(summary)}
      </p>

      {entries.length > 0 ? (
        <ul className="sw-files" aria-label="Files in this submission">
          {entries.map((entry) => (
            <FileRow
              key={entry.id}
              entry={entry}
              onRole={(id, role) => manager.setRole(id, role)}
              onPause={(id) => manager.pause(id)}
              onResume={(id) => manager.resume(id)}
              onRetry={(id) => manager.retry(id)}
              onRemove={(id) => manager.remove(id)}
            />
          ))}
        </ul>
      ) : null}

      <div className="sw-actions">
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={!canContinue}
          aria-describedby="sw-continue-hint"
          onClick={() => onContinue?.(completed)}
        >
          Continue to {nextStepLabel}
        </button>
        <p id="sw-continue-hint" className="sw-actions__hint">
          {hint}
        </p>
      </div>
    </section>
  );
}
