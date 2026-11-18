/**
 * The paper behind a 404: what the public record log says about it.
 *
 * `/p/{id}` is rendered on the server, and the server holds no token (the
 * access token lives in browser memory only), so `GET /v1/papers/{id}` — the
 * public catalog — answers `404` for a version that is in moderation, held
 * before listing, awaiting co-author consent, or removed by a tombstone. For
 * the paper's author that 404 is wrong: the API serves the same version's
 * text, checks and files to its authors and to moderators with their bearer
 * token. This module joins the reads the retry needs:
 *
 * | Read | Token | Gives |
 * | --- | --- | --- |
 * | `GET /v1/export/paper/{id}/records` | no | the signed records: version, manifest, decisions |
 * | `GET /v1/papers/{id}/v/{n}/consents` | no | the version's lifecycle `state`, the consent rows |
 * | `GET /v1/papers/{id}/v/{n}/text` | **yes** | the paragraphs; also *who* may read (see below) |
 * | `GET /v1/records/{manifest cid}` | no | the file list, and the PDF's cid |
 *
 * The text read is the gate: the API answers `200` to an author or a
 * moderator, the unknown-version `404` to everyone else, and `451` when a
 * takedown removed the content — the same answers `GET /v1/content/{cid}`
 * gives. Nothing here decides access itself; it reads what the node decided.
 *
 * Pure joins plus four loaders (injectable, like every data module here), so
 * the route, the client island and vitest share one reading of the log.
 */

import { api, type ApiClient } from "../../lib/api";
import { contentUrl } from "../paper-meta/meta";
import { fetchConsents, type ConsentReport } from "../submit/consents";
import { deriveShortId } from "../verify-core";
import type { IconName } from "../ui-kit";
import { formatDate as formatReaderDate } from "../ui-kit/format-date";
import { loadReadingText, type ReadingText } from "./reading";

/** The sentence for an id this node does not list (matches `describePaperError`'s 404). */
export const PAPER_NOT_LISTED = "No paper with that id is listed on this node.";

/** `GET`-only slice of the API client, so tests need no network stack. */
export type RecordsClient = Pick<ApiClient, "get">;

/* -------------------------------------------------------------------------- */
/* The records the log holds                                                   */
/* -------------------------------------------------------------------------- */

/** One author as the signed version record lists them. */
export interface UnlistedAuthor {
  /** The author's `did:` identifier. */
  readonly did: string;
  /** 1-based byline position, `0` when the record named none. */
  readonly position: number;
  /** CRediT roles the signed version names. */
  readonly creditRoles: readonly string[];
}

/** One version of the paper, read from its signed `paper.version` record. */
export interface UnlistedVersion {
  /** Version number, 1-based, as the record signed it. */
  readonly n: number;
  /** cid of the `paper.version` record. */
  readonly versionCid: string;
  /** cid of the paper's `paper.genesis` record, when the body names it. */
  readonly paperCid: string | null;
  /** `sch:xxxx-xxxx-xxxx` derived from the genesis cid; `null` if underivable. */
  readonly shortId: string | null;
  readonly title: string;
  readonly abstract: string;
  /** The byline in signed order. */
  readonly authors: readonly UnlistedAuthor[];
  readonly categories: readonly string[];
  /** The licence the signed version names. */
  readonly licence: string | null;
  /** cid of the signed `manifest` record, when the body names it. */
  readonly manifestCid: string | null;
}

/** One `moderation.decision` about the paper, as the public log holds it. */
export interface ModerationFact {
  /** cid of the decision record (`GET /v1/records/{cid}` serves it). */
  readonly decisionCid: string;
  /** The action the decision took (`list`, `hold`, `reject`, `tombstone`…). */
  readonly action: string;
  /** The policy clause the decision cited, when it named one. */
  readonly clause: string | null;
  /** The reason the moderator wrote for the authors. */
  readonly reason: string | null;
  /** When the node received the decision (ISO), when it says. */
  readonly decidedAt: string | null;
}

/** The removal facts of a tombstoned paper (design.md §8's tombstone state). */
export interface TombstoneFacts {
  /** cid of the `moderation.decision` that took the content down. */
  readonly decisionCid: string | null;
  /** The policy clause the takedown cited (MOD-05), when it named one. */
  readonly clause: string | null;
  /** The legal reason the decision signed, when it wrote one. */
  readonly reason: string | null;
  /** The removal date as design.md writes it (`4 May 2027`), when known. */
  readonly removedOn: string | null;
  /** The paper's title, so the marker names what was removed. */
  readonly title: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readWholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const text = readText(item);
    if (text !== null) {
      seen.add(text);
    }
  }
  return [...seen];
}

