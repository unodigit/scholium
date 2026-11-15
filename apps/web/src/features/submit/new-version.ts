/**
 * The New version form's data and rules (feature 163).
 *
 * The paper page links an author here to publish the next version of a paper
 * that already exists. Unlike `/submit` (which signs a `paper.genesis` and so
 * starts a paper), this form signs exactly one record: a `paper.version` whose
 * envelope `prev` is the cid of the paper's current latest version and whose
 * `n` is one more — the only pair the API's chain check accepts
 * (`apps/api/.../submissions/versions.py` refuses anything else with `409`).
 *
 * The form is pre-filled from what the latest version **signed**, not from a
 * summary of it: `GET /v1/papers/{id}` says which version is latest, then
 * `GET /v1/records/{versionCid}` returns the record itself, whose id is
 * recomputed and checked before anything is shown, exactly as `/consent` does
 * — an author edits what the previous version committed to, or they are
 * editing a claim nobody signed. The byline and the file manifest are carried
 * over from that version unchanged; this release's form edits the details and
 * asks the one question a new version must answer: what changed.
 *
 * No React here; `new-version-page.tsx` is the screen.
 */

import { ApiError, NetworkError, api } from "../../lib/api";
// Not the `../web-auth` index: it re-exports hooks that are not client modules,
// and this plain module must stay loadable on the server (see
// server-boundary.test.ts). These two files hold only plain code.
import { isDeviceKeyError, isPasskeyCancellation, isRecordSigningError } from "../web-auth/errors";
import { signRecord, type SignedRecord } from "../web-auth/sign-record";
import type { DraftAuthor, RecordAuthor } from "./authors";
import { fetchRecord, type ComputeRecordId, type FetchRecord } from "./consent-version";
import { DEFAULT_LICENCE_ID, detailsBlockers, type DetailsValues } from "./details";

/** The record type a new version signs. */
export const NEW_VERSION_RECORD_TYPE = "paper.version";

/** Longest change note, in characters. It is public and shown in the timeline. */
export const CHANGE_NOTE_MAX = 500;

/** The API's problem type when a `paper.version` does not extend the chain. */
export const VERSION_OUT_OF_SEQUENCE_TYPE = "urn:scholium:problem:version-out-of-sequence";

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type ParsedNewVersionRef = { id: string } | { error: string };

/**
 * Reads the `[ref]` path segment: the paper to publish the next version of.
 *
 * A `sch:` short id or a record cid names the paper; a trailing `/vN` is
 * accepted and dropped, because a new version always extends the paper's
 * *latest* version wherever the link came from. Only what cannot name a paper
 * is refused, so a mistyped link says so plainly instead of asking the server
 * about nonsense.
 */
export function parseNewVersionRef(raw: string): ParsedNewVersionRef {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { error: "That link does not name a paper, so there is no new version to write for it." };
  }
  const trimmed = decoded.trim();
  if (trimmed === "") {
    return { error: "This link does not say which paper to write a new version of." };
  }
  const [idPart, versionPart, ...rest] = trimmed.split("/");
  if (idPart === undefined || rest.length > 0) {
    return { error: "That link does not name a paper, so there is no new version to write for it." };
  }
  if (versionPart !== undefined && !/^v[1-9][0-9]{0,8}$/.test(versionPart)) {
    return { error: "That link does not name a paper, so there is no new version to write for it." };
  }
  if (!/^sch:[a-z0-9][a-z0-9-]{0,63}$/i.test(idPart) && !/^[a-z0-9]{8,128}$/i.test(idPart)) {
    return { error: "That link does not name a paper, so there is no new version to write for it." };
  }
  return { id: idPart };
}

/** Where the New version form of `paperId` (a `sch:` id or record cid) lives. */
export function newVersionHref(paperId: string): string {
  return `/submit/new-version/${encodeURIComponent(paperId)}`;
}

// ---------------------------------------------------------------------------
// The paper, as its latest version signed it
// ---------------------------------------------------------------------------

/** One author of the byline this form carries over. */
export interface NewVersionAuthor {
  did: string;
  /** 1-based byline position. */
  position: number;
  name: string | null;
  orcid: string | null;
  creditRoles: string[];
}

/** The paper whose next version the form builds. */
export interface NewVersionPaper {
  /** `sch:xxxx-xxxx-xxxx`; the spelling the node canonicalises, or `""`. */
  shortId: string;
  /** cid of the `paper.genesis` record: what `body.paper` must name. */
  paperCid: string;
  /** cid of the latest listed `paper.version` record: what `prev` must name. */
  versionCid: string;
  /** The latest version's number, from 1. The new version is `n + 1`. */
  n: number;
  title: string;
  abstract: string;
  categories: string[];
  licence: string;
  /** The byline, in order, carried into the new version unchanged. */
  authors: NewVersionAuthor[];
  /** cid of the manifest record whose files the new version carries over. */
  manifest: string;
}

