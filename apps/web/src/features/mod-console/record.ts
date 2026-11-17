/**
 * Any record a member can flag, read as the moderator's decision item.
 *
 * A flag may name a paper version, a discussion post, an inline annotation or
 * a review (`apps/api/src/app/modules/flags`), but a moderation decision is
 * recorded against the flagged record itself. `/mod/{cid}` therefore loads a
 * *record* — `GET /v1/records/{cid}`, the public signed envelope — and only
 * hands it to the paper-version reader when the envelope really is one
 * (`parseVersionRecord`). Everything else is shown as what it is: the author's
 * pseudonymous DID, the text (or quoted passage) that was flagged, and the
 * paper the record belongs to, with a link.
 *
 * The owning paper is resolved from the record itself where it names one
 * (`body.paper`, a `paper.genesis` target) and, for a review or a post whose
 * target is a version, by reading that version's record. A record whose paper
 * cannot be resolved still appears — a gap in what the node holds is never a
 * reason to hide a flag from the moderator — with the paper link omitted.
 *
 * Pure data and functions apart from the two default loaders, so the detail
 * view, the flag cards and vitest all share the same reader.
 */

import { api, type ApiClient } from "../../lib/api";
import { deriveShortId } from "../verify-core";
import {
  RECORDS_ENDPOINT,
  parseVersionRecord,
  type ModeratedPaper,
} from "./decision";
import { isRecord, readText } from "./wire";

/** Record types a member may flag, as the decision view shows them. */
export const DISCUSSION_POST_TYPE = "discussion.post";
export const PAPER_GENESIS_TYPE = "paper.genesis";
export const PAPER_VERSION_TYPE = "paper.version";
export const REVIEW_FORMAL_TYPE = "review.formal";
export const REVIEW_COMMIT_TYPE = "review.commit";
export const REVIEW_RESPONSE_TYPE = "review.response";
export const REVIEW_RATING_TYPE = "review.rating";

/** Anything that can read a stored envelope; the shared client by default. */
export type RecordClient = Pick<ApiClient, "get">;

/** The biggest excerpt a flag card shows; longer text ends in an ellipsis. */
export const EXCERPT_LIMIT = 160;

/** One flaggable record as the moderation console reads it. */
export interface ModeratedRecord {
  /** The record's id (`GET /v1/records/{cid}`). */
  readonly cid: string;
  /** The signed type: `discussion.post`, `review.formal`, … */
  readonly type: string;
  /** The signing author's DID; empty only for an unreadable envelope. */
  readonly authorDid: string;
  /** The signer's ISO 8601 timestamp, when the envelope carries one. */
  readonly created: string | null;
  /** A title the record itself carries (a paper's title); `null` otherwise. */
  readonly title: string | null;
  /** The paper's genesis cid, when it can be resolved. */
  readonly paperCid: string | null;
  /** `sch:xxxx-xxxx-xxxx` of the owning paper, when it can be derived. */
  readonly paperShortId: string | null;
  /** The owning paper's title, from its genesis record. */
  readonly paperTitle: string | null;
  /** The version the record belongs to, when one is named. */
  readonly versionCid: string | null;
  /** `sch:…/vN`, when both the paper and the version number are known. */
  readonly versionId: string | null;
  /** The text a moderator reads: a post, a review report or an abstract. */
  readonly text: string | null;
  /** The quoted paragraph of an annotation, when the anchor carries one. */
  readonly quote: string | null;
  /**
   * The public reviewer label of a `review.formal` ("Reviewer A"), when the
   * reviews listing serves one. A review is signed by a pseudonymous per-paper
   * key, so this -- never that key's DID -- is how its author is named.
   */
  readonly reviewerLabel?: string | null;
  /** The record this one is about (a post's or review's target). */
  readonly targetCid: string | null;
  /** The stored body, kept for the type-specific readers. */
  readonly body: Readonly<Record<string, unknown>>;
}

/** Raised when `GET /v1/records/{cid}` did not return a readable record. */
export class RecordReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordReadError";
  }
}

/** The paper version a moderator decides as before, or any other record. */
export type ModerationItem =
  | { readonly kind: "paper"; readonly paper: ModeratedPaper }
  | { readonly kind: "record"; readonly record: ModeratedRecord };

/** Reads one moderation item; replaceable in tests. */
export type LoadItem = (cid: string) => Promise<ModerationItem>;

/**
 * A short description of what a flag is about, for a flag card in `/mod`.
 *
 * The list endpoint names only the flagged cid, so the card reads the record
 * and the paper it belongs to; everything optional degrades to `null` rather
 * than hiding the card.
 */