function readAuthor(value: unknown): UnlistedAuthor | null {
  // A bare DID string is still an author: a newer or older node must not
  // silently drop a byline (the same courtesy `parseAuthor` pays).
  if (typeof value === "string") {
    const did = readText(value);
    return did === null ? null : { did, position: 0, creditRoles: [] };
  }
  if (!isRecord(value)) {
    return null;
  }
  const did = readText(value.did) ?? readText(value.author);
  if (did === null) {
    return null;
  }
  return {
    did,
    position: readWholeNumber(value.position) ?? 0,
    creditRoles: readTextList(value.creditRoles ?? value.credit_roles),
  };
}

/** The `sch:` id of a genesis cid, or `null` when it is not one. */
function shortIdOf(paperCid: string | null): string | null {
  if (paperCid === null) {
    return null;
  }
  try {
    return deriveShortId(paperCid);
  } catch {
    // A genesis id this app cannot derive still names a paper; only the
    // friendly `sch:` spelling is lost, and the caller falls back to the URL's.
    return null;
  }
}

/** The record's cid: the wire entry's own field, else its body's id. */
function cidOf(item: Record<string, unknown>): string | null {
  return readText(item.record_cid) ?? readText(item.id);
}

/**
 * The version to show: the one the address names, else the newest the log
 * holds. `null` when the log holds no `paper.version` at all — there is no
 * paper to retry for, and the not-found page stands.
 */
export function pickUnlistedVersion(
  entries: readonly unknown[],
  version: number | null,
): UnlistedVersion | null {
  let picked: { seq: number; n: number; item: Record<string, unknown>; body: Record<string, unknown> } | null =
    null;

  for (const raw of entries) {
    if (!isRecord(raw) || readText(raw.record_type) !== "paper.version") {
      continue;
    }
    const body = isRecord(raw.body) ? raw.body : null;
    if (body === null) {
      continue;
    }
    const n = readWholeNumber(body.n) ?? readWholeNumber(body.version);
    if (n === null) {
      continue;
    }
    if (version !== null && n !== version) {
      continue;
    }
    const seq =
      typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0;
    if (picked !== null && seq <= picked.seq) {
      continue;
    }
    picked = { seq, n, item: raw, body };
  }

  if (picked === null) {
    return null;
  }
  const { n, item, body } = picked;
  const authors = Array.isArray(body.authors)
    ? body.authors
        .map(readAuthor)
        .filter((author): author is UnlistedAuthor => author !== null)
    : [];
  const paperCid = readText(body.paper);
  return {
    n,
    versionCid: cidOf(item) ?? `v${n}`,
    paperCid,
    shortId: shortIdOf(paperCid),
    title: readText(body.title) ?? "Untitled",
    abstract: typeof body.abstract === "string" ? body.abstract : "",
    authors,
    categories: readTextList(body.categories),
    licence: readText(body.licence ?? body.license),
    manifestCid: readText(body.manifest),
  };
}

/** The cid of every `paper.version` record in the log. */
function versionCidsOf(entries: readonly unknown[]): Set<string> {
  const cids = new Set<string>();
  for (const raw of entries) {
    if (isRecord(raw) && readText(raw.record_type) === "paper.version") {
      const cid = cidOf(raw);
      if (cid !== null) {
        cids.add(cid);
      }
    }
  }
  return cids;
}

/**
 * The decision that stands: the highest-`seq` `moderation.decision` in the log
 * (the same rule `latestAppealableDecision` applies — a later `list` or
 * `release` supersedes an earlier hold). `null` when none was recorded.
 *
 * The node tracks decisions per target, so a page that is *about one version*
 * passes that version's cid: a decision aimed at a different version of the
 * paper is left out (v1's takedown must not label a held v2). A decision aimed
 * at the paper or at one of its files has no version to compare and is kept.
 */
export function latestDecision(
  entries: readonly unknown[],
  versionCid: string | null = null,
): ModerationFact | null {
  let latest: ModerationFact & { seq: number } | null = null;
  const otherVersions =
    versionCid === null
      ? new Set<string>()
      : versionCidsOf(entries);

  for (const raw of entries) {
    if (!isRecord(raw) || readText(raw.record_type) !== "moderation.decision") {
      continue;
    }
    const body = isRecord(raw.body) ? raw.body : null;
    const cid = cidOf(raw);
    const action = body === null ? null : readText(body.action);
    if (body === null || cid === null || action === null) {
      continue;
    }
    const target = readText(body.target);
    if (target !== null && target !== versionCid && otherVersions.has(target)) {
      continue;
    }
    const seq =
      typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0;
    if (latest !== null && seq < latest.seq) {
      continue;
    }
    latest = {
      seq,
      decisionCid: cid,
      action,
      clause: readText(body.clause),
      reason: readText(body.reason),
      decidedAt: readText(raw.received_at ?? raw.receivedAt),
    };
  }

  if (latest === null) {
    return null;
  }
  const { seq: _seq, ...decision } = latest;
  return decision;
}

