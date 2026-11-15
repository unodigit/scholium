/**
 * The paper page a `sch:` id redirects to (feature 184).
 *
 * A search field that receives `sch:xxxx-xxxx-xxxx` (or `…/vN`) is not asking
 * for keyword results: it is naming one paper. The search page sends the
 * reader to `/p/{id}`, and the route under `app/(search-page)/p/[...ref]`
 * renders this module's data.
 *
 * Two public reads stand behind the page:
 *
 * - `GET /v1/papers/{id}` (plugin: catalog, feature 79) answers with the
 *   shown version's title, abstract, **author DIDs**, categories, licence,
 *   status and version number.
 * - `GET /v1/profiles/{did}` (plugin: profiles, feature 29) answers with the
 *   public name, affiliation and ORCID iD behind one of those DIDs.
 *
 * The paper record itself carries only DIDs, so the Authors section is built
 * by pairing each author with their profile: the name a reader recognises
 * comes from the profile and is shown exactly as that person saved it. A
 * profile that is missing, erased or unreachable is not an error — the author
 * still appears, identified by their DID, which is the honest fallback after
 * erasure.
 *
 * Like `search.ts`, this file is pure data and functions: the server route,
 * the presentational component and vitest all use the same parse and fetch
 * logic, and every test can pass a stub client.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { parseSchId } from "./search";

/** One author as the catalog returns them, with the profile filled in. */
export interface PaperAuthor {
  /** The author's `did:` identifier. */
  readonly did: string;
  /** 1-based byline position. */
  readonly position: number;
  /** CRediT roles the signed version names. */
  readonly creditRoles: readonly string[];
  /** The public profile name, or `null` when there is none to show. */
  readonly name: string | null;
  /** The public profile affiliation, or `null`. */
  readonly affiliation: string | null;
  /** The linked ORCID iD, or `null`. */
  readonly orcid: string | null;
}

/** One notice (withdrawal, correction, retraction) on the paper. */
export interface PaperNotice {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
  readonly createdAt: string | null;
  /** Policy clause cited by a moderation decision, when the notice carries one. */
  readonly clause?: string | null;
  /** Reason category of a legal-removal notice, when the notice carries one. */
  readonly category?: string | null;
  /** Pre-formatted removal date of a legal-removal notice, when known. */
  readonly removedOn?: string | null;
}

/** Everything the paper page shows for one version. */
export interface PaperView {
  /** `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** cid of the `paper.genesis` record. */
  readonly paperCid: string;
  /** cid of the version described. */
  readonly versionCid: string;
  /** Version number, 1-based. */
  readonly n: number;
  readonly title: string;
  readonly abstract: string;
  /** Authors in byline order, each with their profile name when available. */
  readonly authors: readonly PaperAuthor[];
  readonly categories: readonly string[];
  readonly licence: string;
  readonly status: string;
  readonly notices: readonly PaperNotice[];
}

/** A paper address: a `sch:` id or record cid, plus an optional version. */
export interface PaperAddress {
  readonly id: string;
  readonly version: number | null;
}

/** The public part of a profile the Authors section uses. */
export interface AuthorProfile {
  readonly did: string;
  readonly name: string | null;
  readonly affiliation: string | null;
  readonly orcid: string | null;
}

/** A narrow interface for the shared API client, so tests can pass a stub. */
export type PaperClient = Pick<ApiClient, "get">;

/** Raised when the API answers with something that is not a paper. */
export class PaperResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return typeof value === "string" && value.trim() !== ""
      ? [value.trim()]
      : [];
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

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turn a catch-all `[…ref]` route into a paper address.
 *
 * `/p/sch:xxxx-xxxx-xxxx` and `/p/sch:xxxx-xxxx-xxxx/v2` are the shapes the
 * search page links to. A record cid is accepted too, because a search hit
 * without a short id falls back to its paper cid. Anything else is `null`.
 */
export function parsePaperRoute(
  segments: readonly string[],
): PaperAddress | null {
  if (segments.length === 0 || segments.length > 2) {
    return null;
  }
  // Next.js normally hands over decoded segments, but a hand-built link can
  // carry `%3A` for the `sch:` colon; decode once, tolerating a stray `%`.
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const rawId = decode(segments[0]);
  const rawVersion =
    segments[1] === undefined ? undefined : decode(segments[1]);
  if (rawId.trim() === "") {
    return null;
  }

  const schId = parseSchId(
    rawVersion === undefined ? rawId : `${rawId}/${rawVersion}`,
  );
  if (schId !== null) {
    return { id: schId.shortId, version: schId.version };
  }

  // Not a `sch:` id: only a single path-safe token is a plausible record id.
  if (!/^[a-z0-9]+$/i.test(rawId.trim())) {
    return null;
  }
  if (rawVersion === undefined) {
    return { id: rawId.trim(), version: null };
  }
  const version = /^v([1-9][0-9]{0,8})$/.exec(rawVersion);
  if (version === null) {
    return null;
  }
  return { id: rawId.trim(), version: Number.parseInt(version[1], 10) };
}