export interface FlagTargetSummary {
  readonly cid: string;
  /** The signed record type (`discussion.post`, `paper.version`, …). */
  readonly type: string;
  /** What the type is called in words: "Discussion post", "Review", … */
  readonly typeLabel: string;
  /** The owning paper's title, when it can be read. */
  readonly paperTitle: string | null;
  /** The paper page, when the owning paper is known. */
  readonly paperHref: string | null;
  /** The first words of what was flagged. */
  readonly excerpt: string | null;
}

/** Loads a flag target's summary; replaceable in tests. */
export type LoadFlagTarget = (cid: string) => Promise<FlagTargetSummary>;

/** True when the record is an inline annotation rather than a thread post. */
export function isAnnotation(record: ModeratedRecord): boolean {
  if (record.type !== DISCUSSION_POST_TYPE) {
    return false;
  }
  const anchor = record.body.anchor;
  return (
    isRecord(anchor) &&
    (readText(anchor.quote) !== null ||
      readText(anchor.paragraph_id) !== null ||
      readText(anchor.paragraphId) !== null)
  );
}

/** What a record type is called in the console; never a raw record type. */
export function recordKindLabel(record: ModeratedRecord): string {
  switch (record.type) {
    case DISCUSSION_POST_TYPE:
      return isAnnotation(record) ? "Annotation" : "Discussion post";
    case REVIEW_FORMAL_TYPE:
      return "Review";
    case REVIEW_COMMIT_TYPE:
      return "Sealed review";
    case REVIEW_RESPONSE_TYPE:
      return "Review response";
    case REVIEW_RATING_TYPE:
      return "Review rating";
    case PAPER_GENESIS_TYPE:
      return "Paper";
    case PAPER_VERSION_TYPE:
      return "Paper version";
    default:
      return humanizeType(record.type);
  }
}

/** A short noun for messages: "post", "annotation", "review", "record". */
export function recordNoun(record: ModeratedRecord): string {
  switch (record.type) {
    case DISCUSSION_POST_TYPE:
      return isAnnotation(record) ? "annotation" : "post";
    case REVIEW_FORMAL_TYPE:
    case REVIEW_COMMIT_TYPE:
    case REVIEW_RESPONSE_TYPE:
    case REVIEW_RATING_TYPE:
      return "review";
    case PAPER_GENESIS_TYPE:
    case PAPER_VERSION_TYPE:
      return "paper";
    default:
      return "record";
  }
}

/** A heading for the record's pane. */
export function recordHeading(record: ModeratedRecord): string {
  if (
    (record.type === PAPER_GENESIS_TYPE || record.type === PAPER_VERSION_TYPE) &&
    record.title !== null
  ) {
    return record.title;
  }
  return recordKindLabel(record);
}

