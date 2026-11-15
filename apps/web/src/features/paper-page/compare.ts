/**
 * The paragraph diff between two versions of a paper, for the compare view
 * (`GET /v1/papers/{id}/compare?from=1&to=2`, plugin: reading, feature 183).
 *
 * The node does the diff, so the page never decides what "changed" means: it
 * reads three lists, each paragraph carrying the stable `paragraph_id` an
 * annotation anchors to, its 0-based `position` and its `text`.
 *
 * - **added** — in the newer version, not the older one;
 * - **removed** — in the older version, not the newer one;
 * - **changed** — paired old and new paragraphs (the node pairs a replaced
 *   block row by row);
 *
 * plus both versions' change notes, the sentence each author signed.
 *
 * Like the other data modules, a body that is not a paragraph diff at all is an
 * error ("we don't know"), never "nothing changed"; a single unreadable row or
 * pair is dropped so one bad entry cannot take the page down. The node's
 * camelCase and snake_case spellings are both accepted, and the lists may sit
 * at the top level or in its `diff` / `comparison` / `paragraphDiff` object.
 *
 * Pure data and functions (plus the injectable loader), no React.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";

/** One paragraph of one version, as the diff lists it. */
export interface CompareParagraph {
  /** The stable paragraph id (the id an annotation anchors to). */
  readonly id: string;
  /** 0-based reading position in its own version. */
  readonly position: number;
  readonly text: string;
}

/** One replaced paragraph: the old text and the new text the node paired it with. */
export interface CompareChange {
  readonly from: CompareParagraph;
  readonly to: CompareParagraph;
}

/** Everything the compare view shows. Plain JSON-able data. */
export interface CompareData {
  /** Canonical paper id (`sch:xxxx-xxxx-xxxx`), when the node says it. */
  readonly paper: string | null;
  /** The older version number (the `from` of the comparison). */
  readonly from: number;
  /** The newer version number (the `to` of the comparison). */
  readonly to: number;
  /** The change note signed into the `from` version, or `null`. */
  readonly fromChangeNote: string | null;
  /** The change note signed into the `to` version, or `null`. */
  readonly toChangeNote: string | null;
  /** Paragraphs only the `to` version has, in reading order. */
  readonly added: readonly CompareParagraph[];
  /** Paragraphs only the `from` version has, in reading order. */
  readonly removed: readonly CompareParagraph[];
  /** Replaced paragraphs, old paired with new, in diff order. */
  readonly changed: readonly CompareChange[];
}

/** The node answered, but not with a paragraph diff the view can show. */
export class CompareResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareResponseError";
  }
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type CompareClient = Pick<ApiClient, "get">;

/** The comparison's path under `/v1`; the API client adds the prefix. */
export function comparePath(shortId: string): string {
  return `/papers/${encodeURIComponent(shortId.trim())}/compare`;
}

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

function readWholeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

