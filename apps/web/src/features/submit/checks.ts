/**
 * Step 4 of the submit wizard: Checks (docs/design.md §5.4).
 *
 * "Live results: file safety, references resolved, similarity, metadata match.
 * Problems are fixable in place; nothing is hidden from the author."
 *
 * The values come from the version's automated checks:
 *
 * - **File safety** is the sanitizer's verdict on every file of the version's
 *   manifest (`blobs.scan_status` and the `scan_reports` rows behind it). A
 *   PDF with JavaScript, embedded files or hidden text, or an archive with
 *   unsafe paths, fails it.
 * - **References resolved** is `check_results.references_total` and
 *   `references_unresolved`: how many entries in the reference list Crossref
 *   confirmed.
 * - **Similarity** is `check_results.similarity_pct`: the highest word 5-gram
 *   Jaccard overlap with another listed paper, 0-100.
 * - **Metadata match** is `check_results.metadata_match`: whether the signed
 *   title appears in the text of the PDF's first page.
 *
 * This module is the data and the rules; `checks-step.tsx` draws them and
 * `use-checks.ts` keeps them fresh while the node is still working. No React
 * here, so the rules can be tested on their own.
 *
 * The response shape is not pinned by the spec yet; {@link normalizeVersionChecks}
 * accepts the natural camelCase form and the flat/snake_case spellings the
 * `check_results` columns use, so the step is not coupled to one wire spelling.
 * A missing field stays `null` and is shown as "Not run yet" rather than as a
 * passing check.
 */

import { ApiError, api } from "../../lib/api";

/** The paper version a check report is about. */
export interface ChecksVersionRef {
  /** The paper's `sch:` short id (a full genesis cid is accepted too). */
  paper: string;
  /** The version number, from 1. */
  version: number;
}

/** What the sanitizer has decided about one file. */
export type FileScanStatus = "passed" | "failed" | "scanning" | "pending";

/** One file of the version's manifest, with its safety verdict. */
export interface FileSafety {
  /** The manifest path; what the author recognises in Files. */
  path: string;
  cid: string;
  role: string | null;
  status: FileScanStatus;
  /** Failing checks in the scanner's own order (`javascript`, `hidden_text`, …). */
  failedChecks: string[];
  /** The scanner's explanation, when it gave one. */
  detail: string | null;
}

/**
 * A version's automated check results, in the shape the step reads.
 *
 * Every check column is nullable because the checks run independently: a row
 * fills in as each one finishes. `null` means "that check has not run (yet)",
 * never "passed".
 */
export interface VersionChecks {
  paper: string;
  version: number;
  versionCid: string;
  /** The version's lifecycle state: `awaiting_consent`, `scanning`, `moderation`, … */
  state: string;
  files: FileSafety[];
  /** `check_results.references_total`, or `null` when the reference check has not run. */
  referencesTotal: number | null;
  /** `check_results.references_unresolved`, or `null` when the reference check has not run. */
  referencesUnresolved: number | null;
  /** `check_results.similarity_pct` (0-100), or `null` when it has not run. */
  similarityPct: number | null;
  /** `check_results.metadata_match`, or `null` when it has not run. */
  metadataMatch: boolean | null;
  /** The signed title the metadata check looked for, when the node reports it. */
  signedTitle: string | null;
  /** The beginning of page one's text, when the node reports it. */
  firstPageTitle: string | null;
  /** When the results were last written, ISO 8601, when the node reports it. */
  checkedAt: string | null;
  /**
   * Whether the advisory checks ran at all. A version the safety scan held has
   * a report of its per-file verdicts but no similarity, references or metadata
   * results, because those run only after a clean scan. Absent (an older node)
   * reads as `true`.
   */
  checksRan?: boolean;
}

/** A draft file shown before a version exists, so step 4 can say what will be scanned. */
export interface DraftCheckFile {
  path: string;
  cid?: string;
  role?: string | null;
}

/** Fetches a version's check report; tests and later callers replace it. */
export type FetchChecks = (ref: ChecksVersionRef, signal?: AbortSignal) => Promise<VersionChecks>;

