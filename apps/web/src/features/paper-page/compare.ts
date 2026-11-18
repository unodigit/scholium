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

A new version can change more than its paragraphs: the author may replace the
PDF, add a source bundle, drop a dataset, or retitle the paper. The node's diff
is paragraph-only, so `loadCompare` also reads both versions' file manifests
(`GET /v1/papers/{id}/v/{n}/manifest`) and their title and abstract
(`GET /v1/papers/{id}/v{n}`) and works out the rest here:

- **files** — added, removed or *replaced* (same path, different bytes), each
  with its size;
- **details** — the title, abstract and change note as word-level text diffs.

A read that fails is "we don't know" (`files: null`, `detailsRead: false`),
never "nothing changed": the view says what it could not compare.
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
import { formatBytes } from "../ui-kit/format-bytes";
import { manifestEndpoint, parseManifest } from "../paper-meta/meta";

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

/** One file of one version, as its signed manifest lists it. */
export interface CompareFile {
  /** Path inside the version's bundle. */
  readonly path: string;
  /** The file id: its bytes differ exactly when this does. */
  readonly cid: string;
  /** Exact length in bytes. */
  readonly size: number;
  /** What the file is for: `manuscript`, `source`, `code`… */
  readonly role: string;
  readonly mediaType: string | null;
}

export type FileChangeKind = "added" | "removed" | "replaced";

/** One file the two versions do not share. */
export interface FileChange {
  readonly kind: FileChangeKind;
  readonly path: string;
  /** The file in the older version; `null` when it was added. */
  readonly from: CompareFile | null;
  /** The file in the newer version; `null` when it was removed. */
  readonly to: CompareFile | null;
}

export type TextSegmentKind = "same" | "added" | "removed";

/** A run of words in a text diff. Joining every segment but the added ones gives the old text. */
export interface TextSegment {
  readonly kind: TextSegmentKind;
  readonly text: string;
}

export type DetailField = "title" | "abstract" | "changeNote";

