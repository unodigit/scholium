/**
 * Run one proof check: load a paper's records, verify them with verify-core in
 * this browser, compare the files, read the ledger proof, and fold the answers
 * into the plain-language checklist.
 *
 * It mirrors `scholium verify` step for step (`scholium_cli.verify`): the same
 * `verifyPaper` call with the same `paper` / `head` / `authorities`, and the
 * same rule for what makes the verdict negative (see `checklist.ts`). What the
 * browser adds is a third answer. When the proof cannot be *obtained* (offline,
 * the node has no such paper, it sends no signatures) the outcome is
 * `cannot_verify`: not a failure, and never styled as one (docs/design.md
 * §5.3). Only evidence that a record, a link or a file does not match makes it
 * `failed`.
 *
 * `runProofCheck` never rejects for a failed check or an unreachable node; it
 * rejects only when `signal` is aborted, so a caller that unmounts mid-check
 * can drop the result.
 *
 * Pure orchestration, no React.
 */

import { resolveApiBaseUrl } from "../../lib/api";
import {
  GENESIS_TYPE,
  VERSION_TYPE,
  deriveShortId,
  formatVersionId,
  verifyPaper,
  type VerificationReport,
} from "../verify-core";
import { PENDING_PROOF, type RecordProofInfo } from "./anchor";
import {
  buildChecklist,
  checkLines,
  offlineCommand,
  technicalRows,
  verdictCopy,
  verdictState,
  type ChecklistItem,
  type CheckLine,
  type TechnicalRow,
  type VerdictState,
} from "./checklist";
import { compareFiles, versionManifest, type FileResult } from "./files";
import type { PaperRef } from "./paper-ref";
import {
  ProofUnavailableError,
  createNodeProofSource,
  describeProofError,
  type ProofSource,
  type SignedRecord,
} from "./source";

/** Everything the Proof tab shows for a finished check. */
export interface ProofOutcome {
  readonly state: VerdictState;
  /** The sentence beside the state's icon. */
  readonly headline: string;
  /** One line under it; for `cannot_verify`, the reason. */
  readonly summary: string;
  /** The five plain lines; empty when nothing could be checked. */
  readonly items: readonly ChecklistItem[];
  /** Record ids, anchor and signers. */
  readonly rows: readonly TechnicalRow[];
  /** verify-core's six checks, as `scholium verify --verbose` prints them. */
  readonly checks: readonly CheckLine[];
  /** The command that repeats this check outside the browser. */
  readonly command: string;
  /** The version that was checked, `sch:xxxx-xxxx-xxxx/vN` when known. */
  readonly schId: string;
  /** verify-core's full report; `null` when nothing could be checked. */
  readonly report: VerificationReport | null;
}

