/**
 * Verification of a whole paper from a set of records.
 *
 * Browser port of `scholium_record_core.verify_paper`, pinned to
 * `apps/api/packages/record-core/vectors/verification.json`.
 *
 * Given the records of a paper -- in any order, possibly mixed with records
 * of other papers and with reviews, discussion and so on -- it follows
 * `prev` links from the newest version back to the genesis record and
 * reports whether the paper is intact and what its standing is:
 *
 * ```ts
 * const report = verifyPaper(records);
 * report.status;        // "verified" | "corrected" | "retracted" |
 *                       // "tombstoned" | "invalid"
 * report.signers;       // did:keys whose signatures authenticate the paper
 * report.version_count; // versions followed from head to genesis
 * report.checks;        // {chain, signatures, prev_hashes, consents, manifests, supersession}
 * ```
 *
 * The report is the same shape as the Python `VerificationReport`: use
 * {@link VerificationReport.toDict} for the JSON rendering the Python
 * `to_dict()` produces.
 *
 * Everything a record can get wrong -- tampering, missing records, forks,
 * forged notices -- is a failed check, never an exception.  Only invalid
 * *arguments* (a non-mapping record, a malformed `paper`/`head`) throw.
 */

import { computeRecordId } from "./envelope";
import { MANIFEST_TYPE, validateManifestBody } from "./manifest";
import {
  deriveShortId,
  formatVersionId,
  parseShortId,
  parseVersionId,
} from "./short-id";
import { isEd25519DidKey, verifyEnvelope } from "./signing";

//: Record types the verifier reads.
export const GENESIS_TYPE = "paper.genesis";
export const VERSION_TYPE = "paper.version";
export const CONSENT_TYPE = "coauthor.consent";
export const RETRACTION_TYPE = "retraction";
export const CORRECTION_TYPE = "correction";
export const MODERATION_TYPE = "moderation.decision";

/** `moderation.decision` action that removes content. */
export const TOMBSTONE_ACTION = "tombstone";

/** `coauthor.consent` decisions. */
export const CONSENT_ACCEPT = "accept";
export const CONSENT_DECLINE = "decline";

/** Report `status` values. */
export const STATUS_VERIFIED = "verified";
export const STATUS_CORRECTED = "corrected";
export const STATUS_RETRACTED = "retracted";
export const STATUS_TOMBSTONED = "tombstoned";
export const STATUS_INVALID = "invalid";

export const STATUSES: readonly string[] = [
  STATUS_VERIFIED,
  STATUS_CORRECTED,
  STATUS_RETRACTED,
  STATUS_TOMBSTONED,
  STATUS_INVALID,
];

/** Supersession notice kinds. */
export const KIND_RETRACTION = "retraction";
export const KIND_CORRECTION = "correction";
export const KIND_TOMBSTONE = "tombstone";

/** The checks every report carries, in report order. */
export const CHECK_NAMES: readonly string[] = [
  "chain",
  "signatures",
  "prev_hashes",
  "consents",
  "manifests",
  "supersession",
];

/** A JSON-serializable check result. */
export interface CheckResultDict {
  passed: boolean;
  message: string;
  details: string[];
}

/** Outcome of one verification check. */
export class CheckResult {
  constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly message: string,
    readonly details: readonly string[] = [],
  ) {}

  /** Python `CheckResult.to_dict()`. */
  toDict(): CheckResultDict {
    return {
      passed: this.passed,
      message: this.message,
      details: [...this.details],
    };
  }

  to_dict(): CheckResultDict {
    return this.toDict();
  }
}

/** A JSON-serializable supersession notice. */
export interface SupersessionDict {
  kind: string;
  id: string | null;
  author: string | null;
  target: string;
  scope: string;
  applied: boolean;
  reason: string | null;
}

/** One retraction, correction or tombstone that names the paper. */
export class Supersession {
  constructor(
    readonly kind: string,
    readonly id: string | null,
    readonly author: string | null,
    readonly target: string,
    readonly scope: string,
    readonly applied: boolean,
    readonly reason: string | null = null,
  ) {}

  toDict(): SupersessionDict {
    return {
      kind: this.kind,
      id: this.id,
      author: this.author,
      target: this.target,
      scope: this.scope,
      applied: this.applied,
      reason: this.reason,
    };
  }

  to_dict(): SupersessionDict {
    return this.toDict();
  }
}

/** A JSON-serializable verification report. */
export interface VerificationReportDict {
  status: string;
  valid: boolean;
  short_id: string | null;
  genesis: string | null;
  head: string | null;
  version_count: number;
  signers: string[];
  authors: string[];
  checks: Record<string, CheckResultDict>;
  supersessions: SupersessionDict[];
}

/** The result of {@link verifyPaper}. */
export class VerificationReport {
  /** Non-enumerable anchor/log proofs the caller supplied, if any. */
  declare readonly proofs?: readonly unknown[];

  constructor(
    readonly status: string,
    readonly short_id: string | null,
    readonly genesis: string | null,
    readonly head: string | null,
    readonly version_count: number,
    readonly signers: readonly string[],
    readonly authors: readonly string[],
    readonly checks: Record<string, CheckResult>,
    readonly supersessions: readonly Supersession[] = [],
  ) {}