/**
 * The removal facts when the standing decision is a takedown, else `null`.
 *
 * A `tombstone` deletes the version's files and denylists their cids, and the
 * version leaves the catalog — which is why the paper read 404'd. That the
 * content was removed, when, and under which policy, is public: the decision
 * is a signed record in the public log (NET-5 keeps the record verifiable).
 */
export function tombstoneOf(
  entries: readonly unknown[],
  version: number | null = null,
): TombstoneFacts | null {
  // The version the page is about: the one the address names, else the newest.
  const picked = pickUnlistedVersion(entries, version);
  if (version !== null && picked === null) {
    return null; // the log holds no such version: nothing of it was removed.
  }
  const decision = latestDecision(entries, picked?.versionCid ?? null);
  if (decision === null || decision.action !== "tombstone") {
    return null;
  }
  return {
    decisionCid: decision.decisionCid,
    clause: decision.clause,
    reason: decision.reason,
    removedOn: formatRemovalDate(decision.decidedAt),
    title: picked?.title ?? null,
  };
}

/**
 * The removal date as design.md writes it (`4 May 2027`), in the reader's own
 * time zone through the shared `ui-kit` formatter: the standoff banner must
 * name the day the reader's own clock knows (bug_spec_verify12 bug 2).
 */
export function formatRemovalDate(iso: string | null): string | null {
  return formatReaderDate(iso, { month: "long" });
}

/* -------------------------------------------------------------------------- */
/* The status banner                                                           */
/* -------------------------------------------------------------------------- */

/** How the banner reads: an icon and a tone reinforce the word, never replace it. */
export interface UnlistedBanner {
  /** The banner's word: `In moderation`, `Held from listing`, … */
  readonly label: string;
  /** The sentence under the word: the decision's own reason when there is one. */
  readonly detail: string;
  /** `pending` while the paper waits, `critical` for a refusal, `neutral` for a fact. */
  readonly tone: "neutral" | "pending" | "critical";
  /** A different silhouette per state, so colour is never the only signal. */
  readonly icon: IconName;
  /** The standing decision, so the banner can link to its record and clause. */
  readonly decision: ModerationFact | null;
}

/** The appeal sentence design.md §8 gives an author whose paper was refused. */
const APPEAL_ONCE = "You can appeal once.";

/** The detail under the word: the moderator's reason, closed and with the appeal. */
function refusalDetail(reason: string | null): string {
  const base =
    reason !== null && reason.trim() !== ""
      ? `${reason.trim().replace(/[.!?…]*$/, "")}.`
      : null;
  return base === null ? APPEAL_ONCE : `${base} ${APPEAL_ONCE}`;
}

/**
 * Where the version stands, in one banner.
 *
 * The standing decision wins when it refused the paper (hold, reject, delist):
 * its reason is the author's to read, verbatim, with the appeal sentence
 * design.md §8 promises. Otherwise the version's lifecycle `state` — the
 * consent report's public `state` field — says which pre-listing stage the
 * paper is in. Nothing known is the honest "Not listed yet".
 */
export function unlistedBanner(
  state: string | null | undefined,
  decision: ModerationFact | null,
): UnlistedBanner {
  const action = decision?.action ?? null;

  if (action === "hold" || (action === null && state === "held")) {
    return {
      label: "Held from listing",
      detail: refusalDetail(decision?.reason ?? null),
      tone: "pending",
      icon: "alert",
      decision,
    };
  }
  if (action === "reject" || (action === null && state === "rejected")) {
    return {
      label: "Not listed",
      detail: refusalDetail(decision?.reason ?? null),
      tone: "critical",
      icon: "ban",
      decision,
    };
  }
  if (action === "delist") {
    return {
      label: "Removed from the catalog",
      detail: refusalDetail(decision?.reason ?? null),
      tone: "critical",
      icon: "ban",
      decision,
    };
  }
  if (state === "awaiting_consent") {
    return {
      label: "Awaiting co-author consent",
      detail:
        "Every co-author must accept authorship before the paper is checked and listed.",
      tone: "pending",
      icon: "pending",
      decision: action === null ? null : decision,
    };
  }
  if (state === "moderation") {
    return {
      label: "In moderation",
      detail:
        "A moderator is reviewing this version. The checks report below is advisory.",
      tone: "neutral",
      icon: "eye",
      decision: action === null ? null : decision,
    };
  }
  if (state === "scanning") {
    return {
      label: "Checks are running",
      detail: "The node is scanning this version's files.",
      tone: "neutral",
      icon: "circle",
      decision: action === null ? null : decision,
    };
  }
  if (state === "draft") {
    return {
      label: "Draft",
      detail: "This version has not been signed and submitted for listing.",
      tone: "neutral",
      icon: "circle",
      decision: action === null ? null : decision,
    };
  }
  return {
    label: "Not listed yet",
    detail: "This version is not listed on this node.",
    tone: "neutral",
    icon: "circle",
    decision: action === null ? null : decision,
  };
}

