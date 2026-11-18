/**
 * The `/consent/[version]` page's data and rules: what a co-author is shown,
 * who may answer, and the `coauthor.consent` record their answer becomes.
 *
 * The page is reached from the link the API sends each listed author when a
 * version enters `awaiting_consent` (`/consent/{paper.version record id}`). It
 * reads the version record, checks the server really sent the record the link
 * names, and asks for one signed answer: **accept** or **decline** authorship.
 *
 * No React here; `use-consent-version.ts`, `use-device-did.ts` and
 * `consent-page.tsx` bind it to the screen.
 */

import { ApiError, NetworkError, api, resolveApiBaseUrl } from "../../lib/api";
import { formatDate as formatReaderDate } from "../ui-kit/format-date";
// Not the `../web-auth` index: it re-exports hooks that are not client modules,
// and this plain module reaches the server-rendered `/submit` page through the
// feature's barrel. These two files hold only plain code, so they are safe there.
import { isDeviceKeyError, isPasskeyCancellation, isRecordSigningError } from "../web-auth/errors";
import { signRecord, type SignedRecord } from "../web-auth/sign-record";
import { initials, shortDid } from "./authors";
import type { ProfileNames } from "./profile-names";
import {
  toConsentStatus,
  type ConsentReport,
  type ConsentStatus,
  type TrackerEntry,
} from "./consents";

export type ConsentDecision = "accept" | "decline";

/** The record type a co-author signs. */
export const CONSENT_RECORD_TYPE = "coauthor.consent";

/** The version state in which listed authors are asked to sign. */
export const AWAITING_CONSENT = "awaiting_consent";

/** Longest optional comment, in characters. It is public, so it is kept short. */
export const CONSENT_COMMENT_MAX = 500;

/** Where a consent answer is recorded when the author has no CRediT role listed. */
export const FALLBACK_ROLE = "Author";

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type ParsedVersionParam = { cid: string } | { error: string };

/**
 * Reads the `[version]` path segment. The id is a base32 record id
 * (`bafyrei…`); this only refuses what cannot be one, so a mistyped link says
 * so plainly instead of asking the server about nonsense. Whether the version
 * exists is the server's to say.
 */
export function parseVersionParam(raw: string): ParsedVersionParam {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { error: "That link is not a paper version. Ask the author who invited you to send it again." };
  }
  const cid = decoded.trim();
  if (cid === "") {
    return { error: "This link does not say which version to review. Ask the author who invited you to send it again." };
  }
  if (!/^[A-Za-z0-9]{8,128}$/.test(cid)) {
    return { error: "That link is not a paper version. Ask the author who invited you to send it again." };
  }
  return { cid };
}

// ---------------------------------------------------------------------------
// The version, as signed
// ---------------------------------------------------------------------------

/** One author the version lists. */
export interface VersionAuthor {
  did: string;
  /** 1-based byline position. */
  position: number;
  name: string | null;
  orcid: string | null;
  /** CRediT roles, as listed by the submitting author. */
  creditRoles: string[];
}

/** One file of the version's manifest. */
export interface VersionFile {
  path: string;
  /** The file's content id; with it the file can be opened. */
  cid: string | null;
  size: number | null;
  mediaType: string | null;
  role: string | null;
}

/** What the page shows of a `paper.version` record. */
export interface ConsentVersion {
  /** The `paper.version` record's id: what a consent signs. */
  versionCid: string;
  /** The paper's genesis record id; the consent report accepts it in place of the `sch:` id. */
  paper: string;
  /** The version number, from 1. */
  n: number;
  title: string;
  abstract: string;
  categories: string[];
  licence: string | null;
  changeNote: string | null;
  authors: VersionAuthor[];
  /** The DID that signed the version: the submitting author. */
  submittedBy: string;
  /** When it was signed, as the record says (informational, not trusted time). */
  created: string | null;
  /** The manifest record's id, if the version names one. */
  manifest: string | null;
  /** The manifest's files; `null` when the list could not be loaded or checked. */
  files: VersionFile[] | null;
}

export type ConsentVersionErrorCode = "not-a-version" | "malformed" | "mismatch";

/** The server answered, but not with something that can be reviewed and signed. */
export class ConsentVersionError extends Error {
  readonly code: ConsentVersionErrorCode;