/** The API path that reads one address, relative to `/v1`. */
export function paperPath(address: PaperAddress): string {
  const id = encodeURIComponent(address.id);
  return address.version === null
    ? `/papers/${id}`
    : `/papers/${id}/v${address.version}`;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function parseAuthor(value: unknown): PaperAuthor | null {
  // The catalog sends author objects; a bare DID string is still an author and
  // is accepted so a newer or older node cannot silently drop a byline.
  if (typeof value === "string") {
    const did = readText(value);
    return did === null
      ? null
      : {
          did,
          position: 0,
          creditRoles: [],
          name: null,
          affiliation: null,
          orcid: null,
        };
  }
  if (!isRecord(value)) {
    return null;
  }
  const did = readText(value.did) ?? readText(value.author) ?? "";
  if (did === "") {
    return null;
  }
  return {
    did,
    position: readInteger(value.position) ?? 0,
    creditRoles: readList(value.creditRoles ?? value.credit_roles),
    name: null,
    affiliation: null,
    orcid: null,
  };
}

function parseNotice(value: unknown): PaperNotice | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = readText(value.kind);
  if (kind === null) {
    return null;
  }
  return {
    id: readText(value.id) ?? readText(value.cid) ?? "",
    kind,
    reason: readText(value.reason) ?? "",
    createdAt: readText(value.createdAt ?? value.created_at),
    clause: readText(value.clause),
    category: readText(value.category),
    removedOn: readText(value.removedOn ?? value.removed_on ?? value.removedAt ?? value.removed_at),
  };
}

/** Validate a `GET /v1/papers/{id}` body. */
export function parsePaper(payload: unknown): PaperView {
  if (!isRecord(payload)) {
    throw new PaperResponseError("The API did not return a paper.");
  }
  const title = readText(payload.title);
  if (title === null) {
    throw new PaperResponseError("The API did not return a paper.");
  }
  const authors = Array.isArray(payload.authors)
    ? payload.authors
        .map(parseAuthor)
        .filter((author): author is PaperAuthor => author !== null)
    : [];
  const notices = Array.isArray(payload.notices)
    ? payload.notices
        .map(parseNotice)
        .filter((notice): notice is PaperNotice => notice !== null)
    : [];
  return {
    shortId:
      readText(payload.shortId) ??
      readText(payload.short_id) ??
      readText(payload.paper) ??
      "",
    paperCid: readText(payload.paperCid) ?? readText(payload.paper_cid) ?? "",
    versionCid:
      readText(payload.versionCid) ??
      readText(payload.version_cid) ??
      readText(payload.cid) ??
      "",
    n: readInteger(payload.n) ?? readInteger(payload.version) ?? 1,
    title,
    abstract: typeof payload.abstract === "string" ? payload.abstract : "",
    authors,
    categories: readList(payload.categories),
    licence: readText(payload.licence) ?? readText(payload.license) ?? "",
    status: readText(payload.status) ?? "preprint",
    notices,
  };
}

/**
 * Validate a `GET /v1/profiles/{did}` body.
 *
 * `did` is the identifier that was asked for; the body repeats it but a
 * missing copy is not a reason to lose the name. `erased: true` means the
 * person asked for erasure, so every personal member is treated as absent
 * even if a stale value is present.
 */
export function parseProfile(
  payload: unknown,
  did: string = "",
): AuthorProfile | null {
  if (!isRecord(payload)) {
    return null;
  }
  const erased = payload.erased === true;
  const person = erased
    ? { name: null, affiliation: null, orcid: null }
    : {
        name:
          readText(payload.name) ??
          readText(payload.displayName) ??
          readText(payload.display_name),
        affiliation: readText(payload.affiliation),
        orcid: readText(payload.orcid) ?? readText(payload.orcid_id),
      };
  return {
    did: readText(payload.did) ?? did,
    ...person,
  };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** Read one paper (or one version of it) through the shared API client. */
export async function loadPaper(
  address: PaperAddress,
  client: PaperClient = api,
): Promise<PaperView> {
  const payload = await client.get<unknown>(paperPath(address), {
    cache: "no-store",
  });
  return parsePaper(payload);
}

/**
 * Read one author's public profile.
 *
 * The profile is a public read and always optional to the page: the caller
 * decides what a failure means (the page keeps the DID).
 */
export async function loadProfile(
  did: string,
  client: PaperClient = api,
): Promise<AuthorProfile> {
  const payload = await client.get<unknown>(
    `/profiles/${encodeURIComponent(did)}`,
    { cache: "no-store" },
  );
  return (
    parseProfile(payload, did) ?? {
      did,
      name: null,
      affiliation: null,
      orcid: null,
    }
  );
}

/**
 * Read a paper and the profile behind each author.
 *
 * Profile reads happen together and a failure never sinks the page: an author
 * whose profile cannot be read keeps their DID, so the Authors section still
 * lists every signer in byline order.
 */
export async function loadPaperPage(
  address: PaperAddress,
  client: PaperClient = api,
): Promise<PaperView> {
  const paper = await loadPaper(address, client);
  if (paper.authors.length === 0) {
    return paper;
  }
  const profiles = await Promise.all(
    paper.authors.map((author) =>
      author.did === ""
        ? Promise.resolve<AuthorProfile | null>(null)
        : loadProfile(author.did, client).catch(() => null),
    ),
  );
  return {
    ...paper,
    authors: paper.authors.map((author, index) => {
      const profile = profiles[index];
      return {
        ...author,
        name: profile?.name ?? null,
        affiliation: profile?.affiliation ?? null,
        orcid: profile?.orcid ?? null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/** One plain sentence for a paper page that could not load. */
export function describePaperError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "No paper with that id is listed on this node.";
    }
    if (error.status === 422) {
      return "That is not a valid paper address.";
    }
    return (
      error.detail ||
      error.title ||
      "The API could not load the paper. Try again."
    );
  }
  if (error instanceof NetworkError) {
    return "Couldn’t reach the API. Check your connection and try again.";
  }
  if (error instanceof PaperResponseError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "The paper could not be loaded. Try again.";
}
