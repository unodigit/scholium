/**
 * The text of one version, as the reading column shows it.
 *
 * `GET /v1/papers/{id}/v/{n}/text` (plugin: reading, feature 182) answers with
 * the version's paragraphs in reading order, each with a stable
 * `paragraph_id` (the id an annotation is anchored to), a 0-based `position`
 * and its `text`. The column renders them as paragraphs with the margin
 * markers of feature 150.
 *
 * Like the other data modules, a body that is not a paragraph list at all is an
 * error ("we don't know what the text is"), never an empty paper; a single
 * unreadable paragraph is dropped so it cannot take the page down.
 *
 * Pure data and functions (plus the injectable loader), no React.
 */

import {
  ApiError,
  NetworkError,
  api,
  authorizationHeader,
  resolveApiBaseUrl,
  tokenStore,
  type ApiClient,
} from "../../lib/api";
import { loadPdfjs, type LoadPdfjs } from "./pdf-render";

/** One paragraph of a version's text. */
export interface ReadingParagraph {
  /** The id an annotation anchors to. */
  readonly id: string;
  readonly text: string;
}

/** The paragraphs of one version, in reading order. */
export interface ReadingText {
  /** Id of the `paper.version` record the text belongs to, when the node says. */
  readonly versionCid: string | null;
  readonly paragraphs: readonly ReadingParagraph[];
}

/** The node answered, but not with text the page can show. */
export class ReadingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadingResponseError";
  }
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type ReadingClient = Pick<ApiClient, "get">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text === "" ? null : text;
}

/** The text's path under `/v1`; the API client adds the prefix. */
export function readingPath(shortId: string, version: number): string {
  return `/papers/${encodeURIComponent(shortId.trim())}/v/${version}/text`;
}

/**
 * Validate a `GET /v1/papers/{id}/v/{n}/text` body.
 *
 * Paragraphs are ordered by `position` (ties keep the order received), and a
 * paragraph with no id or no text is skipped: an id-less paragraph cannot be
 * annotated, and an empty one has nothing to read.
 */
export function parseReadingText(payload: unknown): ReadingText {
  if (!isRecord(payload) || !Array.isArray(payload.paragraphs)) {
    throw new ReadingResponseError("The server did not return the paper's text.");
  }
  const rows: Array<{ paragraph: ReadingParagraph; position: number; order: number }> = [];
  payload.paragraphs.forEach((item, order) => {
    if (!isRecord(item)) {
      return;
    }
    const id = readText(item.paragraph_id) ?? readText(item.paragraphId) ?? readText(item.id);
    const text = readText(item.text);
    if (id === null || text === null) {
      return;
    }
    const position =
      typeof item.position === "number" && Number.isFinite(item.position)
        ? item.position
        : order;
    rows.push({ paragraph: { id, text }, position, order });
  });
  rows.sort((a, b) => a.position - b.position || a.order - b.order);
  return {
    versionCid: readText(payload.versionCid) ?? readText(payload.version_cid),
    paragraphs: rows.map((row) => row.paragraph),
  };
}

/**
 * Read one version's text through the shared API client.
 *
 * A listed version's text is public; an unlisted one (in moderation, held,
 * rejected…) is served only to its authors and to moderators, and everyone
 * else gets the unknown-version `404`. So the client's own auth applies: the
 * signed-in reader's bearer token is sent when there is one, and an anonymous
 * reader of a listed paper (or the server rendering the page, which holds no
 * token) sends none.
 */
export async function loadReadingText(
  shortId: string,
  version: number,
  client: ReadingClient = api,
): Promise<ReadingText> {
  const payload = await client.get<unknown>(readingPath(shortId, version), {
    cache: "no-store",
  });
  return parseReadingText(payload);
}

/** Whether `url` is served by this node's API, the only place the token may go. */
function isOnThisNode(url: string): boolean {
  try {
    const base = resolveApiBaseUrl();
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * PDF.js that opens this node's files with the signed-in reader's token.
 *
 * `GET /v1/content/{cid}` serves an unlisted version's bytes only to its
 * authors and to moderators, but PDF.js fetches the file itself and sends no
 * credentials of its own, so the viewer would draw nothing for them. Wrapping
 * the loader adds the bearer token as a request header
 * (`getDocument`'s `httpHeaders`) when there is one, and only for a file this
 * node's API serves: the token never leaves for another origin, and an
 * anonymous reader of a listed paper still sends nothing.
 */
export function withSessionToken(load: LoadPdfjs): LoadPdfjs {
  return async () => {
    const pdfjs = await load();
    return {
      getDocument(source) {
        const authorization = authorizationHeader(tokenStore.get());
        if (authorization === undefined || !isOnThisNode(source.url)) {
          return pdfjs.getDocument(source);
        }
        // A variable, not a literal: PDF.js takes `httpHeaders`, which the
        // viewer's own slice of its options does not list.
        const withHeaders = { ...source, httpHeaders: { Authorization: authorization } };
        return pdfjs.getDocument(withHeaders);
      },
    };
  };
}

/** {@link loadPdfjs} with the reader's token. One value, so the viewer is not restarted by a new function each render. */
export const loadPdfjsWithSession: LoadPdfjs = withSessionToken(loadPdfjs);

/** One plain sentence for why the text could not be shown. */
export function describeReadingError(error: unknown): string {
  if (error instanceof ReadingResponseError) {
    return error.message;
  }
  if (error instanceof NetworkError) {
    return "Couldn’t reach the server to load the text. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      return "This server has no readable text for that version.";
    }
    return error.detail || error.title || "The text could not be loaded. Try again.";
  }
  return "The text could not be loaded. Try again.";
}