export interface ProofCheckOptions {
  readonly ref: PaperRef;
  /** Defaults to the node's public read API. */
  readonly source?: ProofSource;
  /** `did:key`s trusted to retract, correct or tombstone any paper (CLI `--authority`). */
  readonly authorities?: readonly string[];
  /** Node origin shown in the offline command. Defaults to the API base URL. */
  readonly nodeUrl?: string;
  /** Most bytes of files to download for the comparison. */
  readonly maxDownloadBytes?: number;
  readonly signal?: AbortSignal;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(record: SignedRecord): Record<string, unknown> {
  return isMapping(record.body) ? record.body : {};
}

function shortIdOf(genesisId: unknown): string | null {
  if (typeof genesisId !== "string") return null;
  try {
    return deriveShortId(genesisId);
  } catch {
    return null;
  }
}

/** The paper a genesis or version record belongs to, as a short id. */
function paperOf(record: SignedRecord): string | null {
  if (record.type === GENESIS_TYPE) return shortIdOf(record.id);
  if (record.type === VERSION_TYPE) return shortIdOf(bodyOf(record).paper);
  return null;
}

/**
 * Why `records` hold nothing to check for `ref`, or `null` when they do.
 *
 * Asking verify-core about a paper or version the node simply does not have
 * would answer "invalid", and an invalid verdict tells the reader not to rely
 * on the paper. A mistyped id or an incomplete node is not that: it is a proof
 * that is not available.
 */
function missingTarget(records: readonly SignedRecord[], ref: PaperRef): string | null {
  const mine = records.filter((record) => paperOf(record) === ref.shortId);
  if (mine.length === 0) return `The node has no records for ${ref.shortId}.`;
  if (
    ref.version !== null &&
    !mine.some((record) => record.type === VERSION_TYPE && bodyOf(record).n === ref.version)
  ) {
    return `The node has no version ${ref.version} of ${ref.shortId}.`;
  }
  return null;
}

/** `sch:xxxx-xxxx-xxxx/vN` of the version a report verified, like the CLI's `Paper:` line. */
function versionLabel(
  records: readonly SignedRecord[],
  report: VerificationReport,
  ref: PaperRef,
): string {
  const head = records.find((record) => record.id === report.head);
  const n = head === undefined ? undefined : bodyOf(head).n;
  if (report.short_id !== null && typeof n === "number") {
    try {
      return formatVersionId(report.short_id, n);
    } catch {
      // fall through to what was asked for
    }
  }
  return ref.schId;
}

function cannotVerify(reason: string, ref: PaperRef, nodeUrl: string): ProofOutcome {
  const copy = verdictCopy("cannot_verify");
  return {
    state: "cannot_verify",
    headline: copy.headline,
    // The reason is specific; the closing sentence is the design's promise
    // that a check that could not run is not a verdict (§5.3).
    summary: `${reason} This is not a failure.`,
    items: [],
    rows: [],
    checks: [],
    command: offlineCommand(ref.schId, nodeUrl),
    schId: ref.schId,
    report: null,
  };
}

/** A check that ran: the checklist, the verdict and the technical details. */
async function checkRecords(
  records: readonly SignedRecord[],
  options: ProofCheckOptions,
  source: ProofSource,
  nodeUrl: string,
): Promise<ProofOutcome> {
  const { ref, signal } = options;
  const report = verifyPaper(records, {
    paper: ref.shortId,
    head: ref.version === null ? undefined : ref.schId,
    authorities: [...(options.authorities ?? [])],
  });

  const manifest = versionManifest(records, report);
  // A paper that already failed is not worth downloading files for: the
  // verdict cannot change, and the files line says they were not compared.
  let fileResults: FileResult[] = [];
  if (manifest !== null && report.checks.manifests.passed && report.valid) {
    fileResults = await compareFiles(manifest.files, source.loadFile, {
      maxDownloadBytes: options.maxDownloadBytes,
      signal,
    });
  }

  // Best effort, like the CLI: the records are already in hand, so a node that
  // cannot answer for the proof leaves the timestamp pending, not the paper
  // unchecked.
  let proof: RecordProofInfo = PENDING_PROOF;
  if (report.valid && report.head !== null && source.loadRecordProof !== undefined) {
    try {
      proof = await source.loadRecordProof(report.head, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  const items = buildChecklist({ report, manifest, fileResults, proof });
  const state = verdictState(items, report, proof);
  const schId = versionLabel(records, report, ref);
  return {
    ...verdictCopy(state),
    state,
    items,
    rows: technicalRows({ report, manifest, proof }),
    checks: checkLines(report),
    command: offlineCommand(schId, nodeUrl),
    schId,
    report,
  };
}

/**
 * Check `options.ref` and say what the tab should show.
 *
 * @throws only if `options.signal` aborts.
 */
export async function runProofCheck(options: ProofCheckOptions): Promise<ProofOutcome> {
  const { ref, signal } = options;
  const source = options.source ?? createNodeProofSource();
  const nodeUrl = options.nodeUrl ?? resolveApiBaseUrl();

  try {
    const records = await source.loadRecords(ref, signal);
    const missing = missingTarget(records, ref);
    if (missing !== null) throw new ProofUnavailableError(missing);
    return await checkRecords(records, options, source, nodeUrl);
  } catch (error) {
    if (signal?.aborted) throw error;
    return cannotVerify(describeProofError(error), ref, nodeUrl);
  }
}