  /** True when every check passed (status is not `invalid`). */
  get valid(): boolean {
    return this.status !== STATUS_INVALID;
  }

  /** camelCase alias for {@link short_id}. */
  get shortId(): string | null {
    return this.short_id;
  }

  /** camelCase alias for {@link version_count}. */
  get versionCount(): number {
    return this.version_count;
  }

  /** A JSON-serializable rendering, identical to Python `to_dict()`. */
  toDict(): VerificationReportDict {
    const checks: Record<string, CheckResultDict> = {};
    for (const [name, check] of Object.entries(this.checks)) {
      checks[name] = check.toDict();
    }
    return {
      status: this.status,
      valid: this.valid,
      short_id: this.short_id,
      genesis: this.genesis,
      head: this.head,
      version_count: this.version_count,
      signers: [...this.signers],
      authors: [...this.authors],
      checks,
      supersessions: this.supersessions.map((item) => item.toDict()),
    };
  }

  to_dict(): VerificationReportDict {
    return this.toDict();
  }

  toJSON(): VerificationReportDict {
    return this.toDict();
  }
}

// --- helpers ------------------------------------------------------------

type Record_ = Record<string, unknown>;

function isMapping(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function body(record: Record_): Record_ {
  const value = record.body;
  return isMapping(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Python `str()` for the values that reach a message. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  return String(value);
}

/** Python `repr()` for a string, used where the Python message uses `!r`. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return pyStr(value);
}

function versionNumber(record: Record_): number | null {
  const n = body(record).n;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

function label(record: Record_): string {
  return `${pyStr(record.type)} ${pyStr(record.id)}`;
}

function shortOf(recordId: string): string | null {
  try {
    return deriveShortId(recordId);
  } catch {
    return null;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isMapping(a) || isMapping(b)) {
    if (!isMapping(a) || !isMapping(b)) {
      return false;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(a[key], b[key]),
    );
  }
  return false;
}

// --- the index ----------------------------------------------------------

/** The input records, indexed by claimed id, with cached authentication. */
class Index {
  readonly records: Record_[] = [];
  readonly byId = new Map<string, Record_>();
  /** Ids claimed by two different records. */
  readonly conflicts = new Set<string>();
  private readonly problems = new Map<Record_, string | null>();

  constructor(records: Iterable<unknown>) {
    let position = 0;
    for (const record of records) {
      if (!isMapping(record)) {
        throw new TypeError(
          `records[${position}] must be a mapping, got ${pyStr(
            Array.isArray(record) ? "array" : typeof record,
          )}`,
        );
      }
      const recordId = text(record.id);
      if (recordId !== null) {
        const known = this.byId.get(recordId);
        if (known === undefined) {
          this.byId.set(recordId, record);
        } else if (deepEqual(known, record)) {
          position += 1;
          continue; // an exact duplicate adds nothing
        } else {
          this.conflicts.add(recordId);
        }
      }
      this.records.push(record);
      position += 1;
    }
  }

  recomputedId(record: Record_): string | null {
    try {
      return computeRecordId(record);
    } catch {
      return null;
    }
  }

  /** Why `record` is not authentic, or `null` when it is. */
  problem(record: Record_): string | null {
    if (!this.problems.has(record)) {
      this.problems.set(record, this.authenticate(record));
    }
    return this.problems.get(record) ?? null;
  }

  private authenticate(record: Record_): string | null {
    const recomputed = this.recomputedId(record);
    if (recomputed === null) {
      return "is not a well-formed record";
    }
    if (record.id !== recomputed) {
      return "id does not match the hash of its content";
    }
    const signature = record.sig;
    if (
      typeof signature !== "string" &&
      !ArrayBuffer.isView(signature) &&
      Object.prototype.toString.call(signature) !== "[object ArrayBuffer]"
    ) {
      return "has no signature";
    }
    if (!verifyEnvelope(record, signature)) {
      return "signature does not verify against its author";
    }
    return null;
  }

  ofType(recordType: string): Record_[] {
    return this.records.filter((record) => record.type === recordType);
  }
}

// --- locators -----------------------------------------------------------

interface Locator {
  recordId: string | null;
  shortId: string | null;
  version: number | null;
}

function parseRecordId(value: string, what: string): string {
  try {
    deriveShortId(value); // validates: a dag-cbor sha2-256 CIDv1
  } catch (cause) {
    throw new Error(
      `${what} must be a 'sch:' id or a record id: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  return value;
}

function isSch(value: string): boolean {
  return value.slice(0, 4).toLowerCase() === "sch:";
}

function parsePaper(value: unknown): Locator | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `paper must be a string, got ${value === null ? "None" : typeof value}`,
    );
  }
  if (isSch(value)) {
    return { recordId: null, shortId: parseShortId(value), version: null };
  }
  const recordId = parseRecordId(value, "paper");
  return { recordId, shortId: deriveShortId(recordId), version: null };
}

function parseHead(value: unknown): Locator | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `head must be a string, got ${value === null ? "None" : typeof value}`,
    );
  }
  if (isSch(value)) {
    const versionId = parseVersionId(value);
    return {
      recordId: null,
      shortId: versionId.shortId,
      version: versionId.version,
    };
  }
  return {
    recordId: parseRecordId(value, "head"),
    shortId: null,
    version: null,
  };
}

function coerceAuthorities(authorities: unknown): ReadonlySet<string> {
  if (
    typeof authorities === "string" ||
    authorities === null ||
    authorities === undefined ||
    typeof (authorities as Iterable<unknown>)[Symbol.iterator] !== "function"
  ) {
    throw new TypeError(
      "authorities must be a collection of did:key strings, got " +
        pyStr(authorities === null ? "None" : typeof authorities),
    );
  }
  const trusted = new Set<string>();
  for (const did of authorities as Iterable<unknown>) {
    if (typeof did !== "string") {
      throw new TypeError(
        `authorities must be did:key strings, got ${
          did === null ? "None" : typeof did
        }`,
      );
    }
    trusted.add(did);
  }
  return trusted;
}

// --- the chain ----------------------------------------------------------

class Chain {
  paperId: string | null = null;
  genesis: Record_ | null = null;
  headId: string | null = null;
  /** Chain versions, oldest first. */
  versions: Record_[] = [];
  /** Every `paper.version` record that claims this paper. */
  candidates: Record_[] = [];
  problems: string[] = [];
}

/** Genesis ids the records describe or refer to, sorted. */
function paperCandidates(index: Index): string[] {
  const ids = new Set<string>();
  for (const record of index.records) {
    let recordId: string | null = null;
    if (record.type === GENESIS_TYPE) {
      recordId = text(record.id);
    } else if (record.type === VERSION_TYPE) {
      recordId = text(body(record).paper);
    } else {
      continue;
    }
    if (recordId !== null) {
      ids.add(recordId);
    }
  }
  return [...ids].sort();
}

/** Return the genesis record id the verification is about. */
function identifyPaper(
  index: Index,
  paper: Locator | null,
  head: Locator | null,
  chain: Chain,
): string | null {
  const problems = chain.problems;
  if (paper !== null && paper.recordId !== null) {
    return paper.recordId;
  }

  const short =
    (paper !== null ? paper.shortId : null) ??
    (head !== null ? head.shortId : null);
  if (short !== null) {
    const matches = paperCandidates(index).filter(
      (candidate) => shortOf(candidate) === short,
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 0) {
      problems.push(
        `${matches.length} papers share the id ${short}; ` +
          "pass the genesis record id as paper=",
      );
    } else {
      problems.push(`no record belongs to the paper ${short}`);
    }
    return null;
  }

  if (head !== null && head.recordId !== null) {
    const record = index.byId.get(head.recordId);
    if (record === undefined) {
      problems.push(`head ${head.recordId} is not among the records`);
      return null;
    }
    const paperId = text(body(record).paper);
    if (record.type !== VERSION_TYPE || paperId === null) {
      problems.push(`head ${head.recordId} is not a paper.version record`);
      return null;
    }
    return paperId;
  }

  const candidates = paperCandidates(index);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 0) {
    problems.push(
      `the records describe ${candidates.length} papers; ` +
        "name one with paper=",
    );
  } else {
    problems.push("the records contain no paper.genesis or paper.version");
  }
  return null;
}

/** Return the record id of the version to verify. */
function identifyHead(
  index: Index,
  head: Locator | null,
  chain: Chain,
): string | null {
  const problems = chain.problems;
  const paperId = chain.paperId;
  if (paperId === null) {
    throw new Error("paper_id cannot be None here");
  }

  if (head !== null && head.recordId !== null) {
    return head.recordId;
  }

  if (head !== null) {
    // a sch:xxxx-xxxx-xxxx/vN version id
    if (head.shortId !== shortOf(paperId)) {
      problems.push(`head names paper ${head.shortId}, not this paper`);
      return null;
    }
    const matches = chain.candidates.filter(
      (record) => versionNumber(record) === head.version,
    );
    if (matches.length === 1) {
      return text(matches[0].id);
    }
    if (matches.length > 0) {
      problems.push(
        `${matches.length} records claim version ${head.version}; ` +
          "name one by record id with head=",
      );
    } else {
      problems.push(`the records contain no version ${head.version}`);
    }
    return null;
  }

  if (chain.candidates.length === 0) {
    problems.push("the records contain no paper.version for this paper");
    return null;
  }
  const ids = chain.candidates.map((record) => text(record.id));
  if (ids.includes(null)) {
    problems.push("a paper.version record has no id");
  }
  const referenced = new Set(chain.candidates.map((record) => record.prev));
  const tips = [
    ...new Set(
      ids.filter(
        (recordId): recordId is string =>
          recordId !== null && !referenced.has(recordId),
      ),
    ),
  ].sort();
  if (tips.length === 1) {
    return tips[0];
  }
  if (tips.length > 0) {
    // A version whose predecessor is absent is a tip too, so a gap in the
    // chain looks like a fork.  Name the gap first: it is the likelier cause.
    for (const record of chain.candidates) {
      const previous = text(record.prev);
      if (
        previous !== null &&
        previous !== paperId &&
        !index.byId.has(previous)
      ) {
        problems.push(
          `version ${pyStr(record.id)} names prev ${previous}, ` +
            "which is not among the records",
        );
      }
    }
    problems.push(
      `competing heads (${tips.length} versions are not followed by any ` +
        `other): ${tips.join(", ")}; name the one to verify with head=`,
    );
  } else {
    problems.push("the prev links of the paper's versions form a cycle");
  }
  return null;
}

/** Follow `prev` from `headId` to the genesis; fill `chain.versions`. */
function walk(index: Index, chain: Chain, headId: string): void {
  const problems = chain.problems;
  const paperId = chain.paperId;
  const newestFirst: Record_[] = [];
  const seen = new Set<string>();
  let reachedGenesis = false;
  let child: string | null = null;
  let current: string = headId;
  for (;;) {
    if (current === paperId) {
      reachedGenesis = child !== null;
      if (!reachedGenesis) {
        problems.push(`head ${headId} is the genesis record, not a version`);
      }
      break;
    }
    const record = index.byId.get(current);
    if (record === undefined) {
      problems.push(
        child === null
          ? `head ${current} is not among the records`
          : `version ${child} names prev ${current}, ` +
              "which is not among the records",
      );
      break;
    }
    if (seen.has(current)) {
      problems.push(`the prev links loop back to ${current}`);
      break;
    }
    seen.add(current);
    if (record.type !== VERSION_TYPE) {
      problems.push(
        `${current} is a ${pyRepr(record.type)} record, not a paper.version`,
      );
      break;
    }
    newestFirst.push(record);
    const previous = text(record.prev);
    if (previous === null) {
      problems.push(`version ${current} has no prev link`);
      break;
    }
    child = current;
    current = previous;
  }

  chain.versions = newestFirst.reverse();
  let firstN: number | null = null;
  chain.versions.forEach((record, position) => {
    const where = `version ${pyStr(record.id)}`;
    if (body(record).paper !== paperId) {
      problems.push(`${where} belongs to a different paper`);
    }
    const n = versionNumber(record);
    if (n === null) {
      problems.push(`${where} has no valid version number n`);
      return;
    }
    if (position === 0) {
      firstN = n;
    }
    const expected = (reachedGenesis ? 1 : firstN ?? n) + position;
    if (n !== expected) {
      problems.push(`${where} has n=${n}, expected ${expected}`);
    }
  });
}

function resolveChain(
  index: Index,
  paper: Locator | null,
  head: Locator | null,
): Chain {
  const chain = new Chain();
  chain.paperId = identifyPaper(index, paper, head, chain);
  const paperId = chain.paperId;
  if (paperId === null) {
    return chain;
  }

  const genesis = index.byId.get(paperId);
  if (genesis === undefined) {
    chain.problems.push(
      `the paper.genesis record ${paperId} is not among the records`,
    );
  } else if (genesis.type !== GENESIS_TYPE) {
    chain.problems.push(
      `record ${paperId} is a ${pyRepr(genesis.type)} record, ` +
        "not a paper.genesis",
    );
  } else {
    chain.genesis = genesis;
    if (genesis.prev !== null && genesis.prev !== undefined) {
      chain.problems.push("the paper.genesis record must have prev null");
    }
  }

  chain.candidates = index.records
    .filter(
      (record) =>
        record.type === VERSION_TYPE && body(record).paper === paperId,
    )
    .sort((a, b) => (pyStr(a.id) < pyStr(b.id) ? -1 : pyStr(a.id) > pyStr(b.id) ? 1 : 0));
  chain.headId = identifyHead(index, head, chain);
  if (chain.headId !== null) {
    walk(index, chain, chain.headId);
  }
  return chain;
}

// --- per-check state ----------------------------------------------------

/** Return a version's listed author DIDs, or why they cannot be read. */
function listedAuthors(
  version: Record_,
): { listed: string[]; problem: string | null } {
  const authors = body(version).authors;
  if (!Array.isArray(authors)) {
    return { listed: [], problem: "body.authors must be a list" };
  }
  if (authors.length === 0) {
    return { listed: [], problem: "body.authors must list at least one author" };
  }
  const dids: string[] = [];
  for (let position = 0; position < authors.length; position += 1) {
    const entry = authors[position];
    const did = isMapping(entry) ? entry.did : null;
    if (typeof did !== "string" || !isEd25519DidKey(did)) {
      return {
        listed: [],
        problem: `body.authors[${position}].did is not an Ed25519 did:key`,
      };
    }
    if (!dids.includes(did)) {
      dids.push(did);
    }
  }
  return { listed: dids, problem: null };
}

class VersionConsents {
  readonly accepted = new Map<string, Record_>();
  readonly declined: string[] = [];

  constructor(
    readonly version: Record_,
    readonly listed: readonly string[],
    readonly problem: string | null,
  ) {}

  missing(): string[] {
    return this.listed.filter(
      (did) => !this.accepted.has(did) && !this.declined.includes(did),
    );
  }
}

class Context {
  readonly consents: Map<string, Record_[]>;
  readonly versionConsents: VersionConsents[] = [];
  readonly manifests = new Map<string, Record_>();
  readonly manifestProblems: string[] = [];
  /** File cids of each chain version's manifest, by version id. */
  readonly files = new Map<string, Set<string>>();

  constructor(
    readonly index: Index,
    readonly chain: Chain,
    readonly authorities: ReadonlySet<string>,
  ) {
    this.consents = gatherConsents(index);
  }
}

function gatherConsents(index: Index): Map<string, Record_[]> {
  const byVersion = new Map<string, Record_[]>();
  for (const record of index.ofType(CONSENT_TYPE)) {
    const versionId = text(body(record).version);
    if (versionId !== null) {
      const list = byVersion.get(versionId) ?? [];
      list.push(record);
      byVersion.set(versionId, list);
    }
  }
  for (const records of byVersion.values()) {
    records.sort((a, b) =>
      pyStr(a.id) < pyStr(b.id) ? -1 : pyStr(a.id) > pyStr(b.id) ? 1 : 0,
    );
  }
  return byVersion;
}

function evaluateConsents(ctx: Context): void {
  for (const version of ctx.chain.versions) {
    const { listed, problem } = listedAuthors(version);
    const state = new VersionConsents(version, listed, problem);
    for (const consent of ctx.consents.get(pyStr(version.id)) ?? []) {
      if (ctx.index.problem(consent) !== null) {
        continue; // reported by the signatures check, never counted
      }
      const did = consent.author;
      if (typeof did !== "string" || !listed.includes(did)) {
        continue;
      }
      const decision = body(consent).decision;
      if (decision === CONSENT_ACCEPT) {
        if (!state.accepted.has(did)) {
          state.accepted.set(did, consent);
        }
      } else if (
        decision === CONSENT_DECLINE &&
        !state.declined.includes(did)
      ) {
        state.declined.push(did);
      }
    }
    ctx.versionConsents.push(state);
  }
}

function evaluateManifests(ctx: Context): void {
  for (const version of ctx.chain.versions) {
    const versionId = pyStr(version.id);
    const where = `version ${versionId}`;
    const reference = text(body(version).manifest);
    if (reference === null) {
      ctx.manifestProblems.push(`${where} names no manifest`);
      continue;
    }
    const manifest = ctx.index.byId.get(reference);
    if (manifest === undefined) {
      ctx.manifestProblems.push(
        `${where}: manifest ${reference} is not among the records`,
      );
    } else if (manifest.type !== MANIFEST_TYPE) {
      ctx.manifestProblems.push(
        `${where}: ${reference} is a ${pyRepr(manifest.type)} record, ` +
          "not a manifest",
      );
    } else {
      ctx.manifests.set(versionId, manifest);
      try {
        const files = validateManifestBody(manifest.body).files;
        ctx.files.set(
          versionId,
          new Set(files.map((entry) => entry.cid as string)),
        );
      } catch (cause) {
        ctx.manifestProblems.push(
          `${where}: manifest ${reference} is invalid: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
  }
}

// --- the checks ---------------------------------------------------------

function unchecked(name: string, chain: Chain): CheckResult {
  const reason =
    chain.problems.length > 0 ? chain.problems[0] : "no version chain was found";
  return new CheckResult(name, false, `Not checked: ${reason}`, [
    ...chain.problems,
  ]);
}

function checkChain(ctx: Context): CheckResult {
  const chain = ctx.chain;
  if (chain.problems.length > 0) {
    return new CheckResult(
      "chain",
      false,
      `The version history is broken: ${chain.problems[0]}`,
      [...chain.problems],
    );
  }
  const count = chain.versions.length;
  const span = count === 1 ? "v1" : `v1 → v${count}`;
  return new CheckResult(
    "chain",
    true,
    `Version history is intact (${span}) back to the genesis record`,
  );
}

/** Records the verdict rests on, each once, in a stable order. */
function relevantRecords(ctx: Context): Record_[] {
  const chain = ctx.chain;
  const ordered: Record_[] = [];
  if (chain.genesis !== null) {
    ordered.push(chain.genesis);
  }
  for (const version of chain.versions) {
    ordered.push(version);
    const manifest = ctx.manifests.get(pyStr(version.id));
    if (manifest !== undefined) {
      ordered.push(manifest);
    }
    ordered.push(...(ctx.consents.get(pyStr(version.id)) ?? []));
  }
  return [...new Set(ordered)];
}

function checkSignatures(ctx: Context): CheckResult {
  const records = relevantRecords(ctx);
  if (records.length === 0) {
    return unchecked("signatures", ctx.chain);
  }
  const details: string[] = [];
  for (const record of records) {
    const problem = ctx.index.problem(record);
    if (problem !== null) {
      details.push(`${label(record)}: ${problem}`);
    }
  }
  const claimed = new Set(
    records
      .map((record) => record.id)
      .filter((recordId): recordId is string => typeof recordId === "string"),
  );
  const conflicts = [...ctx.index.conflicts]
    .filter((recordId) => claimed.has(recordId))
    .sort();
  for (const conflict of conflicts) {
    details.push(`two different records claim the id ${conflict}`);
  }
  if (details.length > 0) {
    return new CheckResult(
      "signatures",
      false,
      `${plural(details.length, "record")} failed authentication: ${details[0]}`,
      details,
    );
  }
  return new CheckResult(
    "signatures",
    true,
    `All ${records.length} records carry a valid signature from their author`,
  );
}

function checkPrevHashes(ctx: Context): CheckResult {
  const chain = ctx.chain;
  if (chain.versions.length === 0) {
    return unchecked("prev_hashes", chain);
  }
  const details: string[] = [];
  chain.versions.forEach((version, position) => {
    const where = `version ${pyStr(version.id)}`;
    const named = version.prev;
    if (named === null || named === undefined) {
      details.push(`${where} has no prev link`);
      return;
    }
    let previous: Record_ | null;
    if (position > 0) {
      previous = chain.versions[position - 1];
    } else {
      // the oldest version found links to the genesis, or to a gap
      previous = named === chain.paperId ? chain.genesis : null;
    }
    if (previous === null) {
      details.push(
        `${where} names prev ${pyStr(named)}, which is not among the records, ` +
          "so the link cannot be checked",
      );
      return;
    }
    const actual = ctx.index.recomputedId(previous);
    if (actual !== named) {
      details.push(
        `${where} names prev ${pyStr(named)}, but the record before it ` +
          (actual !== null
            ? `hashes to ${actual}`
            : "cannot be hashed"),
      );
    }
  });
  if (details.length > 0) {
    return new CheckResult(
      "prev_hashes",
      false,
      `A prev link does not match its record: ${details[0]}`,
      details,
    );
  }
  return new CheckResult(
    "prev_hashes",
    true,
    `All ${plural(chain.versions.length, "prev link")} match the hash of the ` +
      "record they name",
  );
}

function checkConsents(ctx: Context): CheckResult {
  if (ctx.versionConsents.length === 0) {
    return unchecked("consents", ctx.chain);
  }
  const details: string[] = [];
  for (const state of ctx.versionConsents) {
    const where = `version ${pyStr(state.version.id)}`;
    if (state.problem !== null) {
      details.push(`${where}: ${state.problem}`);
      continue;
    }
    details.push(
      ...state.declined.map((did) => `${where}: declined by ${did}`),
    );
    details.push(
      ...state.missing().map((did) => `${where}: no consent from ${did}`),
    );
  }
  if (details.length > 0) {
    return new CheckResult(
      "consents",
      false,
      `Not every listed author consented: ${details[0]}`,
      details,
    );
  }
  const head = ctx.versionConsents[ctx.versionConsents.length - 1];
  return new CheckResult(
    "consents",
    true,
    `Signed by all ${head.listed.length} listed authors ` +
      "(every version has a consent from each of its authors)",
  );
}

function checkManifests(ctx: Context): CheckResult {
  const chain = ctx.chain;
  if (chain.versions.length === 0) {
    return unchecked("manifests", chain);
  }
  if (ctx.manifestProblems.length > 0) {
    return new CheckResult(
      "manifests",
      false,
      `A manifest is missing or invalid: ${ctx.manifestProblems[0]}`,
      [...ctx.manifestProblems],
    );
  }
  const headFiles =
    ctx.files.get(pyStr(chain.versions[chain.versions.length - 1].id)) ??
    new Set<string>();
  return new CheckResult(
    "manifests",
    true,
    `Every version lists a valid manifest (${plural(
      headFiles.size,
      "file",
    )} in the verified version)`,
  );
}

/** DIDs that count as authors of the paper for authorizing notices. */
function paperAuthors(ctx: Context): Set<string> {
  const authors = new Set<string>();
  const chain = ctx.chain;
  const records: Record_[] = [
    ...(chain.genesis !== null ? [chain.genesis] : []),
    ...chain.versions,
  ];
  for (const record of records) {
    const author = text(record.author);
    if (author !== null) {
      authors.add(author);
    }
  }
  for (const state of ctx.versionConsents) {
    for (const did of state.listed) {
      authors.add(did);
    }
  }
  return authors;
}

/** Return `[kind, target]` when `record` is a supersession notice. */
function notice(record: Record_): [string, string] | null {
  const recordBody = body(record);
  const target = text(recordBody.target);
  if (target === null) {
    return null;
  }
  const kind = record.type;
  if (kind === RETRACTION_TYPE) {
    return [KIND_RETRACTION, target];
  }
  if (kind === CORRECTION_TYPE) {
    return [KIND_CORRECTION, target];
  }
  if (kind === MODERATION_TYPE && recordBody.action === TOMBSTONE_ACTION) {
    return [KIND_TOMBSTONE, target];
  }
  return null;
}

function evaluateSupersession(
  ctx: Context,
): [CheckResult, Supersession[]] {
  const chain = ctx.chain;
  const paperId = chain.paperId;
  if (paperId === null || chain.versions.length === 0) {
    return [unchecked("supersession", chain), []];
  }

  const versionIds = new Set<string>();
  for (const record of [...chain.candidates, ...chain.versions]) {
    const recordId = text(record.id);
    if (recordId !== null) {
      versionIds.add(recordId);
    }
  }
  const allFiles = new Set<string>();
  for (const files of ctx.files.values()) {
    for (const file of files) {
      allFiles.add(file);
    }
  }
  const headId = pyStr(chain.versions[chain.versions.length - 1].id);
  const headFiles = ctx.files.get(headId) ?? new Set<string>();
  const authors = paperAuthors(ctx);

  const found: Supersession[] = [];
  const failures: string[] = [];
  for (const record of ctx.index.records) {
    const foundNotice = notice(record);
    if (foundNotice === null) {
      continue;
    }
    const [kind, target] = foundNotice;
    let scope: string;
    if (target === paperId) {
      scope = "paper";
    } else if (versionIds.has(target)) {
      scope = "version";
    } else if (allFiles.has(target)) {
      scope = "file";
    } else {
      continue; // names some other paper's record or file
    }

    const recordId = text(record.id);
    const signer = text(record.author);
    const problem = ctx.index.problem(record);
    let applied = false;
    let reason: string | null;
    if (problem !== null) {
      reason = `not authentic: ${problem}`;
      failures.push(`${label(record)}: ${problem}`);
    } else if (kind === KIND_TOMBSTONE && !ctx.authorities.has(signer as string)) {
      reason =
        "advisory: a tombstone applies only when a trusted authority signs it";
    } else if (
      kind !== KIND_TOMBSTONE &&
      !(authors.has(signer as string) || ctx.authorities.has(signer as string))
    ) {
      reason =
        "signer is neither an author of the paper nor a trusted authority";
    } else if (
      kind === KIND_TOMBSTONE &&
      !(scope === "paper" || target === headId || headFiles.has(target))
    ) {
      reason = "targets an earlier version, not the verified version";
    } else {
      applied = true;
      reason = null;
    }
    found.push(
      new Supersession(kind, recordId, signer, target, scope, applied, reason),
    );
  }

  found.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    const aId = a.id ?? "";
    const bId = b.id ?? "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  if (failures.length > 0) {
    return [
      new CheckResult(
        "supersession",
        false,
        `${plural(failures.length, "notice")} failed authentication: ` +
          `${failures[0]}`,
        failures,
      ),
      found,
    ];
  }
  const appliedKinds = found.filter((item) => item.applied).map((item) => item.kind);
  let message: string;
  if (appliedKinds.length === 0) {
    message = "No retraction, correction or tombstone applies";
  } else {
    const counts = [KIND_RETRACTION, KIND_CORRECTION, KIND_TOMBSTONE]
      .filter((kind) => appliedKinds.includes(kind))
      .map(
        (kind) =>
          `${plural(
            appliedKinds.filter((item) => item === kind).length,
            kind,
          )}`,
      );
    message = `On record: ${counts.join(", ")}`;
  }
  const details = found.map(
    (item) =>
      `${item.kind} ${pyStr(item.id)}: ` +
      (item.applied ? "applied" : pyStr(item.reason)),
  );
  return [new CheckResult("supersession", true, message, details), found];
}

function collectSigners(ctx: Context): string[] {
  if (ctx.chain.versions.length === 0) {
    return []; // no chain was verified, so nobody signed a verified paper
  }
  const signers = new Map<string, null>();
  const add = (record: Record_ | null | undefined): void => {
    if (record === null || record === undefined) {
      return;
    }
    if (ctx.index.problem(record) !== null) {
      return;
    }
    const author = text(record.author);
    if (author !== null && !signers.has(author)) {
      signers.set(author, null);
    }
  };
  add(ctx.chain.genesis);
  for (const state of ctx.versionConsents) {
    add(state.version);
    add(ctx.manifests.get(pyStr(state.version.id)));
    for (const did of state.listed) {
      add(state.accepted.get(did));
    }
  }
  return [...signers.keys()];
}

function status(
  checks: Record<string, CheckResult>,
  found: readonly Supersession[],
): string {
  if (Object.values(checks).some((check) => !check.passed)) {
    return STATUS_INVALID;
  }
  const applied = new Set(
    found.filter((item) => item.applied).map((item) => item.kind),
  );
  if (applied.has(KIND_RETRACTION)) {
    return STATUS_RETRACTED;
  }
  if (applied.has(KIND_TOMBSTONE)) {
    return STATUS_TOMBSTONED;
  }
  if (applied.has(KIND_CORRECTION)) {
    return STATUS_CORRECTED;
  }
  return STATUS_VERIFIED;
}

// --- entry point --------------------------------------------------------

/** Options for {@link verifyPaper}, mirroring Python's keyword arguments. */
export interface VerifyPaperOptions {
  /** The paper to verify, as a `sch:` id or the genesis record id. */
  paper?: string | null;
  /** The version to verify, as a record id or `sch:.../vN`. */
  head?: string | null;
  /** did:keys trusted to retract, correct or tombstone any paper. */
  authorities?: Iterable<string>;
  /** Anchor/log proofs from the node; accepted for the browser proof tab. */
  proofs?: Iterable<unknown>;
}

function looksLikeOptions(value: unknown): value is VerifyPaperOptions {
  if (!isMapping(value)) {
    return false;
  }
  return (
    "paper" in value || "head" in value || "authorities" in value || "proofs" in value
  );
}

function toArray(value: Iterable<unknown> | null | undefined): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof (value as Iterable<unknown>)[Symbol.iterator] === "function") {
    return [...(value as Iterable<unknown>)];
  }
  return [value];
}