  constructor(code: ConsentVersionErrorCode, message: string) {
    super(message);
    this.name = "ConsentVersionError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseAuthors(value: unknown): VersionAuthor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const authors: VersionAuthor[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    let did: unknown;
    let position = index + 1;
    let name: string | null = null;
    let orcid: string | null = null;
    let roles: unknown;
    if (typeof item === "string") {
      did = item;
    } else if (isRecord(item)) {
      did = item.did;
      if (typeof item.position === "number" && Number.isInteger(item.position) && item.position >= 1) {
        position = item.position;
      }
      name = text(item.name);
      orcid = text(item.orcid);
      // The spellings the API's own reader accepts.
      roles = item.creditRoles ?? item.credit ?? item.credit_roles;
    } else {
      return;
    }
    if (typeof did !== "string" || did === "" || seen.has(did)) {
      return;
    }
    seen.add(did);
    authors.push({
      did,
      position,
      name,
      orcid,
      creditRoles: Array.isArray(roles)
        ? roles.filter((role): role is string => typeof role === "string" && role.trim() !== "")
        : [],
    });
  });
  return authors.sort((a, b) => a.position - b.position);
}

/**
 * Shapes a stored `paper.version` envelope for the page.
 *
 * @throws {ConsentVersionError} the record is some other type, or lacks the
 *   paper or number a consent report is asked for.
 */
export function normalizeConsentVersion(envelope: unknown, cid: string): ConsentVersion {
  if (!isRecord(envelope) || envelope.type !== "paper.version" || !isRecord(envelope.body)) {
    throw new ConsentVersionError(
      "not-a-version",
      "That link is not a paper version, so there is nothing to consent to.",
    );
  }
  const body = envelope.body;
  const paper = text(body.paper);
  const n = body.n;
  if (paper === null || typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new ConsentVersionError(
      "malformed",
      "This version's record is missing its paper or its number, so it cannot be shown here.",
    );
  }
  return {
    versionCid: cid,
    paper,
    n,
    title: typeof body.title === "string" ? body.title.trim() : "",
    abstract: typeof body.abstract === "string" ? body.abstract.trim() : "",
    categories: Array.isArray(body.categories)
      ? body.categories.filter((category): category is string => typeof category === "string")
      : [],
    licence: text(body.licence),
    changeNote: text(body.changeNote),
    authors: parseAuthors(body.authors),
    submittedBy: typeof envelope.author === "string" ? envelope.author : "",
    created: text(envelope.created),
    manifest: text(body.manifest),
    files: null,
  };
}