/**
 * Ask the node for a version's check results.
 *
 *     GET /v1/papers/{id}/v/{n}/checks
 *
 * A listed version's report is public, but an unlisted one (still being
 * scanned, awaiting consent or in moderation, which is where the author's
 * status tracker and this step look) is served only to its authors and to
 * moderators; everyone else gets the unknown-version `404`. So the request
 * goes through the client's own auth: the signed-in reader's bearer token is
 * sent, and an anonymous reader of a listed paper sends none.
 *
 * Callers that already have the data, or that run against a different node,
 * pass their own {@link FetchChecks}.
 */
export const fetchVersionChecks: FetchChecks = async (ref, signal) => {
  const payload = await api.get<unknown>(
    `/papers/${encodeURIComponent(ref.paper)}/v/${encodeURIComponent(String(ref.version))}/checks`,
    { signal },
  );
  return normalizeVersionChecks(payload, ref);
};

/** Where the author can fix what a check found. */
export type CheckFix = "files" | "details";

/** One row of step 4. */
export interface CheckItem {
  id: CheckId;
  title: string;
  state: CheckState;
  /** The word on the chip; there is always one, so state is never colour alone. */
  label: string;
  /** One line under the title. */
  summary: string;
  /** A sentence saying what it means and what to do about it. */
  detail: string;
  /** The place to fix it, when the author can. */
  fix: CheckFix | null;
}

export type CheckId = "files" | "references" | "similarity" | "metadata";

/** `pending` = not run, `running` = the node is still working. */
export type CheckState = "pending" | "running" | "passed" | "attention";

export const CHECK_TITLES: Record<CheckId, string> = {
  files: "File safety",
  references: "References",
  similarity: "Similarity",
  metadata: "Metadata match",
};

/** At or above this percentage, overlap is worth the author's attention. */
export const SIMILARITY_NOTICE_PCT = 15;
/** At or above this percentage, say plainly that the overlap is high. */
export const SIMILARITY_HIGH_PCT = 30;

/** How a failing scanner check reads to the author. */
const FAILED_CHECK_WORDS: Record<string, string> = {
  javascript: "JavaScript",
  embedded_files: "embedded files",
  launch: "a Launch action",
  openaction: "an OpenAction entry",
  hidden_text: "hidden or near-invisible text",
  pdf_unreadable: "an unreadable PDF",
  path_traversal: "a path that escapes the archive",
  symlink: "a symbolic link",
  absolute_path: "an absolute path",
  malware: "malware",
  av_unavailable: "a malware scan that could not run (the antivirus is unavailable)",
  bundle_unreadable: "an archive that could not be read",
  file_missing: "a file missing from this node",
  file_unreadable: "a file that could not be read",
  manifest_unreadable: "a manifest that could not be read",
};

/** Plain words for a scanner check name. Unknown names are humanised, not hidden. */
export function describeFailedCheck(name: string): string {
  return FAILED_CHECK_WORDS[name] ?? name.replace(/[_-]+/g, " ");
}