export type NewVersionPaperErrorCode = "malformed" | "mismatch" | "no-manifest";

/** The paper could not be read as something a new version can extend. */
export class NewVersionPaperError extends Error {
  readonly code: NewVersionPaperErrorCode;

  constructor(code: NewVersionPaperErrorCode, message: string) {
    super(message);
    this.name = "NewVersionPaperError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseByline(value: unknown): NewVersionAuthor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const authors: NewVersionAuthor[] = [];
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

/** Reads one paper through the shared API client. Public read, like every catalog read. */
export type FetchNewVersionPaper = (id: string, signal?: AbortSignal) => Promise<unknown>;

export const fetchNewVersionPaper: FetchNewVersionPaper = (id, signal) =>
  api.get<unknown>(`/papers/${encodeURIComponent(id)}`, { auth: false, signal });

/** What `GET /v1/papers/{id}` told us: which version is the one to extend. */
interface LocatedVersion {
  shortId: string;
  paperCid: string;
  versionCid: string;
  n: number;
}

function locateVersion(payload: unknown): LocatedVersion {
  if (!isRecord(payload)) {
    throw new NewVersionPaperError("malformed", "The server did not return this paper.");
  }
  const versionCid =
    text(payload.versionCid) ?? text(payload.version_cid) ?? text(payload.cid);
  const n =
    typeof payload.n === "number" && Number.isInteger(payload.n) && payload.n >= 1
      ? payload.n
      : typeof payload.version === "number" && Number.isInteger(payload.version) && payload.version >= 1
        ? payload.version
        : null;
  if (versionCid === null || n === null) {
    throw new NewVersionPaperError(
      "malformed",
      "The server's answer does not name a latest version, so there is nothing to extend.",
    );
  }
  return {
    shortId: text(payload.shortId) ?? text(payload.short_id) ?? text(payload.paper) ?? "",
    paperCid: text(payload.paperCid) ?? text(payload.paper_cid) ?? "",
    versionCid,
    n,
  };
}

/** Computes a record's id from its envelope; verify-core's `computeRecordId`. */
const defaultRecordId: ComputeRecordId = async (envelope) => {
  const core = await import("../verify-core");
  return core.computeRecordId(envelope);
};

function paperFromEnvelope(envelope: unknown, located: LocatedVersion): NewVersionPaper {
  if (!isRecord(envelope) || envelope.type !== NEW_VERSION_RECORD_TYPE || !isRecord(envelope.body)) {
    throw new NewVersionPaperError(
      "malformed",
      "The server's latest version is not a version record, so it cannot be extended here.",
    );
  }
  const body = envelope.body;
  const signedPaper = text(body.paper);
  if (signedPaper !== null && located.paperCid !== "" && signedPaper !== located.paperCid) {
    throw new NewVersionPaperError(
      "mismatch",
      "The server's records for this paper disagree, so nothing is shown. Do not sign anything for it.",
    );
  }
  const manifest = text(body.manifest);
  if (manifest === null) {
    // A paper.version without a manifest cannot be built: the schema requires one.
    throw new NewVersionPaperError(
      "no-manifest",
      "The latest version does not name its files, so a new version cannot carry them over.",
    );
  }
  return {
    shortId: located.shortId,
    paperCid: located.paperCid !== "" ? located.paperCid : (signedPaper ?? ""),
    versionCid: located.versionCid,
    n: located.n,
    title: typeof body.title === "string" ? body.title.trim() : "",
    abstract: typeof body.abstract === "string" ? body.abstract.trim() : "",
    categories: Array.isArray(body.categories)
      ? body.categories.filter((category): category is string => typeof category === "string")
      : [],
    licence: text(body.licence) ?? "",
    authors: parseByline(body.authors),
    manifest,
  };
}

export interface LoadNewVersionOptions {
  fetchPaper?: FetchNewVersionPaper;
  fetchRecord?: FetchRecord;
  recordId?: ComputeRecordId;
  signal?: AbortSignal;
}

export type LoadNewVersion = (
  id: string,
  options?: { signal?: AbortSignal },
) => Promise<NewVersionPaper>;

/**
 * Reads the paper and the record its latest version signed, checked against its
 * id. What the form pre-fills from is what that cid commits to, whatever the
 * server says — the same rule `/consent` signs under.
 */
export async function loadNewVersionPaper(
  id: string,
  options: LoadNewVersionOptions = {},
): Promise<NewVersionPaper> {
  const fetchPaper = options.fetchPaper ?? fetchNewVersionPaper;
  const fetcher = options.fetchRecord ?? fetchRecord;
  const recordId = options.recordId ?? defaultRecordId;
  const { signal } = options;

  const located = locateVersion(await fetchPaper(id, signal));
  const envelope = await fetcher(located.versionCid, signal);

  let actual: string | null = null;
  try {
    actual = await recordId(envelope);
  } catch {
    // An envelope that cannot be hashed cannot be vouched for either.
  }
  if (actual !== located.versionCid) {
    throw new NewVersionPaperError(
      "mismatch",
      "The server sent a version record that does not match the one it listed, so it is not shown. Do not sign anything for it.",
    );
  }
  return paperFromEnvelope(envelope, located);
}

/** A sentence for the author when the paper could not be loaded. */
export function newVersionLoadErrorMessage(error: unknown): string {
  if (error instanceof NewVersionPaperError) {
    return error.message;
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This node has no listed version of that paper, so there is no new version to write for it here.";
  }
  if (error instanceof ApiError && error.status === 422) {
    return "That is not a valid paper address.";
  }
  if (error instanceof NetworkError) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return "The paper could not be loaded. Try again in a moment.";
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** What the form collects: the details, pre-filled, and the required note. */
export interface NewVersionDraft {
  details: DetailsValues;
  changeNote: string;
}

/**
 * The pre-filled form: the title, abstract, categories and licence the latest
 * version signed. The licence falls back to the default only when the version
 * named none, so an author never quietly changes what they cannot see.
 */
export function draftFromPaper(paper: NewVersionPaper): NewVersionDraft {
  return {
    details: {
      title: paper.title,
      abstract: paper.abstract,
      categories: [...paper.categories],
      licence: paper.licence === "" ? DEFAULT_LICENCE_ID : paper.licence,
    },
    changeNote: "",
  };
}

/** What still stands in the way of signing, in the order the author should fix it. */
export function newVersionBlockers(draft: NewVersionDraft): string[] {
  const blockers = [...detailsBlockers(draft.details)];
  const note = draft.changeNote;
  if (note.trim() === "") {
    blockers.push("Say what changed in this version.");
  } else if (note.length > CHANGE_NOTE_MAX) {
    blockers.push(`Shorten the change note to ${CHANGE_NOTE_MAX} characters or fewer.`);
  }
  return blockers;
}

/** True when the form is complete enough to sign. */
export function canSignNewVersion(draft: NewVersionDraft): boolean {
  return newVersionBlockers(draft).length === 0;
}

/** The byline the signed record lists: as the previous version listed it, tightly renumbered. */
export function recordAuthorEntries(authors: readonly NewVersionAuthor[]): RecordAuthor[] {
  return [...authors]
    .sort((a, b) => a.position - b.position)
    .map((author, index) => ({
      did: author.did,
      ...(author.name !== null ? { name: author.name } : {}),
      ...(author.orcid !== null ? { orcid: author.orcid } : {}),
      creditRoles: [...author.creditRoles],
      position: index + 1,
    }));
}

/** The byline as `DraftAuthor[]`, so the status tracker can show it (and mark you). */
export function bylineAsDraft(authors: readonly NewVersionAuthor[], ownDid: string | null): DraftAuthor[] {
  return [...authors]
    .sort((a, b) => a.position - b.position)
    .map((author) => ({
      key: author.did,
      kind: "did" as const,
      identifier: author.did,
      did: author.did,
      name: author.name ?? "",
      orcid: author.orcid,
      creditRoles: [...author.creditRoles],
      isSubmitter: ownDid !== null && author.did === ownDid,
      match: "matched" as const,
    }));
}

/**
 * The `paper.version` body this form signs: the paper's genesis cid, the next
 * number, the edited details, the carried byline and manifest, and the note.
 */
export function newVersionBody(
  paper: NewVersionPaper,
  draft: NewVersionDraft,
  authors: readonly NewVersionAuthor[] = paper.authors,
): Record<string, unknown> {
  return {
    paper: paper.paperCid,
    n: paper.n + 1,
    title: draft.details.title,
    abstract: draft.details.abstract,
    authors: recordAuthorEntries(authors),
    manifest: paper.manifest,
    licence: draft.details.licence,
    changeNote: draft.changeNote.trim(),
    categories: draft.details.categories,
  };
}

// ---------------------------------------------------------------------------
// Signing it
// ---------------------------------------------------------------------------

/** Signs a record behind a passkey prompt; `signRecord` from web-auth by default. */
export type SignVersionRecord = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
) => Promise<SignedRecord>;

/** What the server answers to `POST /v1/records`. */
export interface VersionRecordAccepted {
  id?: string;
  state?: string;
}

/** Submits a signed record; `POST /v1/records` by default. */
export type SubmitVersionRecord = (record: SignedRecord) => Promise<VersionRecordAccepted>;

const defaultSubmit: SubmitVersionRecord = (record) => api.post<VersionRecordAccepted>("/records", record);

export interface SubmitNewVersionOptions {
  paper: NewVersionPaper;
  draft: NewVersionDraft;
  sign?: SignVersionRecord;
  submit?: SubmitVersionRecord;
}

export interface NewVersionSubmitted {
  /** The new version's record cid. */
  versionId: string;
  /** The new version's number. */
  n: number;
}

/** The signer came back with a record that is not the one this form asked for. */
export class WrongRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongRecordError";
  }
}