/** `review.formal` → `Review formal`; an unknown type stays readable. */
function humanizeType(type: string): string {
  const words = type.replace(/[._-]+/g, " ").trim();
  if (words === "") {
    return "Record";
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The first `limit` characters of `text`, ending in an ellipsis when cut. */
export function excerptOf(text: string | null, limit = EXCERPT_LIMIT): string | null {
  if (text === null) {
    return null;
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") {
    return null;
  }
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** The paper page for a resolved paper, or `null` when it is not known. */
export function recordPaperHref(record: ModeratedRecord): string | null {
  return record.paperShortId === null
    ? null
    : `/p/${encodeURIComponent(record.paperShortId)}`;
}

/** The text a record type carries inline, or `null` when it carries none. */
function inlineText(type: string, body: Readonly<Record<string, unknown>>): string | null {
  switch (type) {
    case DISCUSSION_POST_TYPE:
      return readText(body.text);
    case REVIEW_FORMAL_TYPE:
      return readText(body.report);
    case REVIEW_RESPONSE_TYPE: {
      const text = readText(body.text);
      if (text !== null) {
        return text;
      }
      const items = body.items;
      if (!Array.isArray(items)) {
        return null;
      }
      const replies = items
        .map((item) =>
          typeof item === "string"
            ? readText(item)
            : isRecord(item)
              ? (readText(item.reply) ?? readText(item.text) ?? readText(item.body))
              : null,
        )
        .filter((item): item is string => item !== null);
      return replies.length === 0 ? null : replies.join("\n\n");
    }
    case REVIEW_RATING_TYPE:
      return readText(body.note);
    case PAPER_GENESIS_TYPE:
    case PAPER_VERSION_TYPE:
      return readText(body.abstract);
    default:
      return null;
  }
}

/** The title a record type carries itself, or `null`. */
function inlineTitle(type: string, body: Readonly<Record<string, unknown>>): string | null {
  if (type === PAPER_GENESIS_TYPE || type === PAPER_VERSION_TYPE) {
    return readText(body.title);
  }
  return null;
}

/** The record a body is about: a post/review target or a response's review. */
function bodyTarget(type: string, body: Readonly<Record<string, unknown>>): string | null {
  if (type === REVIEW_RESPONSE_TYPE || type === REVIEW_RATING_TYPE) {
    return readText(body.review) ?? readText(body.reviewCid);
  }
  return readText(body.target);
}

/** The quoted passage of an annotation anchor, or `null`. */
function anchorQuote(body: Readonly<Record<string, unknown>>): string | null {
  const anchor = body.anchor;
  return isRecord(anchor) ? readText(anchor.quote) : null;
}

/**
 * Validate a stored envelope into a {@link ModeratedRecord}.
 *
 * The envelope must carry an id, a type and an object body; everything else
 * degrades to `null` so an odd record still reaches the moderator. A body that
 * is not an object is read as empty rather than throwing — the record is
 * still what was flagged.
 */
export function parseRecord(payload: unknown, expectedCid?: string): ModeratedRecord {
  if (!isRecord(payload)) {
    throw new RecordReadError(
      "The server did not return a signed record for this item.",
    );
  }
  const type = readText(payload.type);
  if (type === null) {
    throw new RecordReadError("The record does not say what kind of record it is.");
  }
  const cid = readText(payload.id) ?? readText(expectedCid);
  if (cid === null) {
    throw new RecordReadError("The record has no id.");
  }
  const body = isRecord(payload.body) ? payload.body : {};
  return {
    cid,
    type,
    authorDid: readText(payload.author) ?? "",
    created: readText(payload.created),
    title: inlineTitle(type, body),
    paperCid: readText(body.paper),
    paperShortId: null,
    paperTitle: null,
    versionCid: type === PAPER_VERSION_TYPE ? cid : null,
    versionId: null,
    text: inlineText(type, body),
    quote: anchorQuote(body),
    targetCid: bodyTarget(type, body),
    body,
  };
}

/** Resolve a cid to a `sch:` short id, or `null` for a malformed id. */
function shortIdOf(cid: string | null): string | null {
  if (cid === null) {
    return null;
  }
  try {
    return deriveShortId(cid);
  } catch {
    return null;
  }
}

/** Read a record, or `null` for one this node does not hold. */
async function readRecordOrNull(
  cid: string,
  client: RecordClient,
): Promise<Record<string, unknown> | null> {
  try {
    const payload = await client.get<unknown>(
      `${RECORDS_ENDPOINT}/${encodeURIComponent(cid)}`,
      { auth: false, cache: "no-store" },
    );
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** A version number (`body.n`) as a positive integer, or `null`. */
function versionNumberOf(body: unknown): number | null {
  if (!isRecord(body)) {
    return null;
  }
  const number = body.n;
  return typeof number === "number" && Number.isInteger(number) && number >= 1
    ? number
    : null;
}

/**
 * Fill in the owning paper, its short id and title from the records we hold.
 *
 * The chain is followed from what the record names: a post's target, a
 * review's reviewed version, a response's review and then that review's
 * version, until a `paper.version` (whose `body.paper` is the genesis) or a
 * `paper.genesis` is reached. Up to four hops are followed, so a bounded
 * chain always ends even if a node holds a loop of odd records. A cid that
 * cannot be read contributes nothing: the record is still shown, only the
 * paper link is omitted, rather than deriving a short id from the wrong cid.
 */
export async function resolveOwningPaper(
  record: ModeratedRecord,
  client: RecordClient = api,
): Promise<ModeratedRecord> {
  let paperCid: string | null = null;
  let versionCid = record.versionCid;
  let versionNumber: number | null = null;
  let title = record.title;

  if (record.type === PAPER_GENESIS_TYPE) {
    paperCid = record.cid;
  }

  // The body's own `paper` may name the genesis directly (a review) or the
  // paper a version belongs to; read it first so the first hop is the one the
  // record's author meant.
  const first = record.paperCid ?? record.targetCid;
  let cursor = first;
  for (let hop = 0; hop < 4 && cursor !== null && paperCid === null; hop += 1) {
    const payload = await readRecordOrNull(cursor, client);
    if (payload === null) {
      break;
    }
    const type = readText(payload.type);
    const body = payload.body;
    if (type === PAPER_GENESIS_TYPE) {
      paperCid = cursor;
      break;
    }
    if (type === PAPER_VERSION_TYPE) {
      versionCid ??= cursor;
      versionNumber ??= versionNumberOf(body);
      title ??= isRecord(body) ? readText(body.title) : null;
      paperCid = isRecord(body) ? readText(body.paper) : null;
      break;
    }
    // A review response or rating names a review; a post names its version.
    const next = isRecord(body)
      ? (readText(body.target) ??
        readText(body.review) ??
        readText(body.reviewCid) ??
        readText(body.paper))
      : null;
    if (next === cursor) {
      break;
    }
    cursor = next;
  }

  // Only a resolved genesis yields a short id. A cid that could not be read,
  // or that turned out not to be a genesis, never produces a paper link that
  // would point at the wrong paper.
  const paperShortId = shortIdOf(paperCid);

  // The paper's title lives in its genesis record; a post or a review does not
  // carry it. A failed read leaves the title unknown, not the record hidden.
  let paperTitle =
    record.type === PAPER_GENESIS_TYPE || record.type === PAPER_VERSION_TYPE
      ? title
      : null;
  if (paperCid !== null && paperTitle === null) {
    const genesis = await readRecordOrNull(paperCid, client);
    if (genesis !== null && readText(genesis.type) === PAPER_GENESIS_TYPE) {
      paperTitle = isRecord(genesis.body) ? readText(genesis.body.title) : null;
    }
  }

  return {
    ...record,
    paperCid,
    paperShortId,
    paperTitle,
    versionCid,
    versionId:
      versionCid === null
        ? record.versionId
        : versionNumber !== null && paperShortId !== null
          ? `${paperShortId}/v${versionNumber}`
          : record.versionId,
  };
}

/**
 * The public reviewer label for a `review.formal`, from the paper's reviews
 * listing.  ``Reviewer A`` is the only name a review has: the record's author
 * is a pseudonymous per-paper key, not a person.  Any failure leaves it
 * unknown, and the console says "Anonymous reviewer" rather than show the key.
 */
async function reviewerLabelFor(
  record: ModeratedRecord,
  client: RecordClient,
): Promise<string | null> {
  const paperId = record.paperCid ?? record.paperShortId;
  if (paperId === null || paperId === "") {
    return null;
  }
  try {
    const payload = await client.get<unknown>(
      `/papers/${encodeURIComponent(paperId)}/reviews`,
      { auth: false, cache: "no-store" },
    );
    if (!isRecord(payload) || !Array.isArray(payload.reviews)) {
      return null;
    }
    for (const item of payload.reviews) {
      if (!isRecord(item)) {
        continue;
      }
      const labelled = [
        readText(item.review_cid),
        readText(item.reviewCid),
        readText(item.formal_cid),
        readText(item.id),
      ];
      if (!labelled.includes(record.cid)) {
        continue;
      }
      return (
        readText(item.label) ??
        readText(item.reviewer_label) ??
        readText(item.reviewer) ??
        null
      );
    }
  } catch {
    // A paper that is not listed (or a node without the route) has no label;
    // the review is still shown, under its anonymous word.
  }
  return null;
}

/**
 * Read any flaggable record and show it as a moderation item.
 *
 * A `paper.version` is handed to the existing paper reader so the console's
 * title, authors, abstract and PDF pane are unchanged; every other type is
 * read as a record and enriched with its owning paper.  A review also gains
 * its public reviewer label.
 */
export async function loadModerationItem(
  cid: string,
  client: RecordClient = api,
): Promise<ModerationItem> {
  const payload = await client.get<unknown>(
    `${RECORDS_ENDPOINT}/${encodeURIComponent(cid)}`,
    { auth: false, cache: "no-store" },
  );
  if (isRecord(payload) && readText(payload.type) === PAPER_VERSION_TYPE) {
    return { kind: "paper", paper: parseVersionRecord(payload, cid) };
  }
  const record = await resolveOwningPaper(parseRecord(payload, cid), client);
  if (record.type === REVIEW_FORMAL_TYPE) {
    return {
      kind: "record",
      record: { ...record, reviewerLabel: await reviewerLabelFor(record, client) },
    };
  }
  return { kind: "record", record };
}

/** Summarise a paper version's record for a flag card. */
export function summarizePaper(paper: ModeratedPaper): FlagTargetSummary {
  return {
    cid: paper.versionCid,
    type: PAPER_VERSION_TYPE,
    typeLabel: "Paper version",
    paperTitle: paper.title,
    paperHref: paper.shortId === null ? null : `/p/${encodeURIComponent(paper.shortId)}`,
    excerpt: excerptOf(paper.abstract === "" ? null : paper.abstract),
  };
}

/** Summarise any record for a flag card. */
export function summarizeRecord(record: ModeratedRecord): FlagTargetSummary {
  const paperTitle = record.paperTitle ?? record.title;
  return {
    cid: record.cid,
    type: record.type,
    typeLabel: recordKindLabel(record),
    paperTitle,
    paperHref: recordPaperHref(record),
    excerpt: excerptOf(record.text ?? record.quote),
  };
}

/** Read a flag target's type, paper title and excerpt for its card in `/mod`. */
export async function loadFlagTargetSummary(
  cid: string,
  client: RecordClient = api,
): Promise<FlagTargetSummary> {
  const item = await loadModerationItem(cid, client);
  return item.kind === "paper"
    ? summarizePaper(item.paper)
    : summarizeRecord(item.record);
}