function joinWords(words: readonly string[]): string {
  if (words.length === 0) {
    return "";
  }
  if (words.length === 1) {
    return words[0];
  }
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** `paper.pdf failed the safety scan: JavaScript and embedded files.` */
export function fileProblem(file: FileSafety): string {
  if (file.failedChecks.length === 0) {
    return `${file.path} did not pass the safety scan.`;
  }
  return `${file.path} failed the safety scan: ${joinWords(file.failedChecks.map(describeFailedCheck))}.`;
}

/** How many references were confirmed, or `null` while the check has not run. */
export function referencesResolved(total: number | null, unresolved: number | null): number | null {
  if (total === null || unresolved === null) {
    return null;
  }
  return Math.max(0, total - unresolved);
}

/** `7.4%` / `12%`: at most one decimal, no trailing `.0`. */
export function formatPercent(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** Whitespace-collapsed text, cut short so a page of prose cannot swamp the row. */
function excerpt(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function fileItems(
  files: readonly FileSafety[],
): { state: CheckState; label: string; summary: string; detail: string; fix: CheckFix | null } {
  if (files.length === 0) {
    return {
      state: "pending",
      label: "Not run yet",
      summary: "No files listed yet",
      detail: "The version's manifest lists the files to scan. Results appear here once it exists.",
      fix: null,
    };
  }

  const failed = files.filter((file) => file.status === "failed");
  const scanning = files.filter((file) => file.status === "scanning");
  const unscanned = files.filter((file) => file.status === "pending");

  if (failed.length > 0) {
    const names = failed.map((file) => file.path);
    return {
      state: "attention",
      label: "Needs fixing",
      summary:
        failed.length === files.length
          ? `${files.length === 1 ? "The file" : "All " + files.length + " files"} failed the safety scan`
          : `${failed.length} of ${files.length} files failed the safety scan`,
      detail: `${joinWords(names)}. Replace ${failed.length === 1 ? "it" : "them"} in Files, then run the checks again.`,
      fix: "files",
    };
  }

  if (scanning.length > 0) {
    return {
      state: "running",
      label: "Scanning",
      summary: `Scanning ${scanning.length} of ${files.length} ${files.length === 1 ? "file" : "files"}…`,
      detail: "Results appear here as each file finishes.",
      fix: null,
    };
  }

  if (unscanned.length > 0) {
    return {
      state: "pending",
      label: "Not run yet",
      summary: `${unscanned.length} of ${files.length} ${files.length === 1 ? "file has" : "files have"} not been scanned yet`,
      detail: "Scanning starts once the version is signed and every co-author has consented.",
      fix: null,
    };
  }

  return {
    state: "passed",
    label: "Passed",
    summary:
      files.length === 1
        ? "The file passed the safety scan"
        : `All ${files.length} files passed the safety scan`,
    detail:
      "PDFs are checked for JavaScript, embedded files, Launch and OpenAction entries, and hidden text; archives for unsafe paths, symbolic links and malware.",
    fix: null,
  };
}

function referenceItems(
  total: number | null,
  unresolved: number | null,
): { state: CheckState; label: string; summary: string; detail: string } {
  if (total === null || unresolved === null) {
    return {
      state: "pending",
      label: "Not run yet",
      summary: "The reference check has not run yet",
      detail: "It reads the reference list from the PDF's text and confirms each DOI through Crossref.",
    };
  }

  if (total === 0) {
    return {
      state: "passed",
      label: "Nothing to resolve",
      summary: "No reference list found",
      detail: "The extracted text has no recognisable reference list, so nothing needed resolving.",
    };
  }

  const resolved = referencesResolved(total, unresolved) ?? 0;
  if (unresolved === 0) {
    return {
      state: "passed",
      label: "Resolved",
      summary: `${total} of ${total} references resolved`,
      detail: "Every entry with a DOI was confirmed through Crossref.",
    };
  }

  const offNote = resolved === 0 ? " This node may have Crossref lookup switched off." : "";
  return {
    state: "attention",
    label: "Unresolved",
    summary: `${resolved} of ${total} references resolved`,
    detail:
      `${unresolved} could not be confirmed: the entry has no DOI, or Crossref did not know it.` +
      `${offNote} Unresolved references do not stop submission.`,
  };
}

function similarityItems(pct: number | null): {
  state: CheckState;
  label: string;
  summary: string;
  detail: string;
} {
  if (pct === null) {
    return {
      state: "pending",
      label: "Not run yet",
      summary: "Similarity has not been measured yet",
      detail: "It compares the version's text with every listed paper once the text has been extracted.",
    };
  }
  if (pct < SIMILARITY_NOTICE_PCT) {
    return {
      state: "passed",
      label: pct === 0 ? "No overlap" : "Low overlap",
      summary: pct === 0 ? "No overlap found" : `Low overlap: ${formatPercent(pct)}`,
      detail: "The share of five-word sequences also found in the most similar listed paper.",
    };
  }
  return {
    state: "attention",
    label: "Worth a look",
    summary: `${pct >= SIMILARITY_HIGH_PCT ? "High" : "Some"} overlap: ${formatPercent(pct)}`,
    detail:
      "Check that quotations and prior work are cited. Similarity is a signal for moderators, not a verdict.",
  };
}

function metadataItems(
  match: boolean | null,
  signedTitle: string | null,
  firstPageTitle: string | null,
): { state: CheckState; label: string; summary: string; detail: string; fix: CheckFix | null } {
  if (match === null) {
    return {
      state: "pending",
      label: "Not run yet",
      summary: "The metadata check has not run yet",
      detail: "It looks for the title in Details in the text of the PDF's first page.",
      fix: null,
    };
  }
  if (match) {
    return {
      state: "passed",
      label: "Matched",
      summary: "Title found on page 1",
      detail: "The title in Details appears in the text of the PDF's first page.",
      fix: null,
    };
  }
  return {
    state: "attention",
    label: "Needs fixing",
    summary: "Title not found on page 1",
    detail:
      `The signed title${signedTitle === null ? "" : ` ("${signedTitle}")`} does not appear in the text of page 1.` +
      `${firstPageTitle === null ? "" : ` Page 1 begins: "${excerpt(firstPageTitle)}".`}` +
      " Edit the title or replace the PDF, then run the checks again.",
    fix: "details",
  };
}

/** The line for a check that never ran because the safety scan held the version. */
const HELD_AT_SCAN = "Not run: the version was held at the safety scan";

const HELD_AT_SCAN_DETAILS = {
  references: "The reference check runs once the safety scan passes.",
  similarity: "Similarity is measured once the safety scan passes.",
  metadata: "The metadata check runs once the safety scan passes.",
} as const;

/** A check the safety scan stopped before it could run; it is not waiting to run. */
function heldAtScanRow(id: keyof typeof HELD_AT_SCAN_DETAILS): {
  state: CheckState;
  label: string;
  summary: string;
  detail: string;
} {
  return {
    state: "pending",
    label: "Not run",
    summary: HELD_AT_SCAN,
    detail: HELD_AT_SCAN_DETAILS[id],
  };
}

/**
 * The four rows of step 4.
 *
 * `report` is `null` before the version exists; `draftFiles` then names the
 * files that will be scanned, so the step still shows what it is waiting for.
 * With a report, the report's own file list decides — it is what the node
 * signed and scanned. A report whose `checksRan` is false (the safety scan
 * held the version) keeps the file verdict but says the advisory checks did
 * not run, rather than that they are pending.
 */
export function checkItems(report: VersionChecks | null, draftFiles: readonly DraftCheckFile[] = []): CheckItem[] {
  const files =
    report !== null
      ? report.files
      : draftFiles.map<FileSafety>((file) => ({
          path: file.path,
          cid: file.cid ?? "",
          role: file.role ?? null,
          status: "pending",
          failedChecks: [],
          detail: null,
        }));
  const filesRow = fileItems(files);
  // The advisory checks run only after a clean scan. When the scan held the
  // version they never ran, so they say so instead of "Not run yet".
  const ran = report?.checksRan !== false;
  const referencesRow = ran
    ? referenceItems(report?.referencesTotal ?? null, report?.referencesUnresolved ?? null)
    : heldAtScanRow("references");
  const similarityRow = ran
    ? similarityItems(report?.similarityPct ?? null)
    : heldAtScanRow("similarity");
  const metadataRow = ran
    ? metadataItems(
        report?.metadataMatch ?? null,
        report?.signedTitle ?? null,
        report?.firstPageTitle ?? null,
      )
    : { ...heldAtScanRow("metadata"), fix: null };

  return [
    { id: "files", title: CHECK_TITLES.files, ...filesRow },
    { id: "references", title: CHECK_TITLES.references, fix: null, ...referencesRow },
    { id: "similarity", title: CHECK_TITLES.similarity, fix: null, ...similarityRow },
    {
      id: "metadata",
      title: CHECK_TITLES.metadata,
      fix: metadataRow.fix,
      state: metadataRow.state,
      label: metadataRow.label,
      summary: metadataRow.summary,
      detail: metadataRow.detail,
    },
  ];
}

/**
 * Whether every check has a final verdict.
 *
 * File safety is final when every listed file is passed or failed. A version
 * text with no files can still be final once the node has moved it past
 * scanning (`moderation`, `held`, …) — its result then lives in the version's
 * state, not in a per-file row this response carries.
 */
export function checksFinished(report: VersionChecks | null): boolean {
  if (report === null) {
    return false;
  }
  const filesFinal =
    report.files.length > 0
      ? report.files.every((file) => file.status === "passed" || file.status === "failed")
      : ["moderation", "listed", "held", "rejected"].includes(report.state);
  return (
    filesFinal &&
    report.referencesTotal !== null &&
    report.referencesUnresolved !== null &&
    report.similarityPct !== null &&
    report.metadataMatch !== null
  );
}

/** Whether the node is still scanning this version, so the step should poll. */
export function checksAreRunning(report: VersionChecks | null): boolean {
  if (report === null) {
    return false;
  }
  return report.state === "scanning" || report.files.some((file) => file.status === "scanning");
}

/** The sentence to show while the checks are not finished. */
export function checksPendingReason(report: VersionChecks | null): string {
  if (report === null) {
    return "Checks have not run yet. They start when the version is signed.";
  }
  if (report.state === "awaiting_consent") {
    return "Checks start once every co-author has consented.";
  }
  if (report.state === "draft") {
    return "Checks run once the version is signed and every co-author has consented.";
  }
  return "Checks are still running. This page updates by itself.";
}

/**
 * What still stops the author continuing to Sign, most important first.
 *
 * A failed file safety check and a title that is not on page 1 are both
 * fixable in place, so they block. Unresolved references and similarity do
 * not: they are signals, and the design says nothing is hidden from the
 * author, not that every signal is an error.
 */
export function checksBlockers(report: VersionChecks | null): string[] {
  if (report === null) {
    return [checksPendingReason(null)];
  }

  const blockers: string[] = [];
  const failed = report.files.filter((file) => file.status === "failed");
  if (failed.length > 0) {
    const first = failed[0];
    const rest = failed.length > 1 ? ` and ${failed.length - 1} more file${failed.length === 2 ? "" : "s"}` : "";
    blockers.push(`${fileProblem(first)} Replace it${rest} in Files, then run the checks again.`);
  }
  if (report.metadataMatch === false) {
    blockers.push("Your title does not appear on page 1 of the PDF. Edit the title or replace the PDF.");
  }
  if (!checksFinished(report)) {
    blockers.push(checksPendingReason(report));
  }
  return blockers;
}

/** Non-blocking notes: signals the author should know about but need not fix. */
export function checksWarnings(report: VersionChecks | null): string[] {
  if (report === null) {
    return [];
  }
  const warnings: string[] = [];
  if (report.referencesTotal !== null && report.referencesUnresolved !== null && report.referencesUnresolved > 0) {
    warnings.push("Unresolved references do not stop submission; they are shown to you and to moderators.");
  }
  if (report.similarityPct !== null && report.similarityPct >= SIMILARITY_NOTICE_PCT) {
    warnings.push("Similarity is one signal among several. It is never a verdict on its own.");
  }
  return warnings;
}

/** A polite one-line summary of the four rows, for the step's live region. */
export function checksSummary(items: readonly CheckItem[]): string {
  if (items.every((item) => item.state === "pending")) {
    return "No check results yet.";
  }
  // A scan hold is a verdict, not a wait: the failed file is the result and the
  // other checks will never run, so neither "N passed" nor "not run yet" fits.
  const advisory = items.filter((item) => item.id !== "files");
  if (
    advisory.length > 0 &&
    advisory.every((item) => item.summary === HELD_AT_SCAN) &&
    items.some((item) => item.id === "files" && item.state === "attention")
  ) {
    return "A file failed the safety scan; the other checks did not run.";
  }
  const passed = items.filter((item) => item.state === "passed").length;
  const attention = items.filter((item) => item.state === "attention").length;
  const running = items.filter((item) => item.state === "running").length;
  const pending = items.filter((item) => item.state === "pending").length;
  if (running > 0) {
    return `${passed} of ${items.length} checks passed. Still running.`;
  }
  if (pending > 0) {
    return `${passed} of ${items.length} checks passed, ${pending} not run yet.`;
  }
  if (attention > 0) {
    return `${passed} of ${items.length} checks passed, ${attention} to fix or look at.`;
  }
  return `All ${items.length} checks passed.`;
}

/** A sentence for the author when the last request for a report failed. */
export function checksErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This node does not have that version yet, so it has no check results.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "This node will not show these check results to you.";
  }
  return "Could not check this version. Trying again shortly.";
}

// ---------------------------------------------------------------------------
// Reading the wire response
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(record: Json, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolOf(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "match", "matched", "passed", "pass", "yes"].includes(text)) {
      return true;
    }
    if (["false", "mismatch", "unmatched", "failed", "fail", "no"].includes(text)) {
      return false;
    }
  }
  return null;
}