/**
 * Signs the next `paper.version` and submits it.
 *
 * `prev` is the cid of the paper's latest version (and `n` is one more), which
 * is the only pair the API's chain check accepts; both are checked on the
 * signed record before anything is sent, so a broken signer fails here rather
 * than forking the paper's timeline on the server.
 *
 * @throws {WrongRecordError} the signed record is not the version asked for; nothing is sent.
 */
export async function submitNewVersion({
  paper,
  draft,
  sign = signRecord,
  submit = defaultSubmit,
}: SubmitNewVersionOptions): Promise<NewVersionSubmitted> {
  const prev = paper.versionCid;
  const signed = await sign(NEW_VERSION_RECORD_TYPE, newVersionBody(paper, draft), prev);
  if (signed.type !== NEW_VERSION_RECORD_TYPE) {
    throw new WrongRecordError(
      `The signer produced a ${signed.type} record, not a ${NEW_VERSION_RECORD_TYPE}.`,
    );
  }
  if (signed.prev !== prev) {
    throw new WrongRecordError(
      "The signer produced a record that does not name the latest version as its prev.",
    );
  }
  const accepted = await submit(signed);
  return { versionId: accepted.id ?? signed.id, n: paper.n + 1 };
}

// ---------------------------------------------------------------------------
// Failures, in words
// ---------------------------------------------------------------------------

