/**
 * The plain-language checklist of the Proof tab (docs/design.md §5.3), and the
 * verdict it adds up to.
 *
 * verify-core answers six technical questions (`chain`, `signatures`,
 * `prev_hashes`, `consents`, `manifests`, `supersession`). A reader wants
 * plain ones, the same ones `scholium verify` prints
 * (`apps/api/packages/cli/src/scholium_cli/checklist.py`), and the rules that
 * fold the six into them are that file's, line for line:
 *
 * | Line                 | From                                  |
 * | -------------------- | ------------------------------------- |
 * | Signed by all authors | `signatures` + `consents`            |
 * | History intact        | `chain` + `prev_hashes`              |
 * | Files match           | `manifests` + the files themselves   |
 * | In the node's log     | the node's proof (never the browser) |
 * | Timestamp / anchor    | the node's proof (never the browser) |
 * | No retraction         | `supersession`                       |
 * | Preserved             | `GET /v1/network` (the node's words) |
 *
 * That shared rule is what lets the in-browser indicator and the CLI agree
 * (PRD: "indicator result equals CLI verifier result"): both fail on exactly
 * the same failed checks. A line is a pass, a fail, *pending* (a state, not an
 * error) or a *warning* (verified, but the reader should know). Only fails
 * make the verdict negative: a retracted paper's history still verifies, so a
 * retraction is a warning, not a failure. The notice lines name people and
 * records in words; the raw record ids and did:key:s they used to print live
 * in the technical details (bug_spec_verify4 bug 4).
 *
 * Pure data and functions, no React.
 */

import {
  VERIFY_BADGE_SPECS,
  countedLabel,
  type VerifyCounts,
  type VerifyState,
} from "../ui-kit/verify";
import type { CheckResult, VerificationReport } from "../verify-core";
import { formatAnchorTime, type RecordProofInfo } from "./anchor";
import type { FileResult, VersionManifest } from "./files";
import { NETWORK_PAGE_HREF, preservationCopy, type PreservationInfo } from "./preservation";

export type ItemState = "pass" | "fail" | "pending" | "warn";

export type ItemKey =
  | "authors"
  | "history"
  | "files"
  | "ledger"
  | "anchor"
  | "retraction"
  | "preservation";

export interface ChecklistItem {
  readonly key: ItemKey;
  readonly state: ItemState;
  /** One plain sentence. */
  readonly text: string;
  /** Individual findings, shown under a fail or a warning. */
  readonly details: readonly string[];
  /**
   * A follow-up link: an `https:` URL (the anchor transaction) opens in a new
   * tab, a path (`/network`) opens in this one.
   */
  readonly link: { readonly href: string; readonly label: string } | null;
}

/** The verdict states a finished check can end in ("checking" is not a verdict). */
export type VerdictState = Exclude<VerifyState, "checking">;

/** The record-core wording names Python arguments; the reader has no such options. */
const ARGUMENT_WORDING = /\b(paper|head)=/g;