function scanStatusOf(value: unknown): FileScanStatus {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["passed", "pass", "clean", "ok", "safe"].includes(text)) {
    return "passed";
  }
  if (["failed", "fail", "blocked", "rejected", "unsafe"].includes(text)) {
    return "failed";
  }
  if (["scanning", "running", "in_progress", "in-progress", "pending_scan"].includes(text)) {
    return "scanning";
  }
  return "pending";
}

const FILE_PATHS = ["path", "name", "filePath", "file_path"] as const;
const FILE_CIDS = ["cid", "fileCid", "file_cid", "contentCid", "content_cid"] as const;
const SCAN_KEYS = ["scan", "scanStatus", "scan_status", "safety", "status", "result"] as const;
const CHECK_LIST_KEYS = [
  "checks",
  "failedChecks",
  "failed_checks",
  "checkNames",
  "check_names",
  "findings",
] as const;

function normalizeFile(raw: unknown): FileSafety | null {
  if (!isRecord(raw)) {
    return null;
  }
  const nested = isRecord(raw.file) ? raw.file : null;
  const path =
    stringOf(firstDefined(raw, FILE_PATHS)) ??
    (nested === null ? null : stringOf(firstDefined(nested, FILE_PATHS)));
  if (path === null) {
    return null;
  }
  const cid =
    stringOf(firstDefined(raw, FILE_CIDS)) ??
    (nested === null ? null : stringOf(firstDefined(nested, FILE_CIDS))) ??
    "";
  const role = stringOf(raw.role) ?? (nested === null ? null : stringOf(nested.role));

  const scanRaw = firstDefined(raw, SCAN_KEYS);
  const scanRecord = isRecord(scanRaw) ? scanRaw : null;
  let status = scanStatusOf(
    scanRecord === null
      ? scanRaw
      : firstDefined(scanRecord, ["result", "status", "scanStatus", "scan_status"]),
  );

  const failedChecks: string[] = [];
  const checksRaw = firstDefined(raw, CHECK_LIST_KEYS);
  if (Array.isArray(checksRaw)) {
    for (const entry of checksRaw) {
      if (typeof entry === "string") {
        failedChecks.push(entry);
      } else if (isRecord(entry)) {
        const name = stringOf(firstDefined(entry, ["name", "checkName", "check_name", "check", "id"]));
        const resultRaw = firstDefined(entry, ["result", "status", "scanStatus", "scan_status"]);
        // A named check is failing when it says so, or when the list carries
        // names only (a "failedChecks" list); a passed one is not a failure.
        const failed = resultRaw === undefined || scanStatusOf(resultRaw) === "failed";
        if (name !== null && failed) {
          failedChecks.push(name);
        }
      }
    }
  } else if (typeof checksRaw === "string") {
    failedChecks.push(checksRaw);
  }
  const uniqueChecks = [...new Set(failedChecks)];
  if (uniqueChecks.length > 0) {
    status = "failed";
  }

  const detail =
    stringOf(raw.detail) ??
    stringOf(raw.message) ??
    (scanRecord === null ? null : stringOf(firstDefined(scanRecord, ["detail", "message"])));

  return { path, cid, role, status, failedChecks: uniqueChecks, detail };
}

