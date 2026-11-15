/**
 * The plain-language checklist of the Proof tab (docs/design.md §5.3), and the
 * verdict it adds up to.
 *
 * verify-core answers six technical questions (`chain`, `signatures`,
 * `prev_hashes`, `consents`, `manifests`, `supersession`). A reader wants five
 * plain ones, the same five `scholium verify` prints
 * (`apps/api/packages/cli/src/scholium_cli/checklist.py`), and the rules that
 * fold the six into the five are that file's, line for line:
 *
 * | Line                 | From                                  |
 * | -------------------- | ------------------------------------- |
 * | Signed by all authors | `signatures` + `consents`            |
 * | History intact        | `chain` + `prev_hashes`              |
 * | Files match           | `manifests` + the files themselves   |
 * | Timestamp / anchor    | the node's proof (never the browser) |
 * | No retraction         | `supersession`                       |
 *
 * That shared rule is what lets the in-browser indicator and the CLI agree
 * (PRD: "indicator result equals CLI verifier result"): both fail on exactly
 * the same failed checks. A line is a pass, a fail, *pending* (a state, not an
 * error) or a *warning* (verified, but the reader should know). Only fails
 * make the verdict negative: a retracted paper's history still verifies, so a
 * retraction is a warning, not a failure.
 *
 * Pure data and functions, no React.
 */

import {
  VERIFY_BADGE_SPECS,
  type VerifyState,
} from "../ui-kit/verify";
import type { CheckResult, VerificationReport } from "../verify-core";
import { formatAnchorTime, type RecordProofInfo } from "./anchor";
import type { FileResult, VersionManifest } from "./files";

export type ItemState = "pass" | "fail" | "pending" | "warn";

export type ItemKey = "authors" | "history" | "files" | "anchor" | "retraction";

export interface ChecklistItem {
  readonly key: ItemKey;
  readonly state: ItemState;
  /** One plain sentence. */
  readonly text: string;
  /** Individual findings, shown under a fail or a warning. */
  readonly details: readonly string[];
  /** A follow-up link (the anchor transaction); always `https:`. */
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

function retractionItem(report: VerificationReport): ChecklistItem {
  const check = report.checks.supersession;
  if (!check.passed) return fromChecks("retraction", "", [check]);

  const notices = report.supersessions.map(
    (notice) =>
      `${notice.kind} ${notice.id} signed by ${notice.author}` +
      (notice.applied ? " (applies)" : ` (not applied: ${notice.reason})`),
  );
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

// --- the timestamp line --------------------------------------------------

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
  return item(
    "anchor",
    "pending",
    "Timestamp anchor pending: the public timestamp will be added within the hour",
  );
}

// --- the whole checklist -------------------------------------------------

export interface ChecklistInput {
  readonly report: VerificationReport;
  readonly manifest: VersionManifest | null;
  readonly fileResults: readonly FileResult[];
  readonly proof: RecordProofInfo;
}

/** The five plain lines, in the order of docs/design.md §5.3. */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { report, manifest, fileResults, proof } = input;
  return [
    authorsItem(report),
    historyItem(report),
    filesItem(report, manifest, fileResults),
    anchorItem(proof),
    retractionItem(report),
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
 * Headline and summary for each state. The words come from the VerifyBadge's
 * own table (docs/design.md §5.3) so the badge in the paper header and this
 * tab always say the same thing; only the two states that happen *in this
 * tab* get its sentence ("Verified in your browser").
 */
export function verdictCopy(state: VerifyState): VerdictCopy {
  const spec = VERIFY_BADGE_SPECS[state];
  switch (state) {
    case "verified":
      return { headline: "Verified in your browser", summary: spec.meaning };
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