/** A 0-based position: unlike a version number, `0` is the first paragraph. */
function readOffset(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** The first list among `names`, at the top level or inside the nested diff. */
function readList(
  root: Record<string, unknown>,
  names: readonly string[],
): unknown[] | null {
  for (const name of names) {
    const value = root[name];
    if (Array.isArray(value)) {
      return value;
    }
  }
  for (const nestedName of ["diff", "comparison", "paragraphDiff", "paragraph_diff"]) {
    const nested = root[nestedName];
    if (!isRecord(nested)) {
      continue;
    }
    for (const name of names) {
      const value = nested[name];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return null;
}

/** The first non-empty string among `names`, at the top level. */
function readNote(
  root: Record<string, unknown>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = readText(root[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** One wire row as a paragraph, or `null` when it has no id or no text. */
function parseParagraph(item: unknown, order: number): CompareParagraph | null {
  if (!isRecord(item)) {
    return null;
  }
  const id =
    readText(item.paragraph_id) ?? readText(item.paragraphId) ?? readText(item.id);
  const text = readText(item.text);
  if (id === null || text === null) {
    return null;
  }
  const position = readOffset(item.position);
  return {
    id,
    position: position === null ? order : position,
    text,
  };
}

/** The first of `names` that parses as a paragraph (the node offers aliases). */
function firstParagraph(
  item: Record<string, unknown>,
  names: readonly string[],
  order: number,
): CompareParagraph | null {
  for (const name of names) {
    const paragraph = parseParagraph(item[name], order);
    if (paragraph !== null) {
      return paragraph;
    }
  }
  return null;
}

/** One changed entry, old side and new side, or `null` if either is unreadable. */
function parseChange(item: unknown, order: number): CompareChange | null {
  if (!isRecord(item)) {
    return null;
  }
  const from = firstParagraph(
    item,
    ["from", "old", "before", "fromParagraph", "oldParagraph", "from_paragraph", "old_paragraph"],
    order,
  );
  const to = firstParagraph(
    item,
    ["to", "new", "after", "toParagraph", "newParagraph", "to_paragraph", "new_paragraph"],
    order,
  );
  return from === null || to === null ? null : { from, to };
}

/**
 * Validate a `GET /v1/papers/{id}/compare` body.
 *
 * `expected` supplies the version numbers from the address when the body does
 * not repeat them, so the page always names the versions the URL named.
 */
export function parseCompare(
  payload: unknown,
  expected: { readonly from: number; readonly to: number },
): CompareData {
  if (!isRecord(payload)) {
    throw new CompareResponseError("The server did not return a paragraph diff.");
  }

  const added = readList(payload, ["addedParagraphs", "added_paragraphs", "added"]);
  const removed = readList(payload, [
    "removedParagraphs",
    "removed_paragraphs",
    "removed",
  ]);
  const changed = readList(payload, [
    "changedParagraphs",
    "changed_paragraphs",
    "changed",
  ]);
  if (added === null && removed === null && changed === null) {
    throw new CompareResponseError("The server did not return a paragraph diff.");
  }

  const versions = Array.isArray(payload.versions) ? payload.versions : [];
  const fromVersion = isRecord(versions[0]) ? versions[0] : {};
  const toVersion = isRecord(versions[1]) ? versions[1] : {};

  const from =
    readWholeNumber(payload.from) ??
    readWholeNumber(payload.fromVersion) ??
    readWholeNumber(payload.from_version) ??
    readWholeNumber(payload.fromVersionNumber) ??
    readWholeNumber(payload.fromN) ??
    expected.from;
  const to =
    readWholeNumber(payload.to) ??
    readWholeNumber(payload.toVersion) ??
    readWholeNumber(payload.to_version) ??
    readWholeNumber(payload.toVersionNumber) ??
    readWholeNumber(payload.toN) ??
    expected.to;

  return {
    paper:
      readText(payload.paper) ??
      readText(payload.shortId) ??
      readText(payload.short_id) ??
      readText(payload.paperId) ??
      null,
    from,
    to,
    fromChangeNote:
      readNote(payload, [
        "fromChangeNote",
        "from_change_note",
        "changeNoteFrom",
        "change_note_from",
      ]) ?? readNote(fromVersion, ["changeNote", "change_note"]),
    toChangeNote:
      readNote(payload, [
        "toChangeNote",
        "to_change_note",
        "changeNoteTo",
        "change_note_to",
      ]) ?? readNote(toVersion, ["changeNote", "change_note"]),
    added: (added ?? [])
      .map((item, order) => parseParagraph(item, order))
      .filter((item): item is CompareParagraph => item !== null),
    removed: (removed ?? [])
      .map((item, order) => parseParagraph(item, order))
      .filter((item): item is CompareParagraph => item !== null),
    changed: (changed ?? [])
      .map((item, order) => parseChange(item, order))
      .filter((item): item is CompareChange => item !== null),
  };
}

/** Read a comparison through the shared API client. Public read. */
export async function loadCompare(
  shortId: string,
  from: number,
  to: number,
  client: CompareClient = api,
): Promise<CompareData> {
  const payload = await client.get<unknown>(comparePath(shortId), {
    query: { from, to },
    auth: false,
    cache: "no-store",
  });
  return parseCompare(payload, { from, to });
}

/** One plain sentence for why the comparison could not be shown. */
export function describeCompareError(error: unknown): string {
  if (error instanceof CompareResponseError) {
    return error.message;
  }
  if (error instanceof NetworkError) {
    return "Couldn’t reach the server to compare these versions. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      return "This server does not hold both versions of that paper.";
    }
    if (error.status === 422) {
      return "That is not a valid comparison of two versions.";
    }
    return error.detail || error.title || "The comparison could not be loaded. Try again.";
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "The comparison could not be loaded. Try again.";
}

/** `1 paragraph`, `2 paragraphs`. */
function paragraphCount(count: number, verb: string): string {
  return `${count} ${count === 1 ? "paragraph" : "paragraphs"} ${verb}`;
}

/** Join words with a final "and": `a`, `a and b`, `a, b and c`. */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one-line summary above the diff:
 * "1 paragraph changed and 1 paragraph added between v1 and v2." A comparison
 * with no differences says so plainly rather than showing an empty page.
 */
export function describeCompareSummary(data: CompareData): string {
  const parts: string[] = [];
  if (data.changed.length > 0) {
    parts.push(paragraphCount(data.changed.length, "changed"));
  }
  if (data.added.length > 0) {
    parts.push(paragraphCount(data.added.length, "added"));
  }
  if (data.removed.length > 0) {
    parts.push(paragraphCount(data.removed.length, "removed"));
  }
  if (parts.length === 0) {
    return "These two versions have the same paragraphs.";
  }
  return `${joinWords(parts)} between v${data.from} and v${data.to}.`;
}