function normalizeFiles(payload: Json): FileSafety[] {
  const raw = firstDefined(payload, ["files", "fileSafety", "file_safety", "scans"]);
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.files)
      ? raw.files
      : [];
  return list.map(normalizeFile).filter((file): file is FileSafety => file !== null);
}

/**
 * Turn a node response into {@link VersionChecks}.
 *
 * Accepts the natural nested form:
 *
 * ```json
 * {
 *   "paper": "sch:xxxx-xxxx-xxxx", "version": 1, "versionCid": "bafyrei…",
 *   "state": "scanning",
 *   "files": [{"path": "paper.pdf", "cid": "bafkrei…", "role": "pdf",
 *              "scan": "failed", "checks": ["javascript"], "detail": "…"}],
 *   "references": {"total": 42, "unresolved": 3},
 *   "similarity": {"pct": 7.4},
 *   "metadata": {"match": true, "signedTitle": "…"},
 *   "checkedAt": "2026-11-15T12:00:00Z"
 * }
 * ```
 *
 * and the flat spellings of the `check_results` columns
 * (`similarity_pct`, `references_total`, `references_unresolved`,
 * `metadata_match`, `scan_status`, …).
 *
 * Raises:
 *   Error: if the response is not a JSON object, so a proxy page or an HTML
 *   error is reported as a failed check request rather than an empty report.
 */