/** One signed field whose text differs between the two versions. */
export interface TextChange {
  readonly field: DetailField;
  /** The field in the reader's words: `Title`, `Abstract`, `Change note`. */
  readonly label: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly segments: readonly TextSegment[];
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
  /**
   * The files that were added, removed or replaced; empty when the two file
   * lists match, `null` when either could not be read.
   */
  readonly files: readonly FileChange[] | null;
  /** The title, abstract and change note fields whose text differs. */
  readonly details: readonly TextChange[];
  /** True when both versions' title and abstract were read, so `details` is complete. */
  readonly detailsRead: boolean;
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
    // The paragraph diff knows nothing of files or the title; `loadCompare`
    // reads those and fills them in.
    files: null,
    details: [],
    detailsRead: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The files two versions do not share, matched by path.
 *
 * Same path and same bytes is no change. Same path and different bytes is a
 * *replacement* — the author uploaded a new PDF under the old name. A path only
 * the newer version has is *added*; one only the older version has is
 * *removed*. A renamed file therefore reads as one removal and one addition,
 * which is what the signed manifests say. Added and replaced files come in the
 * newer version's order, then the removed ones in the older's.
 */
export function diffFiles(
  from: readonly CompareFile[],
  to: readonly CompareFile[],
): FileChange[] {
  const before = new Map(from.map((item) => [item.path, item]));
  const after = new Set(to.map((item) => item.path));
  const changes: FileChange[] = [];
  for (const item of to) {
    const old = before.get(item.path);
    if (old === undefined) {
      changes.push({ kind: "added", path: item.path, from: null, to: item });
    } else if (old.cid !== item.cid) {
      changes.push({ kind: "replaced", path: item.path, from: old, to: item });
    }
  }
  for (const item of from) {
    if (!after.has(item.path)) {
      changes.push({ kind: "removed", path: item.path, from: item, to: null });
    }
  }
  return changes;
}

/** `Added paper.pdf (2.0 KB)`, `Replaced paper.pdf (2.0 KB → 3.0 KB)`: the change in words, size included. */
export function describeFileChange(change: FileChange): string {
  const size = (item: CompareFile | null): string => (item === null ? "" : formatBytes(item.size));
  switch (change.kind) {
    case "added":
      return `Added ${change.path} (${size(change.to)})`;
    case "removed":
      return `Removed ${change.path} (${size(change.from)})`;
    case "replaced":
      return `Replaced ${change.path} (${size(change.from)} → ${size(change.to)})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** Most words per side the word diff is worked out for; longer text is shown as replaced whole. */
const DIFF_WORD_LIMIT = 1500;

/**
 * Words and punctuation marks, each with the whitespace that follows it, so
 * joining the tokens restores the text exactly. Punctuation is its own token:
 * `version.` becoming `version with the appendix.` adds words, it does not
 * replace `version.`.
 */
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_'’-]+\s*|[^\p{L}\p{N}_\s]\s*|\s+/gu) ?? [];
}

/**
 * A word-level diff of two texts.
 *
 * Joining the segments that are not `added` gives `from` back and joining the
 * ones that are not `removed` gives `to`, whitespace included, so a reader sees
 * exactly what the author typed — including punctuation staying attached to the
 * word it follows. Adjacent words that went (or came) together are one segment:
 * `and preference`, not `and`, `preference`.
 */
export function diffText(from: string, to: string): TextSegment[] {
  if (from === to) {
    return from === "" ? [] : [{ kind: "same", text: from }];
  }
  const a = tokens(from);
  const b = tokens(to);
  if (a.length > DIFF_WORD_LIMIT || b.length > DIFF_WORD_LIMIT) {
    return [
      ...(from === "" ? [] : [{ kind: "removed" as const, text: from }]),
      ...(to === "" ? [] : [{ kind: "added" as const, text: to }]),
    ];
  }

  // Longest common subsequence over the words (compared without their trailing
  // space, so a word at the end of the text still matches one mid-sentence).
  const key = (token: string): string => token.trimEnd();
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        key(a[i]) === key(b[j])
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const segments: TextSegment[] = [];
  const push = (kind: TextSegmentKind, text: string): void => {
    if (text === "") return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind) {
      segments[segments.length - 1] = { kind, text: last.text + text };
    } else {
      segments.push({ kind, text });
    }
  };
  // A matched word's trailing whitespace belongs to its own side: `types.` in
  // the old version and `types of nursing work.` in the new one share the word
  // `types`, not the space after it. Taking the newer spelling for both sides
  // left the old text reading "types ." (a space before the period).
  const body = (token: string): string => token.trimEnd();
  const tail = (token: string): string => token.slice(body(token).length);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      const gone = tail(a[i]);
      const came = tail(b[j]);
      if (gone === came) {
        // The same word with the same spacing on both sides: shared text.
        push("same", body(a[i]) + gone);
      } else {
        // The word is shared, its spacing is not: each side keeps its own.
        push("same", body(b[j]));
        push("removed", gone);
        push("added", came);
      }
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    push("removed", a[i]);
    i += 1;
  }
  while (j < b.length) {
    push("added", b[j]);
    j += 1;
  }
  return segments;
}

const DETAIL_LABELS: Record<DetailField, string> = {
  title: "Title",
  abstract: "Abstract",
  changeNote: "Change note",
};

function textChange(
  field: DetailField,
  from: string | null,
  to: string | null,
): TextChange | null {
  if ((from ?? "") === (to ?? "")) {
    return null;
  }
  return {
    field,
    label: DETAIL_LABELS[field],
    from,
    to,
    segments: diffText(from ?? "", to ?? ""),
  };
}

/** The signed text fields whose words differ: title, abstract, then the change note. */
function diffDetails(
  text: { readonly from: VersionText; readonly to: VersionText } | null,
  fromNote: string | null,
  toNote: string | null,
): TextChange[] {
  const changes = [
    text === null ? null : textChange("title", text.from.title, text.to.title),
    text === null ? null : textChange("abstract", text.from.abstract, text.to.abstract),
    textChange("changeNote", fromNote, toNote),
  ];
  return changes.filter((change): change is TextChange => change !== null);
}

/** Files, in the order a version lists them; `null` when the manifest could not be read. */
async function readFiles(
  shortId: string,
  version: number,
  client: CompareClient,
): Promise<readonly CompareFile[] | null> {
  try {
    const payload = await client.get<unknown>(manifestEndpoint(shortId, version), {
      auth: false,
      cache: "no-store",
    });
    return parseManifest(payload).files.map((item) => ({
      path: item.path,
      cid: item.cid,
      size: item.size,
      role: item.role,
      mediaType: item.mediaType,
    }));
  } catch {
    return null;
  }
}

interface VersionText {
  readonly title: string;
  readonly abstract: string;
}

/** A version's title and abstract; `null` when it could not be read. */
async function readVersionText(
  shortId: string,
  version: number,
  client: CompareClient,
): Promise<VersionText | null> {
  try {
    const payload = await client.get<unknown>(
      `/papers/${encodeURIComponent(shortId.trim())}/v${version}`,
      { auth: false, cache: "no-store" },
    );
    if (!isRecord(payload) || typeof payload.title !== "string") {
      return null;
    }
    return {
      title: payload.title.trim(),
      abstract: typeof payload.abstract === "string" ? payload.abstract.trim() : "",
    };
  } catch {
    return null;
  }
}

/** Read a comparison through the shared API client. Public read. */
export async function loadCompare(
  shortId: string,
  from: number,
  to: number,
  client: CompareClient = api,
): Promise<CompareData> {
  // The diff decides whether there is a page; the file lists and the title are
  // read beside it and a failure there only leaves that part "not compared".
  const [payload, fromFiles, toFiles, fromText, toText] = await Promise.all([
    client.get<unknown>(comparePath(shortId), {
      query: { from, to },
      auth: false,
      cache: "no-store",
    }),
    readFiles(shortId, from, client),
    readFiles(shortId, to, client),
    readVersionText(shortId, from, client),
    readVersionText(shortId, to, client),
  ]);
  const paragraphs = parseCompare(payload, { from, to });
  const detailsRead = fromText !== null && toText !== null;
  return {
    ...paragraphs,
    files: fromFiles !== null && toFiles !== null ? diffFiles(fromFiles, toFiles) : null,
    details: diffDetails(
      detailsRead
        ? { from: fromText, to: toText }
        : null,
      paragraphs.fromChangeNote,
      paragraphs.toChangeNote,
    ),
    detailsRead,
  };
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

/** `1 file replaced`, `2 files added`. */
function fileCount(count: number, verb: string): string {
  return `${count} ${count === 1 ? "file" : "files"} ${verb}`;
}

/** Join words with a final "and": `a`, `a and b`, `a, b and c`. */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** `title`, `title and abstract`, `title, abstract and change note`, each with "changed". */
function detailsPhrase(details: readonly TextChange[]): string {
  const names = details.map((change) => change.label.toLowerCase());
  return `${joinWords(names)} changed`;
}

/**
 * The one-line summary above the diff:
 * "1 paragraph changed and 1 file replaced between v1 and v2." A comparison
 * with no differences says so plainly rather than showing an empty page.
 *
 * Only the *paragraphs* are said to match when nothing else differs — a
 * comparison whose files or details could not be read does not claim more.
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
  for (const kind of ["replaced", "added", "removed"] as const) {
    const count = (data.files ?? []).filter((change) => change.kind === kind).length;
    if (count > 0) {
      parts.push(fileCount(count, kind));
    }
  }
  // The change note is shown under its own heading; the summary names the
  // signed fields a reader would otherwise miss.
  const fields = data.details.filter((change) => change.field !== "changeNote");
  if (fields.length > 0) {
    parts.push(detailsPhrase(fields));
  }
  if (parts.length === 0) {
    return "These two versions have the same paragraphs.";
  }
  return `${joinWords(parts)} between v${data.from} and v${data.to}.`;
}

/** True when nothing differs in anything this page compares — and all of it was read. */
export function isUnchanged(data: CompareData): boolean {
  return (
    data.added.length === 0 &&
    data.removed.length === 0 &&
    data.changed.length === 0 &&
    data.files !== null &&
    data.files.length === 0 &&
    data.detailsRead &&
    data.details.every((change) => change.field === "changeNote")
  );
}
