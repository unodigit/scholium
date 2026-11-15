"use client";

/**
 * Step 4 of the submit wizard: Checks (docs/design.md §5.4).
 *
 * "Live results: file safety, references resolved, similarity, metadata match.
 * Problems are fixable in place; nothing is hidden from the author."
 *
 * The four rows are always all shown: a check that has not run says so, it
 * does not disappear. While the node is scanning the version the step asks
 * again every few seconds (`useChecks`), so a result replaces "Scanning" by
 * itself; after that the author can ask again with **Check again**.
 *
 * A failed file safety scan and a title that is not on page 1 both come with
 * the place to fix them (Files and Details). Unresolved references and a high
 * similarity are shown as signals, not blockers — the design asks that nothing
 * be hidden, not that every signal stop the author.
 *
 * Before the version exists there is nothing to ask the node; the step then
 * names the files that will be scanned and says when the checks run. Give it
 * `checksFor` (the version the node holds, as with `consentsFor` on step 3)
 * and it shows the real results.
 */

import { useEffect, useMemo, useRef, type ReactElement } from "react";

import {
  checkItems,
  checksBlockers,
  checksPendingReason,
  checksSummary,
  checksWarnings,
  fileProblem,
  type CheckId,
  type CheckItem,
  type CheckState,
  type ChecksVersionRef,
  type DraftCheckFile,
  type FetchChecks,
  type FileSafety,
  type VersionChecks,
} from "./checks";
import {
  CheckIcon,
  ClockIcon,
  InfoIcon,
  ReferenceIcon,
  ShieldIcon,
  SimilarityIcon,
  TitleIcon,
  WarningIcon,
} from "./icons";
import { useChecks } from "./use-checks";
import "./submit.css";

export interface ChecksStepProps {
  /**
   * The version whose check results to show. Without one no version exists
   * yet, so the step explains what will be checked and when.
   */
  checksFor?: ChecksVersionRef | null;
  /** Replaces the check request (tests, and callers with their own client). */
  fetchChecks?: FetchChecks;
  /** How often to ask the node again while it is scanning. */
  pollMs?: number;
  /** The draft's finished files, shown before the version exists. */
  files?: readonly DraftCheckFile[];
  /** Go back to step 3, Authors. */
  onBack?: () => void;
  /**
   * Go on to step 5. Without it Continue stays closed: there is no step 5 to
   * go to in this release.
   */
  onContinue?: (report: VersionChecks) => void;
  /** The name of the step Continue leads to, for the button and its hint. */
  nextStepLabel?: string;
  /** Go to step 1 to replace a file the safety scan failed. */
  onFixFiles?: () => void;
  /** Go to step 2 to fix the title the metadata check could not find. */
  onFixDetails?: () => void;
}

const STATE_TONES: Record<CheckState, string | undefined> = {
  pending: undefined,
  running: "active",
  passed: "verified",
  attention: "pending",
};

function CheckKindIcon({ id }: { id: CheckId }): ReactElement {
  switch (id) {
    case "files":
      return <ShieldIcon />;
    case "references":
      return <ReferenceIcon />;
    case "similarity":
      return <SimilarityIcon />;
    case "metadata":
      return <TitleIcon />;
  }
}

function StateIcon({ state }: { state: CheckState }): ReactElement {
  switch (state) {
    case "passed":
      return <CheckIcon />;
    case "attention":
      return <WarningIcon />;
    case "running":
    case "pending":
    default:
      return <ClockIcon />;
  }
}

const FILE_TONES: Record<FileSafety["status"], string | undefined> = {
  passed: "verified",
  failed: "critical",
  scanning: "active",
  pending: undefined,
};

const FILE_LABELS: Record<FileSafety["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  scanning: "Scanning",
  pending: "Not scanned yet",
};

/** The generic state a file's own verdict lends its chip icon. */
function fileState(status: FileSafety["status"]): CheckState {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "attention";
    case "scanning":
      return "running";
    case "pending":
    default:
      return "pending";
  }
}

function fileRowsFor(
  report: VersionChecks | null,
  files: readonly DraftCheckFile[],
): readonly FileSafety[] {
  if (report !== null) {
    return report.files;
  }
  return files.map<FileSafety>((file) => ({
    path: file.path,
    cid: file.cid ?? "",
    role: file.role ?? null,
    status: "pending",
    failedChecks: [],
    detail: null,
  }));
}