/** What went wrong signing, in words, and what the author can do about it. */
export interface NewVersionFailure {
  message: string;
  /** An expired session is the problem; offer to sign in again. */
  signIn: boolean;
  /**
   * Another version landed first. The form holds a stale `prev`, so the fix is
   * to load the paper again, not to retry the same record.
   */
  staleChain: boolean;
}

export function describeNewVersionError(error: unknown): NewVersionFailure {
  if (isPasskeyCancellation(error)) {
    return {
      message: "Signing was cancelled, so nothing was sent. Sign again when you are ready.",
      signIn: false,
      staleChain: false,
    };
  }
  if (error instanceof WrongRecordError) {
    return { message: `${error.message} Nothing was sent.`, signIn: false, staleChain: false };
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
      staleChain: false,
    };
  }
  if (isRecordSigningError(error)) {
    return {
      message: "Could not prepare the version record. Nothing was sent.",
      signIn: false,
      staleChain: false,
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        message: "Your session has ended. Sign in again, then come back to this page.",
        signIn: true,
        staleChain: false,
      };
    }
    if (error.status === 403) {
      return {
        message:
          "The server says this account may not publish a version of this paper, so nothing was sent.",
        signIn: false,
        staleChain: false,
      };
    }
    if (error.status === 409) {
      // The chain check: this form's prev was superseded while it was open.
      return {
        message:
          error.type === VERSION_OUT_OF_SEQUENCE_TYPE
            ? "Another version of this paper has landed since this form was opened, so this one was not sent. Load the paper again to extend the new latest version."
            : `The server did not accept the version: ${error.detail}`,
        signIn: false,
        staleChain: true,
      };
    }
    if (error.status === 422) {
      return {
        message: `The server did not accept the record: ${error.detail}`,
        signIn: false,
        staleChain: false,
      };
    }
    return {
      message: "The server could not take the version just now. Try again in a moment.",
      signIn: false,
      staleChain: false,
    };
  }
  if (error instanceof NetworkError) {
    return {
      message:
        "Could not reach the server, so nothing was confirmed. Check your connection and try again.",
      signIn: false,
      staleChain: false,
    };
  }
  return {
    message: "Something went wrong, and the version was not sent. Try again.",
    signIn: false,
    staleChain: false,
  };
}
