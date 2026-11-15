/**
 * The citation of one version, as the Cite dialog shows and copies it.
 *
 * `GET /v1/papers/{id}/cite?format=bibtex|ris` (plugin: export, feature 90)
 * answers with plain text, not JSON: a BibTeX entry or an RIS record that names
 * the `sch:` *version* id and carries a retraction note when the paper is
 * retracted. The path takes a version id (`sch:xxxx-xxxx-xxxx/v2`) unescaped, so
 * asking for `/v{n}` cites exactly the version on screen, which is what a reader
 * who copies it will be held to.
 *
 * What a citation says is the node's to decide, so this module never edits the
 * text it gets: what is shown is what is copied. A body that is not text at all
 * (or is empty) is an error ("we don't know what the citation is"), never a
 * blank box with a Copy button on it.
 *
 * Pure data and functions (plus the injectable loader), no React.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** One format the node can cite in, in the order the dialog lists them. */
export interface CiteFormat {
  /** The `format` query value the node understands. */
  readonly id: "bibtex" | "ris";
  /** The name a reader knows it by. */
  readonly label: string;
  /** File extension, for the node's own download name. */
  readonly extension: string;
}

/** The two formats `GET /v1/papers/{id}/cite` serves (BibTeX is the node's default). */
export const CITE_FORMATS: readonly CiteFormat[] = [
  { id: "bibtex", label: "BibTeX", extension: "bib" },
  { id: "ris", label: "RIS", extension: "ris" },
];

export type CiteFormatId = CiteFormat["id"];

/** The node answered, but not with a citation the dialog can show. */
export class CitationResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CitationResponseError";
  }
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type CiteClient = Pick<ApiClient, "get">;

/** Fetch one citation: the signature the dialog's `load` prop has. */
export type LoadCitation = (
  shortId: string,
  version: number,
  format: CiteFormatId,
) => Promise<string>;

/** The format named `id`. */
export function citeFormat(id: CiteFormatId): CiteFormat {
  const found = CITE_FORMATS.find((format) => format.id === id);
  if (found === undefined) {
    throw new RangeError(`Unknown citation format: ${id}`);
  }
  return found;
}

/**
 * The cite route's path under `/v1` (the API client adds the prefix):
 * `/papers/sch%3Axxxx-xxxx-xxxx/v2/cite`. The format goes in the query.
 */
export function citePath(shortId: string, version: number): string {
  return `/papers/${encodeURIComponent(shortId.trim())}/v${version}/cite`;
}

/** Validate a `GET /v1/papers/{id}/cite` body: it must be text with something in it. */
export function parseCitation(payload: unknown): string {
  if (typeof payload !== "string" || payload.trim() === "") {
    throw new CitationResponseError("The server did not return a citation.");
  }
  return payload;
}

/**
 * Read one version's citation through the shared API client. Public read: citing
 * needs no sign-in, and the answer is never cached, because a paper can be
 * retracted after a reader last looked and the citation then says so.
 */
export async function loadCitation(
  shortId: string,
  version: number,
  format: CiteFormatId,
  client: CiteClient = api,
): Promise<string> {
  const payload = await client.get<unknown>(citePath(shortId, version), {
    auth: false,
    cache: "no-store",
    // Forced: the `auto` mode would try to read an entry as JSON.
    parse: "text",
    query: { format },
  });
  return parseCitation(payload);
}

/** One plain sentence for why a citation could not be shown. */
export function describeCiteError(error: unknown, label: string): string {
  if (error instanceof CitationResponseError) {
    return error.message;
  }
  if (error instanceof NetworkError) {
    return `Couldn’t reach the server to load the ${label}. Check your connection and try again.`;
  }
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      return "This server has no citation for that version.";
    }
    return error.detail || error.title || `The ${label} could not be loaded. Try again.`;
  }
  return `The ${label} could not be loaded. Try again.`;
}