/* -------------------------------------------------------------------------- */
/* The PDF behind the signed manifest                                          */
/* -------------------------------------------------------------------------- */

/** The PDF of an unlisted version: where the node serves it, and its name. */
export interface UnlistedPdf {
  /** The file's name in the manifest, `paper.pdf`. */
  readonly name: string;
  /** `GET /v1/content/{cid}` on this node. */
  readonly url: string;
}

function isPdfFile(entry: {
  readonly path: string;
  readonly mediaType: string | null;
}): boolean {
  return (
    entry.mediaType?.toLowerCase() === "application/pdf" ||
    entry.path.toLowerCase().endsWith(".pdf")
  );
}

/**
 * The PDF a signed `manifest` record lists: the manuscript if it is a PDF,
 * else the first PDF. `null` when the record is not a manifest or lists none.
 * (The paper page's twin of the moderation console's `parseManifestPdf`; the
 * catalog's manifest route lists listed versions only, so the record is where
 * an unlisted version's files are named.)
 */
export function parseManifestPdf(payload: unknown): UnlistedPdf | null {
  const files =
    isRecord(payload) && isRecord(payload.body) && Array.isArray(payload.body.files)
      ? payload.body.files
      : null;
  if (files === null) {
    return null;
  }
  const pdfs = files
    .map((file): { path: string; cid: string; role: string | null; mediaType: string | null } | null => {
      if (!isRecord(file)) {
        return null;
      }
      const path = readText(file.path);
      const cid = readText(file.cid);
      if (path === null || cid === null) {
        return null;
      }
      return {
        path,
        cid,
        role: readText(file.role),
        mediaType: readText(file.mediaType ?? file.media_type ?? file.mediatype),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null && isPdfFile(entry));
  const pdf = pdfs.find((entry) => entry.role === "manuscript") ?? pdfs[0];
  return pdf === undefined
    ? null
    : { name: pdf.path, url: contentUrl(pdf.cid) };
}

/**
 * Read the version's PDF from its signed manifest record.
 *
 * The record is public (it is the signed ledger entry), so no token is sent.
 * A manifest that cannot be read, or names no PDF, is `null` — never an error:
 * the PDF is one part of the page, not the page.
 */
export async function loadUnlistedPdf(
  manifestCid: string | null,
  client: RecordsClient = api,
): Promise<UnlistedPdf | null> {
  if (manifestCid === null) {
    return null;
  }
  try {
    const payload = await client.get<unknown>(
      `/records/${encodeURIComponent(manifestCid)}`,
      { auth: false, cache: "no-store" },
    );
    return parseManifestPdf(payload);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The loaders the retry makes                                                 */
/* -------------------------------------------------------------------------- */

/** Everything the hydrated retry reads, injectable for tests. */
export interface AccessLoaders {
  /** The paper's public record log. */
  records(paperId: string): Promise<readonly unknown[]>;
  /** The version's text, with the signed-in reader's token: the access gate. */
  text(paperId: string, version: number): Promise<ReadingText>;
  /** The version's consent report and lifecycle state (public). */
  consents(paperId: string, version: number): Promise<ConsentReport>;
}

/**
 * Read the paper's records from `GET /v1/export/paper/{id}/records`.
 *
 * The export resolves the paper from the signed log even when no catalog row
 * lists it, which is exactly the paper behind the 404. Public read: no token,
 * nothing cached — a decision made a moment ago changes the answer.
 */
export async function loadPaperRecords(
  paperId: string,
  client: RecordsClient = api,
): Promise<readonly unknown[]> {
  const payload = await client.get<unknown>(
    `/export/paper/${encodeURIComponent(paperId.trim())}/records`,
    { auth: false, cache: "no-store" },
  );
  return Array.isArray(payload) ? payload : [];
}

/** The real reads: the records and consent report go out anonymously, the text with the reader's token. */
export const DEFAULT_ACCESS_LOADERS: AccessLoaders = {
  records: (paperId) => loadPaperRecords(paperId),
  text: (paperId, version) => loadReadingText(paperId, version),
  consents: (paperId, version) => fetchConsents({ paper: paperId, version }),
};

/** What the retry assembled for the version an author or moderator may read. */
export interface AccessView {
  /** The version, from its signed record. */
  readonly version: UnlistedVersion;
  /** Where the version stands, in one banner. */
  readonly banner: UnlistedBanner;
  /** The consent report (its `state` chose the banner), when it could be read. */
  readonly consents: ConsentReport | null;
  /** The version's paragraphs, already read with the reader's token. */
  readonly text: ReadingText;
}