export function normalizeVersionChecks(payload: unknown, ref: ChecksVersionRef): VersionChecks {
  if (!isRecord(payload)) {
    throw new Error("The node's check report was not an object.");
  }

  const referencesRaw = isRecord(firstDefined(payload, ["references", "referenceCheck", "reference_check"]))
    ? (firstDefined(payload, ["references", "referenceCheck", "reference_check"]) as Json)
    : null;
  const referencesTotal =
    numberOf(
      referencesRaw === null
        ? undefined
        : firstDefined(referencesRaw, [
            "total",
            "count",
            "referencesTotal",
            "references_total",
            "totalReferences",
          ]),
    ) ?? numberOf(firstDefined(payload, ["referencesTotal", "references_total", "referenceTotal"]));
  const referencesUnresolved =
    numberOf(
      referencesRaw === null
        ? undefined
        : firstDefined(referencesRaw, [
            "unresolved",
            "referencesUnresolved",
            "references_unresolved",
            "unresolvedReferences",
          ]),
    ) ?? numberOf(firstDefined(payload, ["referencesUnresolved", "references_unresolved", "unresolvedReferences"]));

  const similarityRaw = isRecord(firstDefined(payload, ["similarity", "similarityCheck", "similarity_check"]))
    ? (firstDefined(payload, ["similarity", "similarityCheck", "similarity_check"]) as Json)
    : null;
  let similarityPct =
    numberOf(
      similarityRaw === null
        ? undefined
        : firstDefined(similarityRaw, ["pct", "percent", "similarityPct", "similarity_pct", "value"]),
    ) ?? numberOf(firstDefined(payload, ["similarityPct", "similarity_pct", "similarityPercent"]));
  if (similarityPct !== null) {
    similarityPct = Math.min(100, Math.max(0, similarityPct));
  }

  const metadataRaw = isRecord(firstDefined(payload, ["metadata", "metadataCheck", "metadata_check"]))
    ? (firstDefined(payload, ["metadata", "metadataCheck", "metadata_check"]) as Json)
    : null;
  const metadataMatch =
    (metadataRaw === null
      ? null
      : boolOf(firstDefined(metadataRaw, ["match", "matches", "matched", "result", "status"]))) ??
    boolOf(firstDefined(payload, ["metadataMatch", "metadata_match"]));
  const signedTitle =
    (metadataRaw === null
      ? null
      : stringOf(firstDefined(metadataRaw, ["signedTitle", "signed_title", "title"]))) ??
    stringOf(firstDefined(payload, ["signedTitle", "signed_title"]));
  const firstPageTitle =
    (metadataRaw === null
      ? null
      : stringOf(firstDefined(metadataRaw, ["firstPageTitle", "first_page_title", "pageTitle"]))) ??
    stringOf(firstDefined(payload, ["firstPageTitle", "first_page_title"]));

  return {
    paper: stringOf(firstDefined(payload, ["paper", "paperId", "paper_id", "id"])) ?? ref.paper,
    version: numberOf(firstDefined(payload, ["version", "n", "versionNumber"])) ?? ref.version,
    versionCid: stringOf(firstDefined(payload, ["versionCid", "version_cid", "cid"])) ?? "",
    state: stringOf(firstDefined(payload, ["state", "status"])) ?? "",
    files: normalizeFiles(payload),
    referencesTotal,
    referencesUnresolved,
    similarityPct,
    metadataMatch,
    signedTitle,
    firstPageTitle,
    checkedAt:
      stringOf(firstDefined(payload, ["checkedAt", "checked_at", "updatedAt", "updated_at"])) ?? null,
    // A node that does not say ran the advisory checks; only a held version's
    // report says otherwise.
    checksRan: boolOf(firstDefined(payload, ["checksRan", "checks_ran"])) ?? true,
  };
}