export function ChecksStep({
  checksFor,
  fetchChecks,
  pollMs,
  files = [],
  onBack,
  onContinue,
  nextStepLabel = "Sign",
  onFixFiles,
  onFixDetails,
}: ChecksStepProps): ReactElement {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { phase, report, error, refresh } = useChecks(checksFor, { fetcher: fetchChecks, intervalMs: pollMs });

  useEffect(() => {
    // Entering the step from Authors should start at the step's own heading,
    // not leave focus on a button that has just disappeared.
    titleRef.current?.focus();
  }, []);

  const items = useMemo(() => checkItems(report, files), [report, files]);
  const fileRows = useMemo(() => fileRowsFor(report, files), [report, files]);
  const blockers = checksBlockers(report);
  const warnings = checksWarnings(report);
  const canContinue = report !== null && blockers.length === 0 && onContinue !== undefined;
  const hint =
    blockers[0] ??
    (onContinue === undefined ? `Step 5, ${nextStepLabel}, is not open in this release yet.` : null);
  const waitingForVersion = checksFor == null;

  const summary =
    phase === "loading" && report === null
      ? "Asking the node for this version's checks…"
      : checksSummary(items);

  const fixFor = (item: CheckItem): (() => void) | null => {
    if (item.fix === "files" && onFixFiles !== undefined) {
      return onFixFiles;
    }
    if (item.fix === "details" && onFixDetails !== undefined) {
      return onFixDetails;
    }
    return null;
  };

  return (
    <section className="sw-step" aria-labelledby="sw-checks-title">
      <h2 id="sw-checks-title" ref={titleRef} className="sw-step__title" tabIndex={-1}>
        Checks
      </h2>
      <p className="sw-step__lede">
        These run automatically on the version you are about to sign. Nothing is hidden: if a check finds a
        problem, fix it in place and run the checks again.
      </p>

      {waitingForVersion ? (
        <p className="sw-notice" role="note">
          The checks run on the signed version. Their results appear here as the node finishes each one, so this
          list shows what is still waiting.
        </p>
      ) : null}

      {report !== null && report.state === "awaiting_consent" ? (
        <p className="sw-notice" role="note">
          {checksPendingReason(report)}
        </p>
      ) : null}

      <section className="sw-checks" aria-labelledby="sw-checks-results-title" aria-busy={phase === "loading"}>
        <header className="sw-checks__head">
          <h3 id="sw-checks-results-title" className="sw-checks__title">
            What the node found
          </h3>
          <p className="sw-checks__summary" role="status">
            {summary}
          </p>
          {checksFor != null ? (
            <button
              type="button"
              className="sw-button sw-button--quiet"
              onClick={refresh}
              disabled={phase === "loading"}
            >
              Check again
            </button>
          ) : null}
        </header>

        {error !== null ? (
          <p className="sw-notice" role="alert">
            <InfoIcon /> {error}
          </p>
        ) : null}

        <ul className="sw-checks__list">
          {items.map((item) => {
            const fix = fixFor(item);
            return (
              <li key={item.id} className="sw-check" data-state={item.state}>
                <div className="sw-check__head">
                  <span className="sw-check__icon" aria-hidden="true">
                    <CheckKindIcon id={item.id} />
                  </span>
                  <span className="sw-check__who">
                    <span className="sw-check__name">{item.title}</span>
                    <span className="sw-check__summary">{item.summary}</span>
                  </span>
                  <span className="sw-chip" data-tone={STATE_TONES[item.state]}>
                    <StateIcon state={item.state} />
                    {item.label}
                  </span>
                </div>
                <p className="sw-check__detail">{item.detail}</p>

                {item.id === "files" && fileRows.length > 0 ? (
                  <ul className="sw-check__files" aria-label="Files and their safety scan">
                    {fileRows.map((file) => (
                      <li key={`${file.path}-${file.cid}`} className="sw-check__file" data-status={file.status}>
                        <span className="sw-check__file-name">{file.path}</span>
                        <span className="sw-chip" data-tone={FILE_TONES[file.status]}>
                          <StateIcon state={fileState(file.status)} />
                          {FILE_LABELS[file.status]}
                        </span>
                        {file.status === "failed" ? (
                          <span className="sw-check__file-detail">{fileProblem(file)}</span>
                        ) : file.detail !== null ? (
                          <span className="sw-check__file-detail">{file.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {fix !== null ? (
                  <div className="sw-check__actions">
                    <button type="button" className="sw-button sw-button--quiet" onClick={fix}>
                      {item.fix === "files" ? "Replace in Files" : "Edit the title"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {warnings.length > 0 ? (
          <ul className="sw-checks__notes" aria-label="What these checks mean">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="sw-actions">
        {onBack ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={onBack}>
            Back to Authors
          </button>
        ) : null}
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={!canContinue}
          aria-describedby="sw-checks-continue-hint"
          onClick={() => {
            if (report !== null) {
              onContinue?.(report);
            }
          }}
        >
          Continue to {nextStepLabel}
        </button>
        <p id="sw-checks-continue-hint" className="sw-actions__hint">
          {hint}
        </p>
      </div>
    </section>
  );
}