/**
 * Verify a paper from a set of signed records.
 *
 * Follows `prev` links from the newest version to the genesis record, checks
 * every signature, every prev hash and that every listed author of every
 * version consented, then applies retraction, correction and tombstone
 * supersession.
 *
 * The second argument may be the node's anchor/log `proofs` (kept on the
 * report for the browser proof tab, never part of the verdict) or the
 * {@link VerifyPaperOptions} object; both forms are accepted because the
 * plugin interface names both `records` and `proofs`.
 *
 * @param records signed records in any order.
 * @param proofsOrOptions anchor/log proofs, or the options object.
 * @param maybeOptions options when `proofsOrOptions` carried proofs.
 * @returns A {@link VerificationReport}.  Bad *data* never throws; it fails
 *   a check and makes the status `invalid`.
 * @throws {TypeError|Error} if a record is not a mapping, or `paper`,
 *   `head` or `authorities` is malformed.
 */
export function verifyPaper(
  records: Iterable<unknown>,
  proofsOrOptions?: unknown,
  maybeOptions?: VerifyPaperOptions,
): VerificationReport {
  let options: VerifyPaperOptions = {};
  let proofs: unknown[] = [];
  if (proofsOrOptions !== null && proofsOrOptions !== undefined) {
    if (looksLikeOptions(proofsOrOptions)) {
      options = proofsOrOptions;
      proofs = toArray(proofsOrOptions.proofs);
    } else {
      proofs = toArray(proofsOrOptions as Iterable<unknown>);
    }
  }
  if (maybeOptions !== null && maybeOptions !== undefined) {
    options = { ...options, ...maybeOptions };
    if (maybeOptions.proofs !== undefined) {
      proofs = toArray(maybeOptions.proofs);
    }
  }

  const trusted = coerceAuthorities(
    options.authorities === undefined ? [] : options.authorities,
  );
  const index = new Index(records);
  const paperLocator = parsePaper(options.paper ?? null);
  const headLocator = parseHead(options.head ?? null);
  if (
    paperLocator !== null &&
    headLocator !== null &&
    paperLocator.shortId !== null &&
    headLocator.shortId !== null &&
    paperLocator.shortId !== headLocator.shortId
  ) {
    throw new Error(
      `paper ${paperLocator.shortId} and head ${headLocator.shortId} ` +
        "name different papers",
    );
  }

  const chain = resolveChain(index, paperLocator, headLocator);
  const ctx = new Context(index, chain, trusted);

  const checks: Record<string, CheckResult> = {};
  let supersessions: Supersession[] = [];
  if (chain.paperId === null || chain.versions.length === 0) {
    // Without a version chain nothing else can be established.
    checks.chain = checkChain(ctx);
    for (const name of CHECK_NAMES.slice(1)) {
      checks[name] = unchecked(name, chain);
    }
  } else {
    evaluateConsents(ctx);
    evaluateManifests(ctx);
    checks.chain = checkChain(ctx);
    checks.signatures = checkSignatures(ctx);
    checks.prev_hashes = checkPrevHashes(ctx);
    checks.consents = checkConsents(ctx);
    checks.manifests = checkManifests(ctx);
    [checks.supersession, supersessions] = evaluateSupersession(ctx);
  }

  const headAuthors =
    ctx.versionConsents.length > 0
      ? [...ctx.versionConsents[ctx.versionConsents.length - 1].listed]
      : [];
  const report = new VerificationReport(
    status(checks, supersessions),
    chain.paperId !== null ? shortOf(chain.paperId) : null,
    chain.paperId,
    chain.versions.length > 0
      ? text(chain.versions[chain.versions.length - 1].id)
      : null,
    chain.versions.length,
    collectSigners(ctx),
    headAuthors,
    checks,
    supersessions,
  );
  // Keep proofs available to the caller without changing the report shape.
  Object.defineProperty(report, "proofs", {
    value: proofs,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return report;
}

// Aliases matching the Python names.
export const verify_paper = verifyPaper;

/** Async wrapper for callers that prefer to await the verdict. */
export async function verifyPaperAsync(
  records: Iterable<unknown>,
  proofsOrOptions?: unknown,
  maybeOptions?: VerifyPaperOptions,
): Promise<VerificationReport> {
  return verifyPaper(records, proofsOrOptions, maybeOptions);
}

export { formatVersionId, parseShortId, parseVersionId };