/** Same rewrite the CLI applies, so details read identically in both. */
export function cliWording(text: string): string {
  return text.replace(ARGUMENT_WORDING, "--$1 ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function item(
  key: ItemKey,
  state: ItemState,
  text: string,
  details: readonly string[] = [],
  link: ChecklistItem["link"] = null,
): ChecklistItem {
  return { key, state, text, details, link };
}

// --- items built from verify-core's checks -------------------------------

/** What a failed check says in words a reader can act on. */
const FAIL_TEXT: Readonly<Record<string, string>> = {
  signatures: "A record was altered, or its signature does not match its author",
  consents: "Not every listed author has signed",
  chain: "The version history is broken",
  prev_hashes: "An earlier version was changed after a later one was signed",
  manifests: "The signed list of files is missing or invalid",
  supersession: "A retraction or correction on record is not genuine",
};

const NOT_CHECKED_TEXT = "Not checked, because the version history is broken";

/**
 * A line decided by one or more checks: `pass` when all passed, else a `fail`
 * naming the first failing check. A check that was "Not checked" because the
 * history is broken is not itself at fault, so it points at the history line
 * (which carries the cause) rather than repeating it.
 */
function fromChecks(
  key: ItemKey,
  passText: string,
  checks: readonly CheckResult[],
): ChecklistItem {
  const failing = checks.filter((check) => !check.passed);
  if (failing.length === 0) return item(key, "pass", passText);

  const first = failing[0];
  if (first.message.startsWith("Not checked")) {
    return item(key, "fail", NOT_CHECKED_TEXT);
  }
  const details = failing.flatMap((check) =>
    check.details.length > 0 ? [...check.details] : [check.message],
  );
  return item(
    key,
    "fail",
    FAIL_TEXT[first.name] ?? cliWording(first.message),
    [...new Set(details.map(cliWording))],
  );
}

function authorsItem(report: VerificationReport): ChecklistItem {
  const { signatures, consents } = report.checks;
  const count = report.authors.length;
  const text =
    count === 0
      ? consents.message
      : count === 1
        ? "Signed by the listed author"
        : `Signed by all ${count} listed authors`;
  return fromChecks("authors", text, [signatures, consents]);
}

function historyItem(report: VerificationReport): ChecklistItem {
  const { chain, prev_hashes: prevHashes } = report.checks;
  return fromChecks("history", chain.message, [chain, prevHashes]);
}

// --- the notices line -----------------------------------------------------

/** The notice kinds verify-core reports, as a reader says them. */
const NOTICE_KIND_WORDS: Readonly<Record<string, string>> = {
  retraction: "Retraction",
  correction: "Correction",
  tombstone: "Tombstone",
};

/** "retraction" → "Retraction"; an unknown kind keeps its own word, capitalised. */
export function noticeKindWord(kind: string): string {
  const known = NOTICE_KIND_WORDS[kind];
  if (known !== undefined) return known;
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Who signed a notice, in words. The primary list names people and records in
 * words (bug_spec_verify4 bug 4); the raw record id and did:key are printed by
 * the technical details instead (`technicalRows`).
 */
function noticeSignerWord(
  notice: { author: string | null; applied: boolean },
  report: VerificationReport,
): string {
  if (notice.author !== null && report.authors.includes(notice.author)) {
    return "a listed author";
  }
  // verify-core applies a notice only when its signer is a listed author or a
  // trusted authority, so an applied outside signer is necessarily trusted.
  return notice.applied ? "a trusted authority" : "an unrecognised signer";
}

/** One notice as a reader reads it: what, by whom, and whether it applies. */
function noticeDetail(
  notice: {
    kind: string;
    author: string | null;
    applied: boolean;
    reason: string | null;
  },
  report: VerificationReport,
): string {
  const applied = notice.applied ? "applies" : `not applied: ${notice.reason}`;
  return `${noticeKindWord(notice.kind)} notice signed by ${noticeSignerWord(notice, report)} (${applied})`;
}

function retractionItem(report: VerificationReport): ChecklistItem {
  const check = report.checks.supersession;
  if (!check.passed) return fromChecks("retraction", "", [check]);

  const notices = report.supersessions.map((notice) => noticeDetail(notice, report));
  switch (report.status) {
    case "retracted":
      return item(
        "retraction",
        "warn",
        "Retracted: a retraction notice applies. The signed history still verifies.",
        notices,
      );
    case "tombstoned":
      return item(
        "retraction",
        "warn",
        "Content removed: a trusted authority tombstoned it. The signed record remains.",
        notices,
      );
    case "corrected":
      return item(
        "retraction",
        "warn",
        "Corrected: a correction notice applies to this paper.",
        notices,
      );
    default:
      return item("retraction", "pass", "No retraction or correction on record", notices);
  }
}

// --- the files line ------------------------------------------------------

/**
 * "Files match what the authors signed", from the manifest check and the
 * comparison of the files themselves (see `files.ts`).
 */
function filesItem(
  report: VerificationReport,
  manifest: VersionManifest | null,
  results: readonly FileResult[],
): ChecklistItem {
  const manifests = report.checks.manifests;
  if (!manifests.passed) return fromChecks("files", "", [manifests]);
  if (manifest === null) {
    // The manifests check passed, so this should not happen.
    return item("files", "fail", "The signed list of files cannot be read");
  }

  const total = manifest.files.length;
  if (total === 0) return item("files", "pass", "The signed list names no files");

  const mismatched = results.filter((result) => result.status === "mismatch");
  const matched = results.filter((result) => result.status === "match").length;
  // Counted, not listed: a file with no result was not compared either, so an
  // empty `results` can never read as "all files match".
  const notCompared = total - matched - mismatched.length;

  if (mismatched.length > 0) {
    return item(
      "files",
      "fail",
      `${mismatched.length} of ${plural(total, "file")} ${
        mismatched.length === 1 ? "does" : "do"
      } not match what the authors signed`,
      mismatched.map((result) => result.detail ?? result.file.path),
    );
  }
  if (notCompared > 0) {
    const findings = results
      .filter((result) => result.status === "skipped")
      .map((result) => result.detail ?? result.file.path);
    return item(
      "files",
      "warn",
      matched === 0
        ? `The signed list of ${plural(total, "file")} is valid, but the files themselves were not compared here`
        : `${matched} of ${plural(total, "file")} match what the authors signed; ${notCompared} could not be compared here`,
      findings,
    );
  }
  return item("files", "pass", `Files match what the authors signed (${plural(total, "file")})`);
}

// --- the ledger and timestamp lines ---------------------------------------

/**
 * The record's place in the node's public log. The records the check verified
 * came from that log, so inclusion is known; only the entry number waits for
 * the node's proof to say it (and it is best effort, like the CLI's).
 */
function ledgerItem(proof: RecordProofInfo): ChecklistItem {
  if (proof.seq !== null) {
    return item("ledger", "pass", `Recorded in the node's public log (entry #${proof.seq})`);
  }
  return item(
    "ledger",
    "pending",
    "Recorded in the node's public log (entry number not reported)",
  );
}

function anchorItem(proof: RecordProofInfo): ChecklistItem {
  const { anchor } = proof;
  if (anchor.status === "anchored") {
    return item(
      "anchor",
      "pass",
      `Timestamp anchored: ${formatAnchorTime(anchor.anchoredAt)}`,
      [],
      anchor.txUrl === null ? null : { href: anchor.txUrl, label: "View transaction" },
    );
  }
  // This node has no anchoring configured, so the line says that instead of
  // promising a time (only the anchored state, above, names a date).
  return item(
    "anchor",
    "pending",
    "Timestamp anchor pending: anchoring is not enabled on this node yet",
  );
}

// --- the preservation line ------------------------------------------------

/**
 * What the node preserves, from its own replication summary, with the way to
 * read it in full (`/network`). A node that did not answer is said, not
 * guessed at — and never as a failure: the paper's proof stands on its own.
 */
function preservationItem(preservation: PreservationInfo | null): ChecklistItem {
  const network = { href: NETWORK_PAGE_HREF, label: "Network details" };
  if (preservation === null) {
    return item(
      "preservation",
      "warn",
      "This node's preservation state could not be read",
      [],
      network,
    );
  }
  const copy = preservationCopy(preservation);
  return item(
    "preservation",
    copy.pending ? "pending" : "pass",
    copy.label,
    copy.note === null ? [] : [copy.note],
    network,
  );
}

// --- the whole checklist -------------------------------------------------

export interface ChecklistInput {
  readonly report: VerificationReport;
  readonly manifest: VersionManifest | null;
  readonly fileResults: readonly FileResult[];
  readonly proof: RecordProofInfo;
  /** The node's replication summary, or `null` when it did not say. */
  readonly preservation: PreservationInfo | null;
}

/**
 * The seven plain lines: the five of docs/design.md §5.3, with the record's
 * place in the node's public log before the anchor that timestamps it, and
 * the node's preservation state last.
 */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { report, manifest, fileResults, proof, preservation } = input;
  return [
    authorsItem(report),
    historyItem(report),
    filesItem(report, manifest, fileResults),
    ledgerItem(proof),
    anchorItem(proof),
    retractionItem(report),
    preservationItem(preservation),
  ];
}

/**
 * The state of the header indicator for a finished check.
 *
 * Failed when any line failed (exactly the CLI's non-zero exit); otherwise
 * Verified once the timestamp is anchored and "Signed · anchor pending" until
 * then. Warnings (a retraction, files not compared) do not change it: the
 * signatures and hashes are good, and the line says what the reader should
 * know.
 */
export function verdictState(
  items: readonly ChecklistItem[],
  report: VerificationReport,
  proof: RecordProofInfo,
): VerdictState {
  if (!report.valid || items.some((entry) => entry.state === "fail")) return "failed";
  return proof.anchor.status === "anchored" ? "verified" : "anchor_pending";
}

// --- words for each state ------------------------------------------------

export interface VerdictCopy {
  /** The sentence beside the state's icon. */
  readonly headline: string;
  /** One line under it. */
  readonly summary: string;
}

/**
 * Headline and summary for each state. For a check that passed, the headline
 * carries the PRD's counts ("Verified · 3 versions · 4 signatures") and the
 * anchor state follows as the summary, so a signed-but-not-anchored paper says
 * so instead of promising a time. The words otherwise come from the
 * VerifyBadge's own table (docs/design.md §5.3) so the badge in the paper
 * header and this tab always agree.
 */
export function verdictCopy(state: VerifyState, counts: VerifyCounts | null = null): VerdictCopy {
  const spec = VERIFY_BADGE_SPECS[state];
  switch (state) {
    case "verified":
    case "anchor_pending":
      return { headline: countedLabel(state, counts), summary: spec.meaning };
    case "checking":
      return { headline: "Checking in your browser…", summary: spec.meaning };
    default:
      return { headline: spec.label, summary: spec.meaning };
  }
}

// --- technical details ---------------------------------------------------

/**
 * One labelled value in "Technical details".
 *
 * An `id` (a record id or a signer's did:key) is long and meant to be copied:
 * it is shown shortened (`bafyrei…q7x2`) beside a copy button that copies the
 * full value. `text` is a sentence about the proof (the anchor, the log
 * position), shown as is.
 */
export interface TechnicalRow {
  readonly key: string;
  readonly label: string;
  /** The full value: for an `id`, what is copied. */
  readonly value: string;
  readonly kind: "id" | "text";
}

/** One of verify-core's six checks, as the CLI's `--verbose` prints it. */
export interface CheckLine {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

/** `bafyrei…q7x2`: enough to recognise a long id, with the rest one copy away. */
export function abbreviateId(value: string, head = 7, tail = 4): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface TechnicalInput {
  readonly report: VerificationReport;
  readonly manifest: VersionManifest | null;
  readonly proof: RecordProofInfo;
}

/** The record ids, anchor and signers behind the checklist. */
export function technicalRows(input: TechnicalInput): TechnicalRow[] {
  const { report, manifest, proof } = input;
  const rows: TechnicalRow[] = [];
  const add = (
    key: string,
    label: string,
    value: string | null,
    kind: TechnicalRow["kind"] = "id",
  ) => {
    if (value !== null && value !== "") rows.push({ key, label, value, kind });
  };

  add("version", "Version record", report.head);
  add("manifest", "Manifest", manifest?.cid ?? null);
  add("paper", "Paper record", report.genesis);

  // The raw ids the checklist's notice lines deliberately do not print: the
  // record id and the signer's did:key, one copy away (bug_spec_verify4 bug 4).
  report.supersessions.forEach((notice, index) => {
    const word = noticeKindWord(notice.kind);
    add(`notice-${index + 1}-record`, `${word} record`, notice.id);
    add(`notice-${index + 1}-signer`, `${word} signer`, notice.author);
  });

  const { anchor } = proof;
  if (anchor.status === "anchored") {
    const parts = [
      anchor.chain === null ? null : `chain ${anchor.chain}`,
      anchor.batch === null ? null : `batch ${anchor.batch}`,
      `anchored ${formatAnchorTime(anchor.anchoredAt)}`,
      "reported by the node",
    ].filter((part): part is string => part !== null);
    add("anchor", "Anchor", parts.join(" · "), "text");
  } else {
    add("anchor", "Anchor", "pending", "text");
  }
  if (proof.seq !== null) add("log", "Log entry", `#${proof.seq}`, "text");

  report.signers.forEach((did, index) =>
    add(`signer-${index + 1}`, report.signers.length === 1 ? "Signer" : `Signer ${index + 1}`, did),
  );
  return rows;
}

/** Every check verify-core ran, in report order. */
export function checkLines(report: VerificationReport): CheckLine[] {
  return Object.values(report.checks).map((check) => ({
    name: check.name,
    passed: check.passed,
    message: cliWording(check.message),
  }));
}

// --- the offline command -------------------------------------------------

/** Quote `value` for a POSIX shell only when it needs it. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that repeats this check outside the browser:
 * `scholium verify sch:k3f9-q2xz-7mwd/v2 --node https://node.example`.
 *
 * A `sch:` id needs `--node` because the CLI reads its argument as an archive
 * file otherwise (`scholium verify FILE.car` is the fully offline form, for an
 * archive exported from a node).
 */
export function offlineCommand(schId: string, nodeUrl: string): string {
  return `scholium verify ${shellQuote(schId)} --node ${shellQuote(nodeUrl.replace(/\/+$/, ""))}`;
}