/** The files a `manifest` record lists. Entries with no path are skipped. */
export function manifestFiles(envelope: unknown): VersionFile[] {
  if (!isRecord(envelope) || envelope.type !== "manifest" || !isRecord(envelope.body)) {
    throw new ConsentVersionError("malformed", "That record is not a file manifest.");
  }
  const files = envelope.body.files;
  if (!Array.isArray(files)) {
    return [];
  }
  const out: VersionFile[] = [];
  for (const entry of files) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = text(entry.path);
    if (path === null) {
      continue;
    }
    out.push({
      path,
      cid: text(entry.cid),
      size: typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null,
      mediaType: text(entry.mediaType),
      role: text(entry.role),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading it, and checking it is the record the link names
// ---------------------------------------------------------------------------

/** Reads one stored record. Public, like every read of a record, so no token is sent. */
export type FetchRecord = (cid: string, signal?: AbortSignal) => Promise<unknown>;

export const fetchRecord: FetchRecord = (cid, signal) =>
  api.get<unknown>(`/records/${encodeURIComponent(cid)}`, { auth: false, signal });

/** Computes a record's id from its envelope; verify-core's `computeRecordId`. */
export type ComputeRecordId = (envelope: unknown) => string | Promise<string>;

/** Loaded on first use so the CBOR encoder stays out of the first paint. */
const defaultRecordId: ComputeRecordId = async (envelope) => {
  const core = await import("../verify-core");
  return core.computeRecordId(envelope);
};

export interface LoadConsentVersionOptions {
  fetchRecord?: FetchRecord;
  recordId?: ComputeRecordId;
  signal?: AbortSignal;
}

export type LoadConsentVersion = (cid: string, options?: { signal?: AbortSignal }) => Promise<ConsentVersion>;

/**
 * Reads a record and proves it is the one asked for: its id is recomputed from
 * what the server sent and must equal `cid`. A consent signs the id from the
 * link, so what the co-author reads has to be what that id commits to, whatever
 * the server says.
 */
async function readCheckedRecord(
  cid: string,
  fetcher: FetchRecord,
  recordId: ComputeRecordId,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const envelope = await fetcher(cid, signal);
  let actual: string | null = null;
  try {
    actual = await recordId(envelope);
  } catch {
    // An envelope that cannot be hashed cannot be vouched for either.
  }
  if (actual !== cid) {
    throw new ConsentVersionError(
      "mismatch",
      "The server sent a record that does not match this link, so it is not shown. Do not sign anything for it.",
    );
  }
  return envelope;
}

/**
 * Loads the version a link names, checked against its id, with its file list.
 * A file list that cannot be loaded or checked leaves `files` as `null`; the
 * version itself is what is signed and is never shown unchecked.
 */
export async function loadConsentVersion(
  cid: string,
  options: LoadConsentVersionOptions = {},
): Promise<ConsentVersion> {
  const fetcher = options.fetchRecord ?? fetchRecord;
  const recordId = options.recordId ?? defaultRecordId;
  const { signal } = options;

  const version = normalizeConsentVersion(await readCheckedRecord(cid, fetcher, recordId, signal), cid);
  if (version.manifest === null) {
    return version;
  }
  try {
    const manifest = await readCheckedRecord(version.manifest, fetcher, recordId, signal);
    return { ...version, files: manifestFiles(manifest) };
  } catch (failure) {
    if (signal?.aborted) {
      throw failure;
    }
    return version;
  }
}

/** A sentence for the person reading, from whatever went wrong loading a version. */
export function versionErrorMessage(error: unknown): string {
  if (error instanceof ConsentVersionError) {
    return error.message;
  }
  if (error instanceof ApiError && error.status === 404) {
    return "The server has no paper version for this link. It may be mistyped, or belong to another server.";
  }
  if (error instanceof NetworkError) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return "Could not load this version. Try again in a moment.";
}

/** Where a listed file's bytes are served (once the safety scan has passed). */
export function fileUrl(cid: string): string {
  return `${resolveApiBaseUrl()}/v1/content/${encodeURIComponent(cid)}`;
}

/** Where the signed record itself can be read as JSON. */
export function recordUrl(cid: string): string {
  return `${resolveApiBaseUrl()}/v1/records/${encodeURIComponent(cid)}`;
}

/**
 * `16 Nov 2026`, in the reader's own time zone through the shared `ui-kit`
 * formatter: a version co-signed at 00:45 in Sydney is dated the day the
 * signer signed it (bug_spec_verify12 bug 2).
 */
export function formatSigned(created: string | null): string | null {
  return formatReaderDate(created);
}

// ---------------------------------------------------------------------------
// Who may answer
// ---------------------------------------------------------------------------

/** What the device's key says about who is looking. */
export interface DeviceIdentity {
  /** `checking` until the device's key store has been read. */
  phase: "checking" | "ready";
  did: string | null;
}

/** What the decision panel offers. */
export type ConsentGate =
  /** The key store or the consent report has not answered yet. */
  | { kind: "checking" }
  /** The consent report could not be read, so who has signed is unknown. */
  | { kind: "unavailable" }
  /** No signing key on this device. */
  | { kind: "no-key" }
  /** This device's key is not one of the version's authors. */
  | { kind: "not-listed"; did: string }
  /** This author has already answered; the answer is final. */
  | { kind: "decided"; author: VersionAuthor; decision: ConsentDecision; consentCid: string | null }
  /** The version is not waiting for consent (back in draft, or past it). */
  | { kind: "closed"; state: string; declinedBy: string | null }
  /** This author may accept or decline now. */
  | { kind: "open"; author: VersionAuthor };

export interface ConsentGateInput {
  device: DeviceIdentity;
  version: ConsentVersion;
  report: ConsentReport | null;
  /** The last request for the report failed and there is none to show. */
  reportFailed?: boolean;
}

/**
 * Decides what the page lets this device do. The signed version says who is
 * listed; the consent report says who has answered and what state the version
 * is in. Both are needed before a button appears, and a decision already made
 * is never offered again: a consent is a public record and cannot be taken
 * back, and verifiers count the first acceptance and every decline.
 */
export function consentGate({ device, version, report, reportFailed = false }: ConsentGateInput): ConsentGate {
  if (device.phase === "checking") {
    return { kind: "checking" };
  }
  if (device.did === null) {
    return { kind: "no-key" };
  }
  const did = device.did;
  const author = version.authors.find((candidate) => candidate.did === did);
  if (author === undefined) {
    return { kind: "not-listed", did };
  }
  if (report === null) {
    return reportFailed ? { kind: "unavailable" } : { kind: "checking" };
  }
  const entry = report.authors.find((candidate) => candidate.did === did);
  const status = entry === undefined ? "waiting" : toConsentStatus(entry.status);
  if (status === "signed" || status === "declined") {
    return {
      kind: "decided",
      author,
      decision: status === "signed" ? "accept" : "decline",
      consentCid: entry?.consentCid ?? null,
    };
  }
  if (report.state !== AWAITING_CONSENT) {
    return { kind: "closed", state: report.state, declinedBy: report.declinedBy ?? null };
  }
  return { kind: "open", author };
}

/** Why a version that is not waiting for consent has nothing to sign, in plain words. */
export function closedMessage(
  gate: Extract<ConsentGate, { kind: "closed" }>,
  version: ConsentVersion,
  names: ProfileNames = {},
): string {
  switch (gate.state) {
    case "draft": {
      const decliner =
        gate.declinedBy === null
          ? null
          : (version.authors.find((author) => author.did === gate.declinedBy)?.name ??
            names[gate.declinedBy] ??
            shortDid(gate.declinedBy));
      return decliner === null
        ? "This version is back in draft, so it is not asking for signatures now. If it is submitted again you will get a new link."
        : `${decliner} declined authorship, so this version is back in draft and is not asking for signatures now. If it is submitted again you will get a new link.`;
    }
    case "scanning":
    case "moderation":
    case "listed":
      return "Every author has already answered, so this version has moved on. There is nothing left to sign.";
    case "held":
    case "rejected":
      return "This version is past the consent step, so there is nothing left to sign.";
    default:
      return "This version is not waiting for consent now, so there is nothing to sign.";
  }
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/**
 * The byline with each author's status, for the consent tracker. The report
 * decides who is listed and who has answered; the signed version lends names
 * and roles, which the report may not carry. Before the report arrives
 * everyone is shown as waiting.
 */
export function consentTrackerEntries(
  version: ConsentVersion,
  report: ConsentReport | null,
  myDid: string | null,
  names: ProfileNames = {},
): TrackerEntry[] {
  const rows: { did: string; status: ConsentStatus; roles: string[] | null }[] =
    report === null
      ? version.authors.map((author) => ({ did: author.did, status: "waiting" as const, roles: null }))
      : [...report.authors]
          .sort((a, b) => a.position - b.position)
          .map((entry) => ({
            did: entry.did,
            status: toConsentStatus(entry.status),
            roles: entry.creditRoles ?? (entry.role ? [entry.role] : null),
          }));

  return rows.map((row) => {
    const listed = version.authors.find((author) => author.did === row.did);
    // The signed record's name wins; the public profile fills in an author it
    // listed by DID alone; the DID is the fallback when neither has a name.
    const name = listed?.name ?? names[row.did] ?? null;
    return {
      key: row.did,
      name: name ?? shortDid(row.did),
      monogram: name === null ? null : initials(name),
      // The name slot already shows an author with no name by their DID; do not say it twice.
      detail: name === null ? null : shortDid(row.did),
      status: row.status,
      isYou: row.did === myDid,
      roles: listed !== undefined && listed.creditRoles.length > 0 ? [...listed.creditRoles] : (row.roles ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * The role a consent names. A `coauthor.consent` carries one `role` string, and
 * an author may be listed with several CRediT roles; naming only one would
 * quietly narrow what they accepted, so all of them are named, in the order
 * the version lists them. An author listed with none accepts as `Author`.
 */
export function consentRole(author: VersionAuthor): string {
  return author.creditRoles.length > 0 ? author.creditRoles.join(", ") : FALLBACK_ROLE;
}

/** The body of the `coauthor.consent` record. `comment` is left out when blank. */
export function consentBody(
  version: ConsentVersion,
  author: VersionAuthor,
  decision: ConsentDecision,
  comment = "",
): Record<string, unknown> {
  const note = comment.trim();
  return {
    version: version.versionCid,
    role: consentRole(author),
    decision,
    ...(note === "" ? {} : { comment: note.slice(0, CONSENT_COMMENT_MAX) }),
  };
}

/** Signs a record behind a passkey prompt; `signRecord` from web-auth by default. */
export type SignConsent = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
) => Promise<SignedRecord>;

/** What the server answers to `POST /v1/records`. */
export interface RecordAccepted {
  id?: string;
  state?: string;
}

/** Submits a signed record; `POST /v1/records` by default. */
export type SubmitConsent = (record: SignedRecord) => Promise<RecordAccepted>;

const defaultSubmit: SubmitConsent = (record) => api.post<RecordAccepted>("/records", record);

export interface SubmitConsentOptions {
  version: ConsentVersion;
  author: VersionAuthor;
  decision: ConsentDecision;
  comment?: string;
  sign?: SignConsent;
  submit?: SubmitConsent;
}

export interface ConsentSubmitted {
  /** The consent record's id. */
  id: string;
  decision: ConsentDecision;
}

/** The key that signed is not the author the page was signing for. */
export class WrongSignerError extends Error {
  constructor() {
    super("The key that signed is not the author this consent is for");
    this.name = "WrongSignerError";
  }
}

/**
 * Signs the answer with the device key (passkey prompt) and submits it.
 *
 * `prev` is `null`: a consent is not a link in the paper's chain. Verifiers
 * find it by the version id in its body, as the API's own tests sign it.
 *
 * @throws {WrongSignerError} the device key is not `author`; nothing is sent.
 */
export async function submitConsent({
  version,
  author,
  decision,
  comment = "",
  sign = signRecord,
  submit = defaultSubmit,
}: SubmitConsentOptions): Promise<ConsentSubmitted> {
  const signed = await sign(CONSENT_RECORD_TYPE, consentBody(version, author, decision, comment), null);
  if (signed.author !== author.did) {
    throw new WrongSignerError();
  }
  const accepted = await submit(signed);
  return { id: accepted.id ?? signed.id, decision };
}

/** What went wrong signing, in words, and whether signing in again is the fix. */
export interface ConsentFailure {
  message: string;
  signIn: boolean;
  /** The request may have reached the server, so the page should read the report again. */
  recheck: boolean;
}

export function describeConsentError(error: unknown): ConsentFailure {
  if (isPasskeyCancellation(error)) {
    return { message: "Signing was cancelled, so nothing was sent. Choose again when you are ready.", signIn: false, recheck: false };
  }
  if (error instanceof WrongSignerError) {
    return {
      message: "The key on this device is not the author this consent is for, so nothing was sent.",
      signIn: false,
      recheck: false,
    };
  }
  if (isDeviceKeyError(error)) {
    return {
      message:
        error.code === "not-found"
          ? "This device has no signing key, so it cannot sign for you."
          : error.code === "passkey-failed"
            ? "The passkey could not be confirmed. Nothing was sent. Try again."
            : "Could not sign with this device's key. Nothing was sent.",
      signIn: false,
      recheck: false,
    };
  }
  if (isRecordSigningError(error)) {
    return { message: "Could not prepare the consent record. Nothing was sent.", signIn: false, recheck: false };
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { message: "Your session has ended. Sign in again, then come back to this page.", signIn: true, recheck: false };
    }
    if (error.status === 403) {
      return {
        message: "The server says this account is not listed as an author of this version, so it cannot sign for it.",
        signIn: false,
        recheck: false,
      };
    }
    if (error.status === 409) {
      return { message: "The server already has this record. Checking where things stand.", signIn: false, recheck: true };
    }
    if (error.status === 422) {
      return { message: `The server did not accept the record: ${error.detail}`, signIn: false, recheck: false };
    }
    return { message: "The server could not take your answer just now. Try again in a moment.", signIn: false, recheck: true };
  }
  if (error instanceof NetworkError) {
    return {
      message: "Could not reach the server. Your answer may not have been recorded; checking again.",
      signIn: false,
      recheck: true,
    };
  }
  return { message: "Something went wrong, and your answer was not confirmed. Checking where things stand.", signIn: false, recheck: true };
}
